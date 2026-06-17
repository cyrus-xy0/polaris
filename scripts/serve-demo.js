import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  generateAiResultOutput,
  generateDraftOutput,
  generateSuggestedActionPlan,
  generateTaskNodeSplit,
  generateWorkspaceIntelligence,
} from "../src/action-plan-ai.js";
import {
  createFallbackAiResultOutput,
  createFallbackDraftOutput,
  createFallbackSuggestedActionPlan,
  createFallbackTaskNodeSplit,
  createFallbackWorkspaceIntelligence,
} from "../src/ai-fallbacks.js";
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
import {
  applyWorkspaceIntelligenceToNode,
  buildActiveQueue,
  buildAiContextForNode,
  getContextCandidateRecords,
  getRecordsForNode,
  resolvePreparedArtifact,
} from "../src/app-logic.js";
import { getDefaultDataRoot, hasDataRootOverride, resolveDataRoot, shouldSeedDemoData } from "../src/config.js";
import { createRepository } from "../src/data/repository.js";
import { publishAiResultToFeishu } from "../src/feishu-ai-result.js";
import { CREATED_FROM, TASK_STATES, createNode } from "../src/task-nodes.js";

const root = resolve(import.meta.dirname, "..");
const preferredPort = 4173;
const packageMetadata = readPackageMetadata();
const bundledDataRoot = join(root, "data");
const dataRoot = resolveDataRoot({
  argv: process.argv.slice(2),
  env: process.env,
  fallback: getDefaultDataRoot({ env: process.env }),
});
const seedDemoData = shouldSeedDemoData({ argv: process.argv.slice(2), env: process.env });
if (!hasDataRootOverride({ argv: process.argv.slice(2), env: process.env })) {
  migrateLegacyDefaultData({ from: bundledDataRoot, to: dataRoot });
}
const repository = createRepository({ dataRoot, seedDataRoot: bundledDataRoot, seedTaskNodes: seedDemoData });
const storage = repository.getStorage();
let projectConfig = repository.getProject();
const aiResultsRoot = storage.aiResultsRoot;
const inFlightAiJobs = new Map();
let aiGenerationTimeoutMs = readPositiveIntegerEnv("POLARIS_AI_TIMEOUT_MS", projectConfig.localConfig.ai.timeoutMs);
let aiSplitTimeoutMs = readPositiveIntegerEnv("POLARIS_AI_SPLIT_TIMEOUT_MS", projectConfig.localConfig.ai.splitTimeoutMs);
const feishuPublishTimeoutMs = readPositiveIntegerEnv("POLARIS_FEISHU_TIMEOUT_MS", 8_000);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolveRequestPath(url) {
  const pathname = readRequestPathname(url);
  if (!pathname) return null;
  const requested = pathname === "/" ? "/demo/index.html" : pathname;
  const filePath = normalize(join(root, requested));

  if (!isPathInside(root, filePath)) {
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

function readPackageMetadata() {
  const fallback = { name: "polaris", version: "0.0.0" };
  try {
    return {
      ...fallback,
      ...JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    };
  } catch (error) {
    console.warn(`Unable to read package metadata: ${error.message}`);
    return fallback;
  }
}

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];
  const value = Number.parseInt(rawValue ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function refreshRuntimeAiConfig(project = repository.getProject()) {
  projectConfig = project;
  aiGenerationTimeoutMs = readPositiveIntegerEnv("POLARIS_AI_TIMEOUT_MS", project.localConfig.ai.timeoutMs);
  aiSplitTimeoutMs = readPositiveIntegerEnv("POLARIS_AI_SPLIT_TIMEOUT_MS", project.localConfig.ai.splitTimeoutMs);
}

function serializeAiConfig(project = projectConfig) {
  return {
    ai: project.localConfig.ai,
    effective: {
      timeoutMs: aiGenerationTimeoutMs,
      splitTimeoutMs: aiSplitTimeoutMs,
    },
    localConfigPath: storage.localConfigPath,
    envOverrides: {
      timeoutMs: isPositiveIntegerEnv("POLARIS_AI_TIMEOUT_MS"),
      splitTimeoutMs: isPositiveIntegerEnv("POLARIS_AI_SPLIT_TIMEOUT_MS"),
    },
  };
}

function isPositiveIntegerEnv(name) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0;
}

function migrateLegacyDefaultData({ from, to }) {
  const sourceRoot = resolve(from);
  const targetRoot = resolve(to);
  if (sourceRoot === targetRoot || isDataRootInitialized(targetRoot) || !hasLegacyRuntimeData(sourceRoot)) {
    return;
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of [
    "polaris.project.json",
    "polaris.local.json",
    "task-nodes.json",
    "polaris.db",
    "polaris.db-shm",
    "polaris.db-wal",
    "ai-results",
    "knowledge",
    "skills",
  ]) {
    const sourcePath = join(sourceRoot, entryName);
    const targetPath = join(targetRoot, entryName);
    if (!existsSync(sourcePath) || existsSync(targetPath)) continue;
    cpSync(sourcePath, targetPath, { recursive: true });
  }

  console.log(`Migrated legacy repo data into ${targetRoot}`);
}

function isDataRootInitialized(rootPath) {
  return ["polaris.project.json", "polaris.local.json", "task-nodes.json", "polaris.db", "ai-results"].some((entryName) =>
    existsSync(join(rootPath, entryName)),
  );
}

function hasLegacyRuntimeData(rootPath) {
  return ["polaris.project.json", "polaris.local.json", "task-nodes.json", "polaris.db", "ai-results"].some((entryName) =>
    existsSync(join(rootPath, entryName)),
  );
}

function resolveAiResultRequestPath(url) {
  const pathname = readRequestPathname(url);
  if (!pathname) return null;
  if (!pathname.startsWith("/ai-results/")) return null;

  const requested = normalize(join(aiResultsRoot, pathname.slice("/ai-results/".length)));
  if (!isPathInside(aiResultsRoot, requested)) return null;
  if (existsSync(requested) && statSync(requested).isFile()) return requested;
  return null;
}

function readRequestPathname(url) {
  try {
    return decodeURIComponent(new URL(url, "http://localhost").pathname);
  } catch {
    return null;
  }
}

function isPathInside(rootPath, filePath) {
  const relativePath = relative(rootPath, filePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function handleApiRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, {
        ...repository.getBootstrap(),
        app: {
          name: packageMetadata.name,
          version: packageMetadata.version,
        },
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/project") {
      sendJson(response, 200, { project: repository.getProject() });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/ai-config") {
      sendJson(response, 200, serializeAiConfig());
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/ai-config") {
      const body = await readJsonBody(request);
      const updatedProject = repository.updateAiConfig(readAiConfigPatch(body));
      refreshRuntimeAiConfig(updatedProject);
      clearAiJobCache();
      sendJson(response, 200, {
        project: updatedProject,
        ...serializeAiConfig(updatedProject),
      });
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

    const workspaceIntelligenceMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/workspace-intelligence$/);
    if (request.method === "POST" && workspaceIntelligenceMatch) {
      const nodeId = decodeURIComponent(workspaceIntelligenceMatch[1]);
      const nodes = repository.listTaskNodes();
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        sendJson(response, 404, { error: `Task node not found: ${nodeId}` });
        return true;
      }

      const existingWhyNow = node.aiInsights?.whyNow;
      if (Array.isArray(existingWhyNow?.tags) && existingWhyNow.tags.length > 0) {
        sendJson(response, 200, {
          nodes,
          node,
          intelligence: node.aiInsights,
          status: "ready",
          source: "task-node",
        });
        return true;
      }

      const queue = buildActiveQueue(nodes);
      const queueItem = queue.available.find((item) => item.node.id === nodeId);
      const reason = queueItem?.reason ?? "";
      const library = repository.getLibrary();
      const contextCandidates = getContextCandidateRecords(library, nodes);
      const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason });
      const generated = await generateWorkspaceIntelligence({
        node,
        reason,
        relatedRecords: getRecordsForNode(library, nodeId),
        aiContext,
        contextCandidates,
        serviceRoot: root,
        dataRoot,
        timeoutMs: aiGenerationTimeoutMs,
      });
      const effectiveIntelligence =
        generated.whyNow?.tags?.length > 0 || generated.contextRefs?.length > 0
          ? generated
          : createFallbackWorkspaceIntelligence({ node, reason, contextCandidates });
      const validRefs = contextCandidates.map((candidate) => candidate.ref);
      const updatedNode = applyWorkspaceIntelligenceToNode(node, effectiveIntelligence, validRefs);
      const nextNodes = nodes.map((candidate) => (candidate.id === nodeId ? updatedNode : candidate));
      const savedNodes = repository.saveTaskNodes(nextNodes);
      const savedNode = savedNodes.find((candidate) => candidate.id === nodeId) ?? updatedNode;

      sendJson(response, 200, {
        nodes: savedNodes,
        node: savedNode,
        intelligence: savedNode.aiInsights,
        status: "ready",
        source: effectiveIntelligence.provider === "local-fallback" ? "fallback" : "ai",
      });
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
        timeoutMs: aiSplitTimeoutMs,
      });
      const fallbackSplit = createFallbackTaskNodeSplit(node);
      const effectiveSplit = split.nodes.length > 0 ? split : fallbackSplit;
      const splitNodes = effectiveSplit.nodes;
      const children = createSplitChildren({ parent: node, splitNodes, existingNodes: nodes });
      const savedNodes = repository.saveTaskNodes([...nodes, ...children]);

      sendJson(response, 200, {
        nodes: savedNodes,
        children,
        split: effectiveSplit,
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
      const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "draft-output", nodeId, signature });
      if (saved?.output && hasDraftOutputContent(saved.output)) {
        sendJson(response, 200, {
          output: saved.output,
          persistedAt: saved.updatedAt,
          source: "filesystem",
        });
        return true;
      }
      const draft = await runSharedAiJob(`draft-output:${nodeId}:${signature}`, async () => {
        const latestSaved = readAiResult({ dataRoot, aiResultsRoot, kind: "draft-output", nodeId, signature });
        if (latestSaved?.output && hasDraftOutputContent(latestSaved.output)) {
          return {
            output: latestSaved.output,
            persistedAt: latestSaved.updatedAt,
          };
        }

        const output = await generateDraftOutput({
          node,
          artifact,
          relatedRecords: getRecordsForNode(library, nodeId),
          aiContext,
          actionPlan: suggested.plan,
          serviceRoot: root,
          dataRoot,
          timeoutMs: aiGenerationTimeoutMs,
        });
        const effectiveOutput = hasDraftOutputContent(output)
          ? output
          : createFallbackDraftOutput({ node, artifact, actionPlan: suggested.plan });

        const persisted = writeAiResult({
          dataRoot,
          aiResultsRoot,
          kind: "draft-output",
          nodeId,
          signature,
          payload: { output: effectiveOutput },
        });
        return {
          output: persisted.output,
          persistedAt: persisted.updatedAt,
        };
      });
      if (!draft.output || !hasDraftOutputContent(draft.output)) {
        const error = draft.error || draft.output?.error || "AI 没有返回可用的 Draft Output。";
        sendJson(response, 200, { output: { ...(draft.output ?? {}), error }, status: "error", error });
        return true;
      }

      sendJson(response, 200, {
        output: draft.output,
        persistedAt: draft.persistedAt,
        source: "filesystem",
      });
      return true;
    }

    const refreshAiMatch = url.pathname.match(/^\/api\/task-nodes\/([^/]+)\/refresh-ai$/);
    if (request.method === "POST" && refreshAiMatch) {
      const nodeId = decodeURIComponent(refreshAiMatch[1]);
      const refreshed = await refreshTaskNodeAiResult(nodeId);
      sendJson(response, 200, {
        ...refreshed,
        source: "regenerated",
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
      const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "ai-result", nodeId, signature });
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
        aiResultsRoot,
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

async function readOrCreateSuggestedActionPlan({ nodeId, node, library, reason, aiContext, contextDigest, force = false }) {
  const signature = createSuggestedActionPlanSignature({ node, reason, contextDigest });
  const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "suggested-action-plan", nodeId, signature });
  if (!force && saved?.plan && hasSuggestedActionPlanContent(saved.plan)) {
    return {
      plan: saved.plan,
      persistedAt: saved.updatedAt,
    };
  }

  return runAiJob(`suggested-action-plan:${nodeId}:${signature}`, { force }, async () => {
    const latestSaved = readAiResult({ dataRoot, aiResultsRoot, kind: "suggested-action-plan", nodeId, signature });
    if (!force && latestSaved?.plan && hasSuggestedActionPlanContent(latestSaved.plan)) {
      return {
        plan: latestSaved.plan,
        persistedAt: latestSaved.updatedAt,
      };
    }

    const plan = await generateSuggestedActionPlan({
      node,
      reason,
      relatedRecords: getRecordsForNode(library, nodeId),
      aiContext,
      serviceRoot: root,
      dataRoot,
      timeoutMs: aiGenerationTimeoutMs,
    });
    const effectivePlan = hasSuggestedActionPlanContent(plan)
      ? plan
      : createFallbackSuggestedActionPlan({ node, reason });

    const persisted = writeAiResult({
      dataRoot,
      aiResultsRoot,
      kind: "suggested-action-plan",
      nodeId,
      signature,
      payload: { plan: effectivePlan },
    });
    return {
      plan: persisted.plan,
      persistedAt: persisted.updatedAt,
    };
  });
}

function runAiJob(key, { force = false } = {}, createJob) {
  if (force) return Promise.resolve().then(createJob);
  return runSharedAiJob(key, createJob);
}

function runSharedAiJob(key, createJob) {
  const existing = inFlightAiJobs.get(key);
  if (existing) return existing;

  const job = Promise.resolve()
    .then(createJob)
    .finally(() => {
      inFlightAiJobs.delete(key);
    });
  inFlightAiJobs.set(key, job);
  return job;
}

function clearAiJobCache() {
  inFlightAiJobs.clear();
}

async function refreshTaskNodeAiResult(nodeId) {
  const nodes = repository.listTaskNodes();
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    const error = new Error(`Task node not found: ${nodeId}`);
    error.statusCode = 404;
    throw error;
  }

  const queue = buildActiveQueue(nodes);
  const queueItem = queue.available.find((item) => item.node.id === nodeId);
  const reason = queueItem?.reason ?? "";
  const library = repository.getLibrary();
  const artifact = resolvePreparedArtifact(node, library.artifacts);
  const aiContext = buildAiContextForNode({ nodes, library, nodeId, reason });
  const contextDigest = createAiContextDigest(aiContext);
  const suggested = await readOrCreateSuggestedActionPlan({
    nodeId,
    node,
    library,
    reason,
    aiContext,
    contextDigest,
    force: true,
  });
  const actionPlanDigest = createAiContextDigest(suggested.plan);
  const draft = await readOrCreateDraftOutput({
    nodeId,
    node,
    library,
    artifact,
    aiContext,
    contextDigest,
    actionPlan: suggested.plan,
    actionPlanDigest,
    force: true,
  });
  const generatedResult = await readOrCreateAiResultOutput({
    nodeId,
    node,
    library,
    artifact,
    aiContext,
    contextDigest,
    actionPlan: suggested.plan,
    actionPlanDigest,
    force: true,
  });

  const signature = createAiResultSignature({ node, artifact, contextDigest, actionPlanDigest });
  const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "ai-result", nodeId, signature });
  const result = await publishAiResult({
    node,
    output: generatedResult.output,
    artifact,
    actionPlan: suggested.plan,
    signature,
    existingResult: saved?.result ?? null,
  });
  const persisted = writeAiResult({
    dataRoot,
    aiResultsRoot,
    kind: "ai-result",
    nodeId,
    signature,
    payload: { result, output: generatedResult.output },
  });

  return {
    plan: suggested.plan,
    output: draft.output,
    result: persisted.result,
    persistedAt: persisted.updatedAt,
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

async function publishAiResult({ node, output, artifact, actionPlan, signature, existingResult = null }) {
  if (existingResult?.docType === "本地 HTML" && existingResult.path) {
    return writeAiResultDocument({
      dataRoot,
      aiResultsRoot,
      node,
      signature,
      output,
      artifact,
      actionPlan,
      existingResult,
    });
  }

  try {
    return await publishAiResultToFeishu({
      dataRoot,
      aiResultsRoot,
      node,
      output,
      artifact,
      actionPlan,
      existingResult,
      timeoutMs: feishuPublishTimeoutMs,
    });
  } catch (error) {
    if (existingResult?.docType === "飞书 Doc" && existingResult.url) {
      throw new Error(`更新原飞书文档失败：${error.message}`);
    }
    console.warn(`Feishu AI result publish failed, falling back to local HTML: ${error.message}`);
    return writeAiResultDocument({
      dataRoot,
      aiResultsRoot,
      node,
      signature,
      output,
      artifact,
      actionPlan,
      existingResult,
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
  force = false,
}) {
  const signature = createAiResultSignature({ node, artifact, contextDigest, actionPlanDigest });
  const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "ai-result-output", nodeId, signature });
  if (!force && saved?.output && hasAiResultOutputContent(saved.output)) return { output: saved.output };

  return runAiJob(`ai-result-output:${nodeId}:${signature}`, { force }, async () => {
    const latestSaved = readAiResult({ dataRoot, aiResultsRoot, kind: "ai-result-output", nodeId, signature });
    if (!force && latestSaved?.output && hasAiResultOutputContent(latestSaved.output)) return { output: latestSaved.output };

    const output = await generateAiResultOutput({
      node,
      artifact,
      relatedRecords: getRecordsForNode(library, nodeId),
      aiContext,
      actionPlan,
      serviceRoot: root,
      dataRoot,
      timeoutMs: aiGenerationTimeoutMs,
    });
    const effectiveOutput = hasAiResultOutputContent(output)
      ? output
      : createFallbackAiResultOutput({ node, artifact, actionPlan });

    const persisted = writeAiResult({
      dataRoot,
      aiResultsRoot,
      kind: "ai-result-output",
      nodeId,
      signature,
      payload: { output: effectiveOutput },
    });
    return { output: persisted.output };
  });
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
  force = false,
}) {
  const signature = createDraftOutputSignature({ node, artifact, contextDigest, actionPlanDigest });
  const saved = readAiResult({ dataRoot, aiResultsRoot, kind: "draft-output", nodeId, signature });
  if (!force && saved?.output && hasDraftOutputContent(saved.output)) return { output: saved.output };

  return runAiJob(`draft-output:${nodeId}:${signature}`, { force }, async () => {
    const latestSaved = readAiResult({ dataRoot, aiResultsRoot, kind: "draft-output", nodeId, signature });
    if (!force && latestSaved?.output && hasDraftOutputContent(latestSaved.output)) return { output: latestSaved.output };

    const output = await generateDraftOutput({
      node,
      artifact,
      relatedRecords: getRecordsForNode(library, nodeId),
      aiContext,
      actionPlan,
      serviceRoot: root,
      dataRoot,
      timeoutMs: aiGenerationTimeoutMs,
    });
    const effectiveOutput = hasDraftOutputContent(output)
      ? output
      : createFallbackDraftOutput({ node, artifact, actionPlan });

    const persisted = writeAiResult({
      dataRoot,
      aiResultsRoot,
      kind: "draft-output",
      nodeId,
      signature,
      payload: { output: effectiveOutput },
    });
    return { output: persisted.output };
  });
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

function readAiConfigPatch(body = {}) {
  const input = body.ai && typeof body.ai === "object" ? body.ai : body;
  return {
    timeoutMs: readPositiveIntegerField(input, "timeoutMs", "ai.timeoutMs"),
    splitTimeoutMs: readPositiveIntegerField(input, "splitTimeoutMs", "ai.splitTimeoutMs"),
  };
}

function readPositiveIntegerField(input, fieldName, label) {
  const value = input?.[fieldName];
  const parsedValue = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsedValue) && parsedValue > 0) return parsedValue;
  const error = new Error(`${label} must be a positive integer in milliseconds`);
  error.statusCode = 400;
  throw error;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
