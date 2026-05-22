import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const generatorNames = ["openclaw", "hermes"];
const maxSteps = 8;
const maxSplitNodes = 6;
const validTaskTags = new Set(["思考", "执行", "沟通", "验证", "整理"]);
const defaultEnv = process.env;

export async function generateSuggestedActionPlan({
  node,
  reason = "",
  relatedRecords = [],
  aiContext = null,
  serviceRoot = process.cwd(),
  dataRoot = null,
  timeoutMs = 120_000,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const generator = findLocalActionPlanGenerator({ serviceRoot, dataRoot, env, includePath });
  if (!generator || !node) return createBlankActionPlan();

  try {
    const prompt = buildSuggestedActionPlanPrompt({ node, reason, relatedRecords, aiContext });
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
  aiContext = null,
  actionPlan = null,
  serviceRoot = process.cwd(),
  dataRoot = null,
  timeoutMs = 120_000,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const generator = findLocalActionPlanGenerator({ serviceRoot, dataRoot, env, includePath });
  if (!generator || !node) return createBlankDraftOutput();

  try {
    const prompt = buildDraftOutputPrompt({ node, artifact, relatedRecords, aiContext, actionPlan });
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

export async function generateTaskNodeSplit({
  node,
  relatedRecords = [],
  aiContext = null,
  serviceRoot = process.cwd(),
  dataRoot = null,
  timeoutMs = 120_000,
  env = defaultEnv,
  includePath = true,
} = {}) {
  const generator = findLocalActionPlanGenerator({ serviceRoot, dataRoot, env, includePath });
  if (!generator || !node) return createBlankTaskNodeSplit();

  try {
    const prompt = buildTaskNodeSplitPrompt({ node, relatedRecords, aiContext });
    const output = await runGenerator(generator, prompt, { cwd: serviceRoot, timeoutMs, env });
    return {
      ...parseTaskNodeSplitOutput(output),
      provider: generator.name,
    };
  } catch (error) {
    return {
      ...createBlankTaskNodeSplit(),
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

export function buildSuggestedActionPlanPrompt({ node, reason = "", relatedRecords = [], aiContext = null }) {
  return [
    "你是 Polaris 本地任务节点规划助手。",
    "请综合当前任务、上文输入、knowhow、skill 和其他任务积累结果，生成 Suggest Action Plan。",
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
    "AI 上下文：",
    formatAiContext({ aiContext, relatedRecords }),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildDraftOutputPrompt({ node, artifact = null, relatedRecords = [], aiContext = null, actionPlan = null }) {
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
    "请综合当前任务、上文输入、knowhow、skill 和其他任务积累结果，生成 Draft Output 卡片内容。",
    "只输出 JSON，不要输出 Markdown 或解释文字。",
    'JSON 格式：{"title":"结果标题","summary":"一句话说明 AI 结果解决了什么","brief":"AI 结果 brief"}',
    "要求：",
    "- 必须严格按照 Suggest Action Plan 的 steps 逐步实施，brief 要体现这些步骤的执行结果。",
    "- 不要跳过、替换或重新发明行动计划；如果某一步无法实施，要在 brief 里说明阻塞和下一步处理。",
    "- title 用 8 到 18 个中文字符，像真实产物标题，不要写文件类型。",
    "- summary 说明这个 AI 结果回答的关键问题和判断价值，不要写“AI 会读取”。",
    "- brief 用 80 到 140 个中文字符，直接概括 AI 结果的核心结论、建议和可执行价值。",
    "- brief 不要写成模块清单，不要使用编号，不要复述节点标题。",
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
    "必须遵循的 Suggest Action Plan：",
    formatActionPlan(actionPlan),
    "",
    "AI 上下文：",
    formatAiContext({ aiContext, relatedRecords }),
  ].join("\n");
}

export function buildTaskNodeSplitPrompt({ node, relatedRecords = [], aiContext = null }) {
  return [
    "你是 Polaris 本地任务节点拆解助手。",
    "请根据当前节点标题、描述和上下文，把这个节点预拆分成一组可执行子节点。",
    "只输出 JSON，不要输出 Markdown 或解释文字。",
    'JSON 格式：{"summary":"一句话说明拆分逻辑","nodes":[{"title":"子节点标题","description":"子节点要推进什么","tag":"思考","aiActions":["明确输入","执行最小动作","记录判断"]}]}',
    "要求：",
    "- nodes 生成 3 到 5 个，必须覆盖从理解、执行到验证或沉淀的完整路径。",
    "- title 用 4 到 18 个中文字符，像任务节点，不要写编号。",
    "- description 用一句话说明这个子节点的完成标准。",
    "- tag 只能从 思考、执行、沟通、验证、整理 中选择。",
    "- aiActions 生成 2 到 4 条短动作，不能空泛。",
    "- 不要生成与当前节点同名的子节点。",
    "",
    "当前节点：",
    `- id：${node.id}`,
    `- 标题：${node.title}`,
    `- 标签：${node.tag}`,
    `- 描述：${node.description}`,
    "",
    "AI 上下文：",
    formatAiContext({ aiContext, relatedRecords }),
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
    brief: parsePlainTextSteps(text).join("；"),
    points: parsePlainTextSteps(text),
  });
}

export function parseTaskNodeSplitOutput(output) {
  const text = typeof output === "string" ? output.trim() : "";
  if (!text) return createBlankTaskNodeSplit();

  const jsonPayload = parseJsonPayload(text);
  if (jsonPayload) return normalizeTaskNodeSplit(jsonPayload);

  return normalizeTaskNodeSplit({
    summary: "",
    nodes: parsePlainTextSteps(text),
  });
}

function runGenerator(generator, prompt, { cwd, timeoutMs, env }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = buildGeneratorInvocation(generator, prompt, { env, timeoutMs });
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
      try {
        resolvePromise(extractGeneratorText(generator, stdout));
      } catch (error) {
        rejectPromise(error);
      }
    });

    if (invocation.stdin) child.stdin.end(invocation.stdin);
  });
}

function buildGeneratorInvocation(generator, prompt, { env = defaultEnv, timeoutMs = 120_000 } = {}) {
  if (generator.name === "openclaw") {
    const agent = getEnvString(env, "POLARIS_OPENCLAW_AGENT") || "main";
    const thinking = getEnvString(env, "POLARIS_OPENCLAW_THINKING") || "low";
    return {
      args: [
        "agent",
        "--agent",
        agent,
        "--message",
        prompt,
        "--thinking",
        thinking,
        "--json",
        "--timeout",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      ],
      stdin: null,
    };
  }

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

function extractGeneratorText(generator, output) {
  const text = typeof output === "string" ? output.trim() : "";
  if (!text) return "";
  if (generator.name === "openclaw" && isOpenClawDiagnosticOutput(text)) {
    throw new Error("OpenClaw 返回了 Crestodian 状态信息，而不是 AI 生成内容。请确认使用 openclaw agent 命令并配置可用模型。");
  }
  if (generator.name !== "openclaw") return text;

  const payload = parseJsonPayload(text);
  if (!payload) return text;
  if (hasNativePolarisPayload(payload)) return JSON.stringify(payload);

  const responseText = findFirstStringByKeys(payload, ["response", "reply", "message", "content", "text", "output"]);
  if (responseText) {
    if (isOpenClawDiagnosticOutput(responseText)) {
      throw new Error("OpenClaw 返回了诊断信息，而不是 AI 生成内容。请检查 Agent 和模型配置。");
    }
    return responseText.trim();
  }

  return text;
}

function hasNativePolarisPayload(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      (Object.hasOwn(payload, "steps") ||
        Object.hasOwn(payload, "brief") ||
        Object.hasOwn(payload, "points") ||
        Object.hasOwn(payload, "nodes")),
  );
}

function findFirstStringByKeys(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const key of keys) {
    const candidate = value[key];
    const nested = Array.isArray(candidate)
      ? candidate.map((item) => findFirstStringByKeys(item, keys)).find(Boolean)
      : findFirstStringByKeys(candidate, keys);
    if (nested) return nested;
  }
  return "";
}

function isOpenClawDiagnosticOutput(text) {
  return /Crestodian online|Crestodian needs an interactive TTY|Default agent:|Gateway: reachable|Next: run "talk to agent"/i.test(
    text,
  );
}

function getEnvString(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function formatAiContext({ aiContext, relatedRecords = [] }) {
  if (!aiContext) {
    return formatLegacyRecords(relatedRecords);
  }

  return [
    formatTaskSection("任务上文输入", aiContext.taskLineage),
    formatTaskSection("依赖与上游任务", aiContext.upstreamTasks),
    formatRecordSection("Knowhow / 知识库", aiContext.knowledge),
    formatRecordSection("Skill / 可复用能力", aiContext.skills),
    formatRecordSection("关联产物", aiContext.artifacts),
    formatTaskSection("其他任务积累结果", aiContext.accumulatedResults),
  ]
    .filter(Boolean)
    .join("\n\n") || "无";
}

function formatActionPlan(actionPlan) {
  if (!actionPlan) return "无";
  const steps = Array.isArray(actionPlan.steps) ? actionPlan.steps.filter(Boolean) : [];
  return [
    actionPlan.summary ? `summary：${actionPlan.summary}` : null,
    steps.length > 0 ? `steps：\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n") || "无";
}

function formatLegacyRecords(records = []) {
  return (
    records
      .map((record) => {
        const usage = record.usage ? `\n  用法：${record.usage}` : "";
        return `- ${record.type ?? record.kind ?? "context"}：${record.title}\n  ${record.description ?? ""}${usage}`;
      })
      .join("\n") || "无"
  );
}

function formatTaskSection(title, tasks = []) {
  const lines = (tasks ?? []).map((task) => {
    const result = formatTaskResult(task);
    const actions = Array.isArray(task.aiActions) && task.aiActions.length > 0 ? `\n  已知动作：${task.aiActions.join(" / ")}` : "";
    return `- ${task.title}（${task.tag ?? "任务"}，${task.state ?? "未知状态"}）\n  ${task.description ?? ""}${actions}${result}`;
  });
  if (lines.length === 0) return "";
  return `${title}：\n${lines.join("\n")}`;
}

function formatRecordSection(title, records = []) {
  const lines = (records ?? []).map((record) => {
    const usage = record.usage ? `\n  用法：${record.usage}` : "";
    const url = record.url ? `\n  链接：${record.url}` : "";
    const markdown = record.markdown ? `\n  内容摘录：${excerpt(record.markdown)}` : "";
    return `- ${record.type ?? record.kind ?? "context"}：${record.title}\n  ${record.description ?? ""}${usage}${url}${markdown}`;
  });
  if (lines.length === 0) return "";
  return `${title}：\n${lines.join("\n")}`;
}

function formatTaskResult(task) {
  const parts = [];
  if (task.conclusion) parts.push(`结论：${stringifyCompact(task.conclusion)}`);
  if (task.result) parts.push(`结果：${stringifyCompact(task.result)}`);
  return parts.length > 0 ? `\n  ${parts.join("\n  ")}` : "";
}

function stringifyCompact(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function excerpt(value, maxLength = 700) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
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
    const points = normalizeSteps(draft);
    return {
      title: "",
      summary: "",
      brief: points.join("；"),
      points,
    };
  }

  const points = normalizeSteps(draft?.points ?? draft?.sections ?? draft?.items ?? []);
  return {
    title: typeof draft?.title === "string" ? draft.title.trim() : "",
    summary: typeof draft?.summary === "string" ? draft.summary.trim() : "",
    brief: typeof draft?.brief === "string" ? draft.brief.trim() : points.join("；"),
    points,
  };
}

function normalizeTaskNodeSplit(payload) {
  const split = payload?.taskSplit ?? payload?.split ?? payload?.children ?? payload;
  const rawNodes = Array.isArray(split) ? split : split?.nodes;

  return {
    summary: typeof split?.summary === "string" ? split.summary.trim() : "",
    nodes: normalizeSplitNodes(rawNodes),
  };
}

function normalizeSplitNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => {
      if (typeof node === "string") {
        const title = node.trim();
        return {
          title,
          description: title ? `完成「${title}」并记录判断。` : "",
          tag: "执行",
          aiActions: ["明确输入", "执行最小动作", "记录结果"],
        };
      }

      const title = typeof node?.title === "string" ? node.title.trim() : "";
      const description = typeof node?.description === "string" ? node.description.trim() : "";
      const tag = validTaskTags.has(node?.tag) ? node.tag : "执行";
      const aiActions = normalizeSteps(node?.aiActions ?? node?.actions ?? node?.steps ?? []);
      return {
        title,
        description: description || (title ? `完成「${title}」并记录判断。` : ""),
        tag,
        aiActions: aiActions.length > 0 ? aiActions.slice(0, 4) : ["明确输入", "执行最小动作", "记录结果"],
      };
    })
    .filter((node) => node.title)
    .slice(0, maxSplitNodes);
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
    brief: "",
    points: [],
    provider: null,
  };
}

function createBlankTaskNodeSplit() {
  return {
    summary: "",
    nodes: [],
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
