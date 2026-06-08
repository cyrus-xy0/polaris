const defaultActionSteps = Object.freeze([
  "确认输入、约束和完成标准",
  "执行一个可检查的最小动作",
  "记录结果、缺口和下一步判断",
]);

export function createFallbackSuggestedActionPlan({ node, reason = "" } = {}) {
  const title = getNodeTitle(node);
  const steps = mergeSteps([
    `确认「${title}」的输入、边界和验收标准`,
    ...normalizeStepList(node?.aiActions),
    "把执行结果沉淀为可复用结论或产物链接",
  ]);

  return {
    summary: reason
      ? "AI 服务暂不可用，已根据任务原因和本地规则生成可执行计划。"
      : "AI 服务暂不可用，已根据任务描述生成本地可执行计划。",
    steps,
    provider: "local-fallback",
  };
}

export function createFallbackDraftOutput({ node, artifact = null, actionPlan = null } = {}) {
  const title = getNodeTitle(node);
  const steps = getActionPlanSteps(actionPlan);
  const artifactLabel = artifact?.title ? `，并参考「${artifact.title}」` : "";
  const brief =
    `本地草稿已围绕「${title}」明确推进路径：${steps.join("；")}。` +
    `后续可直接按这些步骤补齐证据、执行记录和验收结果${artifactLabel}。`;

  return {
    title: buildFallbackTitle(title, "结果草稿"),
    summary: "AI 服务暂不可用，已生成本地可继续推进的结果草稿。",
    brief,
    points: steps,
    provider: "local-fallback",
  };
}

export function createFallbackAiResultOutput({ node, artifact = null, actionPlan = null } = {}) {
  const title = getNodeTitle(node);
  const description = String(node?.description ?? "").trim() || "当前任务未填写详细描述。";
  const steps = getActionPlanSteps(actionPlan);
  const artifactLabel = artifact?.title ? `${artifact.docType ?? "产物"} · ${artifact.title}` : "无";
  const actionList = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");

  return {
    title: buildFallbackTitle(title, "本地结果"),
    summary: "AI 服务暂不可用，已生成本地 HTML 结果以保证任务链路不断。",
    resultType: "local-fallback",
    markdown: [
      "## 任务结论",
      "当前结果由 Polaris 本地规则生成，用于在 AI 服务或飞书写入不稳定时保留可检查的推进路径。",
      "",
      "| 维度 | 本地判断 |",
      "|---|---|",
      `| 任务目标 | ${escapeMarkdownTableCell(title)} |`,
      `| 任务描述 | ${escapeMarkdownTableCell(description)} |`,
      `| 关联产物 | ${escapeMarkdownTableCell(artifactLabel)} |`,
      `| 验收方式 | ${escapeMarkdownTableCell("按行动计划完成记录，并把可验证产物链接回任务节点")} |`,
      "",
      "## 可执行动作",
      actionList,
      "",
      "## 后续校验",
      "- 补充真实数据、外部链接或执行记录后，可以重新生成 AI 结果覆盖本地降级内容。",
      "- 若飞书写入恢复，可用同一结果正文重新发布为飞书文档。",
    ].join("\n"),
    points: [
      "任务推进路径已保留，不再因 AI 服务失败中断当前节点。",
      "结果正文包含任务目标、关联产物、验收方式和可执行动作。",
      "后续可用真实 AI 分析或飞书文档覆盖本地降级结果。",
    ],
    nextActions: ["补充执行证据", "重新生成 AI 结果", "把最终产物链接回任务节点"],
    shouldContinue: null,
    provider: "local-fallback",
  };
}

export function createFallbackTaskNodeSplit(node) {
  const title = getNodeTitle(node);

  return {
    summary: "AI 服务暂不可用，使用本地规则生成最小任务预拆分。",
    nodes: [
      {
        title: "明确输入和边界",
        description: `确认「${title}」需要依赖的输入、约束和完成边界。`,
        aiActions: ["列出输入", "标记约束", "写完成标准"],
      },
      {
        title: "执行最小动作",
        description: `围绕「${title}」完成一个可检查的最小行动。`,
        aiActions: ["选择最小路径", "完成核心动作", "记录过程"],
      },
      {
        title: "验证结果可用性",
        description: `检查「${title}」的结果是否能支撑下一步推进。`,
        aiActions: ["检查结果", "发现缺口", "给出下一步"],
      },
    ],
    provider: "local-fallback",
  };
}

export function createFallbackWorkspaceIntelligence({ node, reason = "", contextCandidates = [] } = {}) {
  const dependencyCount = Array.isArray(node?.dependencies) ? node.dependencies.length : 0;
  const contextRefs = contextCandidates
    .filter((candidate) => candidate?.ref)
    .slice(0, 8)
    .map((candidate) => candidate.ref);

  return {
    whyNow: {
      summary: reason || "AI 服务暂不可用，已用本地规则保留当前任务的执行判断。",
      tags: [
        { text: node?.priority === "P0" ? "当前优先" : "可推进", tone: node?.priority === "P0" ? "strong" : "ready" },
        { text: dependencyCount ? `前置 ${dependencyCount}` : "无前置", tone: "ready" },
        { text: "保留判断", tone: "neutral" },
      ],
    },
    contextRefs,
    provider: "local-fallback",
  };
}

function getActionPlanSteps(actionPlan) {
  const steps = normalizeStepList(actionPlan?.steps);
  return steps.length > 0 ? steps : [...defaultActionSteps];
}

function mergeSteps(steps) {
  const normalized = normalizeStepList(steps);
  const merged = normalized.length > 0 ? normalized : [...defaultActionSteps];
  return [...new Set(merged)].slice(0, 6);
}

function normalizeStepList(steps) {
  return Array.isArray(steps) ? steps.map((step) => String(step ?? "").trim()).filter(Boolean) : [];
}

function getNodeTitle(node) {
  return String(node?.title ?? "").trim() || "当前任务";
}

function buildFallbackTitle(title, suffix) {
  const prefix = truncateText(title, 12);
  const joiner = /[a-zA-Z0-9]$/.test(prefix) && /^[\u4e00-\u9fff]/.test(suffix) ? " " : "";
  return `${prefix}${joiner}${suffix}`;
}

function truncateText(value, maxLength) {
  const chars = Array.from(String(value ?? "").trim());
  if (chars.length <= maxLength) return chars.join("");
  const prefix = chars.slice(0, maxLength).join("").trim();
  const lastSpaceIndex = prefix.lastIndexOf(" ");
  return lastSpaceIndex > 1 ? prefix.slice(0, lastSpaceIndex).trim() : prefix;
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}
