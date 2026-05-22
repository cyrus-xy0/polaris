import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import {
  generateAiResultOutput,
  generateDraftOutput,
  generateSuggestedActionPlan,
  generateTaskNodeSplit,
} from "../src/action-plan-ai.js";
import {
  createAiResultSignature,
  createAiContextDigest,
  createDraftOutputSignature,
  createSuggestedActionPlanSignature,
  hasAiResultOutputContent,
  hasDraftOutputContent,
  hasSuggestedActionPlanContent,
  readAiResult,
  writeAiResult,
  writeAiResultDocument,
} from "../src/ai-result-store.js";
import { buildActiveQueue, buildAiContextForNode, getRecordsForNode, resolvePreparedArtifact } from "../src/app-logic.js";
import { resolveDataRoot } from "../src/config.js";
import { createRepository } from "../src/data/repository.js";
import { publishAiResultToFeishu } from "../src/feishu-ai-result.js";
import { CREATED_FROM, TASK_STATES, createNode } from "../src/task-nodes.js";

const root = resolve(import.meta.dirname, "..");
const preferredPort = 4173;
const dataRoot = resolveDataRoot({
  argv: process.argv.slice(2),
  env: process.env,
  fallback: join(root, "data"),
});
const repository = createRepository({ dataRoot });

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const requested = pathname === "/" ? "/demo/index.html" : pathname;
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root)) {
    return null;
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return filePath;
  }

  return null;
}

function createDemoServer(port) {
  const server = createServer(async (request, response) => {
    if (await handleApiRequest(request, response)) return;

    const aiResultFilePath = resolveAiResultRequestPath(request.url);
    if (aiResultFilePath) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": mimeTypes[extname(aiResultFilePath)] ?? "application/octet-stream",
      });
      createReadStream(aiResultFilePath).pipe(response);
      return;
    }

    const filePath = resolveRequestPath(request.url);

    if (!filePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) {
      createDemoServer(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Polaris demo running at http://127.0.0.1:${port}`);
    console.log(`Data directory: ${dataRoot}`);
  });
}

createDemoServer(preferredPort);

function resolveAiResultRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  if (!pathname.startsWith("/ai-results/")) return null;

  const aiResultRoot = join(resolve(dataRoot), "ai-results");
  const requested = normalize(join(aiResultRoot, pathname.slice("/ai-results/".length)));
  if (requested !== aiResultRoot && !requested.startsWith(`${aiResultRoot}/`)) return null;
  if (existsSync(requested) && statSync(requested).isFile()) return requested;
  return null;
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, repository.getBootstrap());
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/project") {
      sendJson(response, 200, { project: repository.getProject() });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/task-nodes") {
      sendJson(response, 200, { nodes: repository.listTaskNodes() });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/task-nodes") {
      const body = await readJsonBody(request);
      sendJson(response, 200, { nodes: repository.saveTaskNodes(body.nodes) });
      return true;
    }

    const splitChildrenMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/split-children$/);
    if (request.method === "POST" && splitChildrenMatch) {
      const nodeId = decodeURIComponent(splitChildrenMatch[1]);
      const nodes = repository.listTaskNodes();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        sendJson(response, 404, { error: `Task node not found: ${nodeId}` });
        return true;
      }

      const existingChildren = nodes.filter((candidate) => candidate.parentId === nodeId);
      if (existingChildren.length > 0) {
        sendJson(response, 200, {
          nodes,
          children: existingChildren,
          status: "skipped",
          reason: "节点已经有子节点，跳过预拆分。",
        });
        return true;
      }

      const library = repository.getLibrary();
      const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason: "新建节点预拆分" });
      const split = await generateTaskNodeSplit({
        node,
        relatedRecords: getRecordsForNode(library, nodeId),
        aiContext,
        serviceRoot: root,
        dataRoot,
      });
      const splitNodes = split.nodes.length > 0 ? split.nodes : createFallbackTaskNodeSplit(node).nodes;
      const children = createSplitChildren({ parent: node, splitNodes, existingNodes: nodes });
      const savedNodes = repository.saveTaskNodes([...nodes, ...children]);

      sendJson(response, 200, {
        nodes: savedNodes,
        children,
        split,
        status: split.nodes.length > 0 ? "ready" : "fallback",
      });
      return true;
    }

    const suggestedActionPlanMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/suggested-action-plan$/);
    if (request.method === "POST" && suggestedActionPlanMatch) {
      const nodeId = decodeURIComponent(suggestedActionPlanMatch[1]);
      const nodes = repository.listTaskNodes();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        sendJson(response, 404, { error: `Task node not found: ${nodeId}` });
        return true;
      }

      const queue = buildActiveQueue(nodes);
      const queueItem = queue.available.find((item) => item.node.id === nodeId);
      const library = repository.getLibrary();
      const reason = queueItem?.reason ?? "";
      const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason });
      const contextDigest = createAiContextDigest(aiContext);
      const suggested = await readOrCreateSuggestedActionPlan({ nodeId, node, library, reason, aiContext, contextDigest });
      if (!suggested.plan) {
        const error = suggested.error || "AI 没有返回可用的 Suggest Action Plan。";
        sendJson(response, 200, { plan: { error }, status: "error", error });
        return true;
      }

      sendJson(response, 200, {
        plan: suggested.plan,
        persistedAt: suggested.persistedAt,
        source: "filesystem",
      });
      return true;
    }

    const draftOutputMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/draft-output$/);
    if (request.method === "POST" && draftOutputMatch) {
      const nodeId = decodeURIComponent(draftOutputMatch[1]);
      const nodes = repository.listTaskNodes();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        sendJson(response, 404, { error: `Task node not found: ${nodeId}` });
        return true;
      }

      const library = repository.getLibrary();
      const artifact = resolvePreparedArtifact(node, library.artifacts);
      const queue = buildActiveQueue(nodes);
      const queueItem = queue.available.find((item) => item.node.id === nodeId);
      const reason = queueItem?.reason ?? "";
      const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason });
      const contextDigest = createAiContextDigest(aiContext);
      const suggested = await readOrCreateSuggestedActionPlan({ nodeId, node, library, reason, aiContext, contextDigest });
      if (!suggested.plan) {
        const error = suggested.error || "AI 没有返回可用的 Suggest Action Plan。";
        sendJson(response, 200, { output: { error }, status: "error", error });
        return true;
      }
      const actionPlanDigest = createAiContextDigest(suggested.plan);
      const signature = createDraftOutputSignature({ node, artifact, contextDigest, actionPlanDigest });
      const saved = readAiResult({ dataRoot, kind: "draft-output", nodeId, signature });
      if (saved?.output && hasDraftOutputContent(saved.output)) {
        sendJson(response, 200, {
          output: saved.output,
          persistedAt: saved.updatedAt,
          source: "filesystem",
        });
        return true;
      }

      const output = await generateDraftOutput({
        node,
        artifact,
        relatedRecords: getRecordsForNode(library, nodeId),
        aiContext,
        actionPlan: suggested.plan,
        serviceRoot: root,
        dataRoot,
      });
      if (!hasDraftOutputContent(output)) {
        const error = output.error || "AI 没有返回可用的 Draft Output。";
        sendJson(response, 200, { output: { ...output, error }, status: "error", error });
        return true;
      }

      const persisted = writeAiResult({
        dataRoot,
        kind: "draft-output",
        nodeId,
        signature,
        payload: { output },
      });
      sendJson(response, 200, {
        output: persisted.output,
        persistedAt: persisted.updatedAt,
        source: "filesystem",
      });
      return true;
    }

    const aiResultMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/ai-result$/);
    if (request.method === "POST" && aiResultMatch) {
      const nodeId = decodeURIComponent(aiResultMatch[1]);
      const nodes = repository.listTaskNodes();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        sendJson(response, 404, { error: `Task node not found: ${nodeId}` });
        return true;
      }

      const library = repository.getLibrary();
      const artifact = resolvePreparedArtifact(node, library.artifacts);
      const queue = buildActiveQueue(nodes);
      const queueItem = queue.available.find((item) => item.node.id === nodeId);
      const reason = queueItem?.reason ?? "";
      const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason });
      const contextDigest = createAiContextDigest(aiContext);
      const suggested = await readOrCreateSuggestedActionPlan({ nodeId, node, library, reason, aiContext, contextDigest });
      if (!suggested.plan) {
        const error = suggested.error || "AI 没有返回可用的 Suggest Action Plan。";
        sendJson(response, 200, { result: { error }, status: "error", error });
        return true;
      }
      const actionPlanDigest = createAiContextDigest(suggested.plan);
      const signature = createAiResultSignature({ node, artifact, contextDigest, actionPlanDigest });
      const saved = readAiResult({ dataRoot, kind: "ai-result", nodeId, signature });
      if (saved?.result?.url) {
        sendJson(response, 200, {
          result: saved.result,
          persistedAt: saved.updatedAt,
          source: "filesystem",
        });
        return true;
      }

      const generatedResult = await readOrCreateAiResultOutput({
        nodeId,
        node,
        library,
        artifact,
        aiContext,
        contextDigest,
        actionPlan: suggested.plan,
        actionPlanDigest,
      });
      if (!generatedResult.output) {
        const error = generatedResult.error || "AI 没有返回可用的实际结果内容。";
        sendJson(response, 200, { result: { error }, status: "error", error });
        return true;
      }

      const result = await publishAiResult({
        node,
        output: generatedResult.output,
        artifact,
        actionPlan: suggested.plan,
        signature,
      });
      const persisted = writeAiResult({
        dataRoot,
        kind: "ai-result",
        nodeId,
        signature,
        payload: { result, output: generatedResult.output },
      });
      sendJson(response, 200, {
        result: persisted.result,
        persistedAt: persisted.updatedAt,
        source: "filesystem",
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/library") {
      sendJson(response, 200, { library: repository.getLibrary() });
      return true;
    }

    const markdownMatch = url.pathname.match(/^\/api\/library\/([^/]+)\/([^/]+)\/markdown$/);
    if (request.method === "PUT" && markdownMatch) {
      const [, kind, id] = markdownMatch.map(decodeURIComponent);
      const body = await readJsonBody(request);
      sendJson(response, 200, { item: repository.updateMarkdown(kind, id, body.markdown) });
      return true;
    }

    sendJson(response, 404, { error: "API route not found" });
    return true;
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error.message });
    return true;
  }
}

async function readOrCreateSuggestedActionPlan({ nodeId, node, library, reason, aiContext, contextDigest }) {
  const signature = createSuggestedActionPlanSignature({ node, reason, contextDigest });
  const saved = readAiResult({ dataRoot, kind: "suggested-action-plan", nodeId, signature });
  if (saved?.plan && hasSuggestedActionPlanContent(saved.plan)) {
    return {
      plan: saved.plan,
      persistedAt: saved.updatedAt,
    };
  }

  const plan = await generateSuggestedActionPlan({
    node,
    reason,
    relatedRecords: getRecordsForNode(library, nodeId),
    aiContext,
    serviceRoot: root,
    dataRoot,
  });
  if (!hasSuggestedActionPlanContent(plan)) {
    return { error: plan.error || "AI 没有返回可用的 Suggest Action Plan。" };
  }

  const persisted = writeAiResult({
    dataRoot,
    kind: "suggested-action-plan",
    nodeId,
    signature,
    payload: { plan },
  });
  return {
    plan: persisted.plan,
    persistedAt: persisted.updatedAt,
  };
}

function createFallbackTaskNodeSplit(node) {
  return {
    summary: "本地 AI 不可用，使用最小任务预拆分。",
    nodes: [
      {
        title: "明确输入和边界",
        description: `确认「${node.title}」需要依赖的输入、约束和完成边界。`,
        tag: "思考",
        aiActions: ["列出输入", "标记约束", "写完成标准"],
      },
      {
        title: "执行最小动作",
        description: `围绕「${node.title}」完成一个可检查的最小行动。`,
        tag: "执行",
        aiActions: ["选择最小路径", "完成核心动作", "记录过程"],
      },
      {
        title: "验证结果可用性",
        description: `检查「${node.title}」的结果是否能支撑下一步推进。`,
        tag: "验证",
        aiActions: ["检查结果", "发现缺口", "给出下一步"],
      },
    ],
  };
}

function createSplitChildren({ parent, splitNodes, existingNodes }) {
  const existingIds = new Set(existingNodes.map((node) => node.id));
  return splitNodes.map((splitNode, index) => {
    const titleSlug = safeNodeId(splitNode.title);
    const id = createUniqueNodeId(`${parent.id}-child-${index + 1}${titleSlug ? `-${titleSlug}` : ""}`, existingIds);
    existingIds.add(id);
    return createNode({
      id,
      parentId: parent.id,
      title: splitNode.title,
      tag: splitNode.tag,
      description: splitNode.description,
      aiActions: splitNode.aiActions,
      dependencies: [],
      state: TASK_STATES.TODO,
      createdFrom: CREATED_FROM.AI_SPLIT,
    });
  });
}

function createUniqueNodeId(baseId, existingIds) {
  const safeBase = safeNodeId(baseId) || "node";
  let candidate = safeBase;
  let index = 2;
  while (existingIds.has(candidate)) {
    candidate = `${safeBase}-${index}`;
    index += 1;
  }
  return candidate;
}

function safeNodeId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function publishAiResult({ node, output, artifact, actionPlan, signature }) {
  try {
    return await publishAiResultToFeishu({
      dataRoot,
      node,
      output,
      artifact,
      actionPlan,
    });
  } catch (error) {
    console.warn(`Feishu AI result publish failed, falling back to local HTML: ${error.message}`);
    return writeAiResultDocument({
      dataRoot,
      node,
      signature,
      output,
      artifact,
      actionPlan,
    });
  }
}

async function readOrCreateAiResultOutput({
  nodeId,
  node,
  library,
  artifact,
  aiContext,
  contextDigest,
  actionPlan,
  actionPlanDigest,
}) {
  const signature = createAiResultSignature({ node, artifact, contextDigest, actionPlanDigest });
  const saved = readAiResult({ dataRoot, kind: "ai-result-output", nodeId, signature });
  if (saved?.output && hasAiResultOutputContent(saved.output)) return { output: saved.output };

  const output = await generateAiResultOutput({
    node,
    artifact,
    relatedRecords: getRecordsForNode(library, nodeId),
    aiContext,
    actionPlan,
    serviceRoot: root,
    dataRoot,
  });
  if (!hasAiResultOutputContent(output)) {
    return { error: output.error || "AI 没有返回可用的实际结果内容。" };
  }

  const persisted = writeAiResult({
    dataRoot,
    kind: "ai-result-output",
    nodeId,
    signature,
    payload: { output },
  });
  return { output: persisted.output };
}

async function readOrCreateDraftOutput({
  nodeId,
  node,
  library,
  artifact,
  aiContext,
  contextDigest,
  actionPlan,
  actionPlanDigest,
}) {
  const signature = createDraftOutputSignature({ node, artifact, contextDigest, actionPlanDigest });
  const saved = readAiResult({ dataRoot, kind: "draft-output", nodeId, signature });
  if (saved?.output && hasDraftOutputContent(saved.output)) return { output: saved.output };

  const output = await generateDraftOutput({
    node,
    artifact,
    relatedRecords: getRecordsForNode(library, nodeId),
    aiContext,
    actionPlan,
    serviceRoot: root,
    dataRoot,
  });
  if (!hasDraftOutputContent(output)) {
    return { error: output.error || "AI 没有返回可用的 Draft Output。" };
  }

  const persisted = writeAiResult({
    dataRoot,
    kind: "draft-output",
    nodeId,
    signature,
    payload: { output },
  });
  return { output: persisted.output };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
  }

  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
