import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const generatorNames = ["openclaw", "hermes"];
const maxSteps = 8;
const defaultEnv = process.env;

export async function generateSuggestedActionPlan({
  node,
  reason = "",
  relatedRecords = [],
  serviceRoot = process.cwd(),
  dataRoot = null,
  timeoutMs = 120_000,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const generator = findLocalActionPlanGenerator({ serviceRoot, dataRoot, env, includePath });
  if (!generator || !node) return createBlankActionPlan();

  try {
    const prompt = buildSuggestedActionPlanPrompt({ node, reason, relatedRecords });
    const output = await runGenerator(generator, prompt, { cwd: serviceRoot, timeoutMs, env });
    return {
      ...parseActionPlanOutput(output),
      provider: generator.name,
    };
  } catch (error) {
    return {
      ...createBlankActionPlan(),
      provider: generator.name,
      error: error.message,
    };
  }
}

export async function generateDraftOutput({
  node,
  artifact = null,
  relatedRecords = [],
  serviceRoot = process.cwd(),
  dataRoot = null,
  timeoutMs = 120_000,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const generator = findLocalActionPlanGenerator({ serviceRoot, dataRoot, env, includePath });
  if (!generator || !node) return createBlankDraftOutput();

  try {
    const prompt = buildDraftOutputPrompt({ node, artifact, relatedRecords });
    const output = await runGenerator(generator, prompt, { cwd: serviceRoot, timeoutMs, env });
    return {
      ...parseDraftOutput(output),
      provider: generator.name,
    };
  } catch (error) {
    return {
      ...createBlankDraftOutput(),
      provider: generator.name,
      error: error.message,
    };
  }
}

export function findLocalActionPlanGenerator({
  serviceRoot = process.cwd(),
  dataRoot = null,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const roots = [serviceRoot, dataRoot]
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => resolve(root));
  const candidateDirs = uniqueValues(
    [
      ...roots.flatMap((root) => [root, join(root, "bin"), join(root, "node_modules", ".bin")]),
      ...(includePath && typeof env.PATH === "string" ? env.PATH.split(delimiter).filter(Boolean) : []),
    ].map((dir) => resolve(dir)),
  );

  for (const name of generatorNames) {
    for (const dir of candidateDirs) {
      const commandPath = join(dir, name);
      if (isExecutableFile(commandPath)) {
        return { name, commandPath };
      }
    }
  }

  return null;
}

export function buildSuggestedActionPlanPrompt({ node, reason = "", relatedRecords = [] }) {
  const context = relatedRecords
    .map((record) => {
      const usage = record.usage ? `\n  用法：${record.usage}` : "";
      return `- ${record.type ?? record.kind ?? "context"}：${record.title}\n  ${record.description ?? ""}${usage}`;
    })
    .join("\n");

  return [
    "你是 Polaris 本地任务节点规划助手。",
    "请基于任务节点和本地知识，生成 Suggest Action Plan。",
    "只输出 JSON，不要输出 Markdown 或解释文字。",
    'JSON 格式：{"summary":"一句话说明推荐逻辑","steps":["具体步骤 1","具体步骤 2"]}',
    "要求：",
    "- steps 生成 3 到 6 条，必须是可执行动作。",
    "- 不要复述节点标题，不要写空泛动作。",
    "- 如果上下文不足，也要根据节点描述生成最小可执行步骤。",
    "",
    "任务节点：",
    `- id：${node.id}`,
    `- 标题：${node.title}`,
    `- 标签：${node.tag}`,
    `- 描述：${node.description}`,
    reason ? `- 推荐原因：${reason}` : null,
    "",
    "本地上下文：",
    context || "无",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildDraftOutputPrompt({ node, artifact = null, relatedRecords = [] }) {
  const context = relatedRecords
    .map((record) => {
      const usage = record.usage ? `\n  用法：${record.usage}` : "";
      return `- ${record.type ?? record.kind ?? "context"}：${record.title}\n  ${record.description ?? ""}${usage}`;
    })
    .join("\n");
  const artifactContext = artifact
    ? [
        `- 类型：${artifact.docType ?? "未知"}`,
        `- 标题：${artifact.title ?? "未知"}`,
        artifact.url ? `- 链接：${artifact.url}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "无";

  return [
    "你是 Polaris 本地任务节点输出草稿助手。",
    "请基于任务节点和本地知识，生成 Draft Output 卡片内容。",
    "只输出 JSON，不要输出 Markdown 或解释文字。",
    'JSON 格式：{"title":"草稿标题","summary":"一句话说明草稿会解决什么","points":["要点 1","要点 2"]}',
    "要求：",
    "- title 用 8 到 18 个中文字符，像真实产物标题，不要写文件类型。",
    "- summary 说明这份草稿要回答的关键问题和判断价值，不要写“AI 会读取”。",
    "- points 生成 3 到 5 条，描述草稿应包含的关键内容模块或验收要点。",
    "- 不要复述任务标题，不要使用“产出：”前缀。",
    "",
    "任务节点：",
    `- id：${node.id}`,
    `- 标题：${node.title}`,
    `- 标签：${node.tag}`,
    `- 描述：${node.description}`,
    "",
    "关联产物：",
    artifactContext,
    "",
    "本地上下文：",
    context || "无",
  ].join("\n");
}

export function parseActionPlanOutput(output) {
  const text = typeof output === "string" ? output.trim() : "";
  if (!text) return createBlankActionPlan();

  const jsonPayload = parseJsonPayload(text);
  if (jsonPayload) return normalizeActionPlan(jsonPayload);

  return normalizeActionPlan({
    summary: "",
    steps: parsePlainTextSteps(text),
  });
}

export function parseDraftOutput(output) {
  const text = typeof output === "string" ? output.trim() : "";
  if (!text) return createBlankDraftOutput();

  const jsonPayload = parseJsonPayload(text);
  if (jsonPayload) return normalizeDraftOutput(jsonPayload);

  return normalizeDraftOutput({
    title: "",
    summary: "",
    points: parsePlainTextSteps(text),
  });
}

function runGenerator(generator, prompt, { cwd, timeoutMs, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = buildGeneratorInvocation(generator, prompt);
    const child = spawn(generator.commandPath, invocation.args, {
      cwd,
      stdio: [invocation.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      env: {
        ...env,
        POLARIS_ACTION_PLAN_PROVIDER: generator.name,
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectPromise(new Error(`${generator.name} timed out while generating the action plan`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `${generator.name} exited with code ${code}`));
        return;
      }
      resolvePromise(stdout);
    });

    if (invocation.stdin) child.stdin.end(invocation.stdin);
  });
}

function buildGeneratorInvocation(generator, prompt) {
  if (generator.name === "hermes") {
    return {
      args: ["chat", "--quiet", "--query", prompt],
      stdin: null,
    };
  }

  return {
    args: [],
    stdin: prompt,
  };
}

function parseJsonPayload(text) {
  for (const candidate of getJsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next likely JSON span.
    }
  }
  return null;
}

function getJsonCandidates(text) {
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const lineCandidates = unfenced
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[+>]\s*/, ""))
    .filter((line) => (line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]")));
  const candidates = [...lineCandidates.reverse(), unfenced];
  const objectStart = unfenced.indexOf("{");
  const objectEnd = unfenced.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(unfenced.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = unfenced.indexOf("[");
  const arrayEnd = unfenced.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(unfenced.slice(arrayStart, arrayEnd + 1));
  }
  return uniqueValues(candidates);
}

function normalizeActionPlan(payload) {
  const plan = payload?.actionPlan ?? payload?.plan ?? payload;
  if (Array.isArray(plan)) {
    return {
      summary: "",
      steps: normalizeSteps(plan),
    };
  }

  return {
    summary: typeof plan?.summary === "string" ? plan.summary.trim() : "",
    steps: normalizeSteps(plan?.steps ?? plan?.actions ?? plan?.aiActions ?? []),
  };
}

function normalizeDraftOutput(payload) {
  const draft = payload?.draftOutput ?? payload?.output ?? payload?.draft ?? payload;
  if (Array.isArray(draft)) {
    return {
      title: "",
      summary: "",
      points: normalizeSteps(draft),
    };
  }

  return {
    title: typeof draft?.title === "string" ? draft.title.trim() : "",
    summary: typeof draft?.summary === "string" ? draft.summary.trim() : "",
    points: normalizeSteps(draft?.points ?? draft?.sections ?? draft?.items ?? []),
  };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step) => (typeof step === "string" ? step.trim() : ""))
    .filter(Boolean)
    .slice(0, maxSteps);
}

function parsePlainTextSteps(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)、]\s*/, "").trim())
    .filter(Boolean);
}

function createBlankActionPlan() {
  return {
    summary: "",
    steps: [],
    provider: null,
  };
}

function createBlankDraftOutput() {
  return {
    title: "",
    summary: "",
    points: [],
    provider: null,
  };
}

function isExecutableFile(filePath) {
  try {
    const stats = statSync(filePath);
    accessSync(filePath, constants.X_OK);
    return stats.isFile();
  } catch {
    return false;
  }
}

function uniqueValues(values) {
  return [...new Set(values)];
}
