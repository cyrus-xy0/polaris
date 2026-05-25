import {
  CREATED_FROM,
  TASK_PRIORITIES,
  TASK_STATES,
  buildTree,
  createNode,
  deriveEffectiveStates,
  indexNodes,
} from "/src/task-nodes.js";
import {
  buildActiveQueue,
  completeTask,
  deleteTaskNode,
  getAncestorIds,
  getNodeAndDescendantIds,
  migrateTaskNodes,
  moveTaskNode,
  resolvePreparedArtifact,
  toggleTaskNodeState,
} from "/src/app-logic.js";

let nodes = [];
let library = { knowledge: [], skills: [], artifacts: [] };
let appMetadata = { version: "" };
let projectConfig = normalizeProjectConfig();
let selectedNodeId = null;
let selectedTreeNodeId = null;
let activeView = "today";
let editingMarkdownItem = null;
let currentPreparedArtifact = null;
let autoFilledResultUrl = "";
const expandedKnowledgeGroups = new Set();
const collapsedKnowledgeGroups = new Set();
const collapsedWorkbenchSections = new Set(readCollapsedWorkbenchSections());
let nodeEditorFeedback = null;
let nodeEditorDraft = null;
let isNodeEditorOpen = false;
const suggestedActionPlanCache = new Map();
const draftOutputCache = new Map();
const aiResultCache = new Map();
let saveNodesRequestId = 0;
const splittingNodeIds = new Set();
let nodeEditorDependencyNodeId = null;
let nodeEditorDependencyIds = new Set();
let nodeEditorDependencyQuery = "";
let nodeEditorBackdropPointerStarted = false;
let draggingTreeNodeId = null;
let treeDropTarget = null;
let aiConfigDraft = null;
let aiConfigFeedback = null;
let refreshingAiNodeId = null;
const aiAnalyzingText = "AI 正在分析";
const newRootNodeTitle = "新的 Polaris 目标";
const newRootNodeDescription = "写清楚这棵目标树最终要推进什么。";
const newNodeTitle = "新的行动节点";
const newNodeDescription = "写清楚这个节点要推进什么。";

const elements = {
  viewButtons: [...document.querySelectorAll("[data-view-button]")],
  views: {
    today: document.querySelector("#today-view"),
    tree: document.querySelector("#tree-view"),
    methods: document.querySelector("#methods-view"),
  },
  currentTitle: document.querySelector("#current-title"),
  currentSummary: document.querySelector("#current-summary"),
  currentPriority: document.querySelector("#current-priority"),
  currentRank: document.querySelector("#current-rank"),
  refreshAiButton: document.querySelector("#refresh-ai-button"),
  actionPlanSummary: document.querySelector("#action-plan-summary"),
  actionPlanSteps: document.querySelector("#action-plan-steps"),
  preparedResultTitle: document.querySelector("#prepared-result-title"),
  preparedResultSummary: document.querySelector("#prepared-result-summary"),
  preparedResultPoints: document.querySelector("#prepared-result-points"),
  queueChain: document.querySelector("#queue-chain"),
  aiResultLink: document.querySelector("#ai-result-link"),
  completeButton: document.querySelector("#complete-button"),
  manualResultUrl: document.querySelector("#manual-result-url"),
  aiConfigForm: document.querySelector("#ai-config-form"),
  aiTimeoutSeconds: document.querySelector("#ai-timeout-seconds"),
  aiSplitTimeoutSeconds: document.querySelector("#ai-split-timeout-seconds"),
  aiConfigStatus: document.querySelector("#ai-config-status"),
  treeMap: document.querySelector("#tree-map"),
  nodeEditorDrawer: document.querySelector("#node-editor-drawer"),
  nodeEditorForm: document.querySelector("#node-editor-form"),
  nodeEditorHeading: document.querySelector("#node-editor-heading"),
  nodeEditorMeta: document.querySelector("#node-editor-meta"),
  nodeEditorTitle: document.querySelector("#node-editor-title"),
  nodeEditorDescription: document.querySelector("#node-editor-description"),
  nodeEditorPriority: document.querySelector("#node-editor-priority"),
  nodeEditorDependencySearch: document.querySelector("#node-editor-dependency-search"),
  nodeEditorDependencyAdd: document.querySelector("#node-editor-dependency-add"),
  nodeEditorDependencyOptions: document.querySelector("#node-editor-dependency-options"),
  nodeEditorDependencySelected: document.querySelector("#node-editor-dependency-selected"),
  nodeEditorAiSplit: document.querySelector("#node-editor-ai-split"),
  nodeEditorStatus: document.querySelector("#node-editor-status"),
  nodeEditorClose: document.querySelector("#node-editor-close"),
  knowledgeGrid: document.querySelector("#knowledge-grid"),
  skillGrid: document.querySelector("#skill-grid"),
  intermediateGrid: document.querySelector("#intermediate-grid"),
  workbenchSections: [...document.querySelectorAll("[data-workbench-section]")],
  workbenchToggles: [...document.querySelectorAll("[data-workbench-toggle]")],
  markdownEditor: document.querySelector("#markdown-editor"),
  markdownEditorTitle: document.querySelector("#markdown-editor-title"),
  markdownEditorPath: document.querySelector("#markdown-editor-path"),
  markdownEditorTextarea: document.querySelector("#markdown-editor-textarea"),
  markdownEditorClose: document.querySelector("#markdown-editor-close"),
  markdownEditorSave: document.querySelector("#markdown-editor-save"),
  appFooter: document.querySelector("#app-footer"),
  appVersion: document.querySelector("#app-version"),
};

async function loadAppData() {
  const data = await requestJson("/api/bootstrap");
  appMetadata = normalizeAppMetadata(data.app);
  projectConfig = normalizeProjectConfig(data.project);
  nodes = hydrateNodes(data.nodes);
  library = normalizeLibrary(data.library);
  selectedTreeNodeId = nodes[0]?.id ?? null;
}

function hydrateNodes(rawNodes) {
  return migrateTaskNodes((rawNodes ?? []).map((node) => createNode(node)));
}

function normalizeLibrary(rawLibrary = {}) {
  return {
    knowledge: rawLibrary.knowledge ?? [],
    skills: rawLibrary.skills ?? [],
    artifacts: rawLibrary.artifacts ?? [],
  };
}

function normalizeAppMetadata(rawApp = {}) {
  const version = String(rawApp.version ?? "").trim();
  return {
    version: version ? `v${version.replace(/^v/i, "")}` : "",
  };
}

function normalizeProjectConfig(rawProject = {}) {
  const ai = rawProject.localConfig?.ai ?? {};
  return {
    localConfig: {
      ai: {
        timeoutMs: normalizePositiveInteger(ai.timeoutMs, 120_000),
        splitTimeoutMs: normalizePositiveInteger(ai.splitTimeoutMs, 60_000),
      },
    },
  };
}

function normalizePositiveInteger(value, fallback) {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

async function saveNodes() {
  const requestId = ++saveNodesRequestId;
  try {
    const payload = await requestJson("/api/task-nodes", {
      method: "PUT",
      body: JSON.stringify({ nodes }),
    });
    if (requestId === saveNodesRequestId) {
      nodes = hydrateNodes(payload.nodes);
      clearAiGenerationCaches();
      render();
    }
    return { ok: true };
  } catch (error) {
    console.error("Failed to persist task nodes", error);
    return { ok: false, error };
  }
}

function formatSaveError(error) {
  if (!error) return "保存失败，请查看终端日志";
  if (error.name === "TypeError" && /fetch|load|network/i.test(error.message)) {
    return "保存失败：本地服务已断开，请刷新或打开最新端口";
  }
  return `保存失败：${error.message}`;
}

async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });
  const text = await response.text();
  const payload = parseJsonResponse(text, { url, status: response.status });
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

function parseJsonResponse(text, { url, status }) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(formatNonJsonResponseError(text, { url, status }));
  }
}

function formatNonJsonResponseError(text, { url, status }) {
  const trimmed = String(text ?? "").trim();
  const plainText = trimmed
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^<(!doctype|html|head|body)\b/i.test(trimmed)) {
    return `服务返回了 HTML 页面，请检查部署代理是否把 /api 转发到 Polaris 服务。路径：${url}，状态码：${status}`;
  }
  return `服务返回了非 JSON 响应：${plainText.slice(0, 120) || "空内容"}`;
}

async function init() {
  renderLoadingState();
  try {
    await loadAppData();
    render();
  } catch (error) {
    console.error("Failed to load Polaris data", error);
    renderFatalState(error);
  }
}

function renderLoadingState() {
  renderView();
  syncAiRefreshButton(null);
  elements.currentTitle.textContent = "正在加载本地数据";
  elements.currentSummary.textContent = "任务节点、Skill 和知识库会从本地数据层读取。";
  elements.currentPriority.textContent = "SQLite";
  elements.currentPriority.className = "node-chip muted";
  elements.currentRank.textContent = "数据层初始化中";
  elements.actionPlanSummary.textContent = "正在准备任务队列。";
  elements.actionPlanSteps.replaceChildren();
  elements.preparedResultTitle.textContent = "Local Data";
  elements.preparedResultSummary.textContent = "请稍候。";
  elements.preparedResultPoints.replaceChildren();
  currentPreparedArtifact = null;
  updateAiResultLink();
  elements.queueChain.innerHTML = '<div class="empty-state">读取本地数据库...</div>';
}

function renderFatalState(error) {
  renderView();
  syncAiRefreshButton(null);
  elements.currentTitle.textContent = "本地数据加载失败";
  elements.currentSummary.textContent = error.message;
  elements.currentPriority.textContent = "需要检查 server";
  elements.currentPriority.className = "node-chip muted";
  elements.currentRank.textContent = "API 未就绪";
  elements.actionPlanSummary.textContent = "请确认 npm start 正在运行，并查看终端错误。";
  elements.actionPlanSteps.replaceChildren();
  elements.preparedResultTitle.textContent = "Local Data";
  elements.preparedResultSummary.textContent = "数据层没有返回可用内容。";
  elements.preparedResultPoints.replaceChildren();
  currentPreparedArtifact = null;
  updateAiResultLink();
  elements.queueChain.innerHTML = '<div class="empty-state">无法读取任务队列</div>';
}

function getActiveQueue() {
  return buildActiveQueue(nodes);
}

function getRecordsForNode(nodeId) {
  return (library.artifacts ?? []).filter((item) => item.relatedNodeIds?.includes(nodeId));
}

function getOutputRecordsForNode(nodeId) {
  const node = nodes.find((item) => item.id === nodeId);
  return dedupeOutputRecords([createTaskResultRecord(node), ...getRecordsForNode(nodeId)].filter(Boolean));
}

function getCompletedTaskResultRecords() {
  const taskResults = nodes
    .filter((node) => node.state === TASK_STATES.DONE)
    .map(createTaskResultRecord)
    .filter(Boolean);
  return dedupeOutputRecords(taskResults);
}

function createTaskResultRecord(node) {
  const result = node?.result;
  const url = typeof result?.url === "string" ? result.url.trim() : "";
  if (!node || !url) return null;

  const source = typeof result.source === "string" && result.source.trim() ? result.source.trim() : "task-result";
  const title = typeof result.title === "string" && result.title.trim() ? result.title.trim() : `${node.title} 结果`;
  const docType =
    typeof result.docType === "string" && result.docType.trim()
      ? result.docType.trim()
      : source === "manual"
        ? "手动链接"
        : "AI 结果";
  const description =
    typeof result.description === "string" && result.description.trim()
      ? result.description.trim()
      : source === "manual"
        ? "用户完成任务时绑定的结果链接。"
        : "完成任务时生成并绑定的 AI 结果。";

  return {
    id: `task-result-${node.id}`,
    kind: "artifacts",
    source,
    docType,
    title,
    description,
    url,
    path: result.path,
    relatedNodeIds: [node.id],
    taskTitle: node.title,
    isTaskResult: true,
  };
}

function dedupeOutputRecords(records) {
  const seen = new Set();
  const outputRecords = [];
  for (const record of records) {
    const key = record.url || record.id;
    if (seen.has(key)) continue;
    seen.add(key);
    outputRecords.push(record);
  }
  return outputRecords;
}

function getNodeTitle(nodeId) {
  const index = indexNodes(nodes);
  return index.byId.get(nodeId)?.title ?? nodeId;
}

function selectTreeNode(nodeId) {
  if (!nodes.some((node) => node.id === nodeId)) return;
  runTreeTransition(() => {
    selectedTreeNodeId = nodeId;
    activeView = "tree";
    closeMarkdownEditor();
  });
}

function runTreeTransition(update) {
  update();
  render();
}

function getCurrentItem(queue) {
  if (selectedNodeId) {
    const selected = queue.available.find((item) => item.node.id === selectedNodeId);
    if (selected) return selected;
  }

  return queue.current;
}

function render() {
  renderAppVersion();
  renderAiConfigPanel();
  renderView();
  const queue = getActiveQueue();
  const current = getCurrentItem(queue);

  if (!current) {
    renderEmptyState();
    return;
  }

  renderCurrent(current, queue);
  renderQueue(queue, current.node.id);
  renderTree();
  renderMethods();
}

function renderAppVersion() {
  if (!elements.appVersion) return;
  elements.appVersion.textContent = appMetadata.version;
  if (elements.appFooter) {
    elements.appFooter.hidden = !appMetadata.version;
  }
}

function renderAiConfigPanel() {
  if (!elements.aiConfigForm) return;
  if (!aiConfigDraft) {
    elements.aiTimeoutSeconds.value = formatMillisecondsAsSeconds(projectConfig.localConfig.ai.timeoutMs);
    elements.aiSplitTimeoutSeconds.value = formatMillisecondsAsSeconds(projectConfig.localConfig.ai.splitTimeoutMs);
  }
  elements.aiConfigStatus.textContent = aiConfigFeedback?.message ?? "";
  elements.aiConfigStatus.classList.toggle("is-error", aiConfigFeedback?.tone === "error");
}

function formatMillisecondsAsSeconds(milliseconds) {
  return String(Math.max(1, Math.round(milliseconds / 1000)));
}

function renderView() {
  for (const [viewName, view] of Object.entries(elements.views)) {
    view.classList.toggle("is-active", viewName === activeView);
  }
  for (const button of elements.viewButtons) {
    button.classList.toggle("is-active", button.dataset.viewButton === activeView);
  }
}

function renderEmptyState() {
  if (nodes.length === 0) {
    renderFirstRunEmptyState();
    return;
  }

  elements.currentTitle.textContent = "今天的叶子任务都完成了";
  elements.currentSummary.textContent = "可以回到目标树继续拆分，或者复盘刚才完成的判断。";
  elements.currentPriority.textContent = "队列已清空";
  elements.currentPriority.className = "node-chip muted";
  elements.currentRank.textContent = "队列位置：无";
  syncAiRefreshButton(null);
  elements.actionPlanSummary.textContent = "队列已经清空，下一步应该让目标树继续产生可执行动作。";
  elements.actionPlanSteps.replaceChildren(...["复盘完成内容", "补充判断结论", "拆出下一批行动"].map(createActionItem));
  elements.preparedResultTitle.textContent = "等待下一批任务";
  elements.preparedResultSummary.textContent = "没有可执行节点时不会预置 AI 结果。";
  elements.preparedResultPoints.replaceChildren();
  currentPreparedArtifact = null;
  updateAiResultLink();
  elements.queueChain.innerHTML = '<div class="empty-state">没有可执行叶子节点</div>';
  renderTree();
  renderMethods();
}

function renderFirstRunEmptyState() {
  elements.currentTitle.textContent = "创建你的 Polaris 目标";
  elements.currentSummary.textContent = "首次部署会保留空目标树，任务节点和结果只写入你的本地数据目录。";
  elements.currentPriority.textContent = "空数据层";
  elements.currentPriority.className = "node-chip muted";
  elements.currentRank.textContent = "等待根目标";
  syncAiRefreshButton(null);
  elements.actionPlanSummary.textContent = "先写下根目标，再把它拆成可执行节点。";
  elements.actionPlanSteps.replaceChildren(...["创建根目标", "补充描述", "保存后继续拆分"].map(createActionItem));
  elements.preparedResultTitle.textContent = "User Data";
  elements.preparedResultSummary.textContent = "目标树、卡片状态和 output 会从此刻开始保存在用户数据目录。";
  elements.preparedResultPoints.replaceChildren();
  currentPreparedArtifact = null;
  updateAiResultLink();
  elements.queueChain.replaceChildren(createFirstRunPrompt("创建根目标", addRootNode));
  renderTree();
  renderMethods();
}

function renderCurrent(item, queue) {
  const { node, reason } = item;

  elements.currentTitle.textContent = node.title;
  elements.currentSummary.textContent = node.description;
  elements.currentPriority.textContent = getPriorityLabel(node.id, queue);
  elements.currentPriority.className = `node-chip ${getPriorityClass(node.id, queue)}`;
  elements.currentRank.textContent = getQueueRankLabel(node.id, queue);
  syncAiRefreshButton(node);
  renderSuggestedActionPlan(node, reason);
  renderDraftOutput(node, reason);
}

function syncAiRefreshButton(node) {
  const button = elements.refreshAiButton;
  if (!button) return;
  const isRefreshing = node && refreshingAiNodeId === node.id;
  button.hidden = !node;
  button.disabled = !node || isRefreshing;
  button.classList.toggle("is-refreshing", Boolean(isRefreshing));
  button.textContent = isRefreshing ? "…" : "↻";
  button.title = isRefreshing ? "正在生成当前任务 AI 结果" : "生成或重新生成当前任务 AI 结果";
}

function renderSuggestedActionPlan(node, reason) {
  const signature = getSuggestedActionPlanSignature(node, reason);
  const cached = suggestedActionPlanCache.get(node.id);

  if (cached?.signature === signature && cached.status === "ready") {
    renderActionPlan(cached.plan);
    return;
  }
  if (cached?.signature === signature && cached.status === "error") {
    renderActionPlan(createAiErrorActionPlan(cached.error));
    return;
  }
  if (cached?.signature === signature && cached.status === "loading") {
    renderActionPlan(createAiPendingActionPlan());
    return;
  }

  renderActionPlan(createAiIdleActionPlan());
}

async function requestSuggestedActionPlan(node, signature) {
  suggestedActionPlanCache.set(node.id, { status: "loading", signature });

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/suggested-action-plan`, {
      method: "POST",
    });
    const plan = normalizeSuggestedActionPlan(payload.plan);
    if (payload.status === "error" || plan.error) {
      suggestedActionPlanCache.set(node.id, {
        status: "error",
        signature,
        error: payload.error || plan.error,
      });
      render();
      return;
    }

    suggestedActionPlanCache.set(node.id, {
      status: "ready",
      signature,
      plan,
    });
  } catch (error) {
    console.error("Failed to generate suggested action plan", error);
    suggestedActionPlanCache.set(node.id, {
      status: "error",
      signature,
      error: error.message,
    });
  }

  render();
}

function renderActionPlan(plan) {
  elements.actionPlanSummary.textContent = plan.summary;
  elements.actionPlanSteps.replaceChildren(...plan.steps.map(createActionItem));
}

function normalizeSuggestedActionPlan(plan = {}) {
  const normalizedPlan = plan ?? {};
  const steps = Array.isArray(normalizedPlan.steps)
    ? normalizedPlan.steps.map((step) => (typeof step === "string" ? step.trim() : "")).filter(Boolean)
    : [];

  return {
    summary: typeof normalizedPlan.summary === "string" ? normalizedPlan.summary.trim() : "",
    steps,
    error: typeof normalizedPlan.error === "string" ? normalizedPlan.error.trim() : "",
  };
}

function getSuggestedActionPlanSignature(node, reason) {
  return JSON.stringify({
    version: "task-card-v1",
    id: node.id,
    title: node.title,
    description: node.description,
    dependencies: normalizeSignatureArray(node.dependencies),
    state: node.state,
    priority: node.priority ?? "P2",
  });
}

function renderDraftOutput(node, reason) {
  const artifact = resolvePreparedArtifact(node, library.artifacts);
  const signature = getDraftOutputSignature(node, artifact, reason);
  const suggestedSignature = getSuggestedActionPlanSignature(node, reason);
  const suggested = suggestedActionPlanCache.get(node.id);
  const cached = draftOutputCache.get(node.id);
  currentPreparedArtifact = null;

  if (cached?.signature === signature && cached.status === "ready") {
    renderDraftOutputContent(cached.output);
    renderAiResultLink(node, artifact, reason, cached);
    return;
  }
  if (cached?.signature === signature && cached.status === "error") {
    renderDraftOutputContent(createAiErrorDraftOutput(cached.error));
    renderAiResultLink(node, artifact, reason, cached);
    return;
  }
  if (cached?.signature === signature && cached.status === "loading") {
    renderDraftOutputContent(createAiPendingDraftOutput());
    renderAiResultLink(node, artifact, reason, cached);
    return;
  }

  if (suggested?.signature === suggestedSignature && suggested.status === "error") {
    const errorState = {
      status: "error",
      signature,
      error: suggested.error || "需要先生成 Suggest Action Plan。",
    };
    renderDraftOutputContent(createAiErrorDraftOutput(errorState.error));
    renderAiResultLink(node, artifact, reason, errorState);
    return;
  }

  renderDraftOutputContent(createAiIdleDraftOutput());
  renderAiResultLink(node, artifact, reason, { status: "idle", signature });
}

async function requestDraftOutput(node, signature) {
  draftOutputCache.set(node.id, { status: "loading", signature });

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/draft-output`, {
      method: "POST",
    });
    const output = normalizeDraftOutput(payload.output);
    if (payload.status === "error" || output.error) {
      draftOutputCache.set(node.id, {
        status: "error",
        signature,
        error: payload.error || output.error,
      });
      render();
      return;
    }

    draftOutputCache.set(node.id, {
      status: "ready",
      signature,
      output,
    });
  } catch (error) {
    console.error("Failed to generate draft output", error);
    draftOutputCache.set(node.id, {
      status: "error",
      signature,
      error: error.message,
    });
  }

  render();
}

function renderDraftOutputContent(output) {
  elements.preparedResultTitle.textContent = output.title;
  elements.preparedResultSummary.textContent = output.summary;
  if (output.brief) {
    elements.preparedResultPoints.classList.add("is-brief");
    elements.preparedResultPoints.replaceChildren(createPreparedBrief(output.brief));
    return;
  }

  elements.preparedResultPoints.classList.remove("is-brief");
  elements.preparedResultPoints.replaceChildren(...output.points.map(createPreparedPoint));
}

function normalizeDraftOutput(output = {}) {
  const normalizedOutput = output ?? {};
  const points = Array.isArray(normalizedOutput.points)
    ? normalizedOutput.points.map((point) => (typeof point === "string" ? point.trim() : "")).filter(Boolean)
    : [];

  return {
    title: typeof normalizedOutput.title === "string" ? normalizedOutput.title.trim() : "",
    summary: typeof normalizedOutput.summary === "string" ? normalizedOutput.summary.trim() : "",
    brief: typeof normalizedOutput.brief === "string" ? normalizedOutput.brief.trim() : points.join("；"),
    points,
    error: typeof normalizedOutput.error === "string" ? normalizedOutput.error.trim() : "",
  };
}

function createAiPendingActionPlan() {
  return {
    summary: aiAnalyzingText,
    steps: [],
  };
}

function createAiIdleActionPlan() {
  return {
    summary: "点击上方生成按钮后，AI 才会分析路径并生成行动计划。",
    steps: [],
  };
}

function createAiErrorActionPlan(error) {
  return {
    summary: error ? `AI 分析失败：${error}` : "AI 分析失败，请查看终端日志。",
    steps: [],
  };
}

function createAiPendingDraftOutput() {
  return {
    title: "",
    summary: aiAnalyzingText,
    brief: "",
    points: [],
  };
}

function createAiIdleDraftOutput() {
  return {
    title: "等待用户触发",
    summary: "不会预置结果；点击生成按钮后才会创建或更新 AI 结果文档。",
    brief: "",
    points: [],
  };
}

function createAiErrorDraftOutput(error) {
  return {
    title: "AI 分析失败",
    summary: error || "请查看终端日志后重试。",
    brief: "",
    points: [],
  };
}

function getDraftOutputSignature(node, artifact, reason = "") {
  return JSON.stringify({
    version: "task-card-v1",
    id: node.id,
    title: node.title,
    description: node.description,
    dependencies: normalizeSignatureArray(node.dependencies),
    state: node.state,
    priority: node.priority ?? "P2",
    artifactTitle: artifact?.title ?? "",
    artifactType: artifact?.docType ?? "",
  });
}

function normalizeSignatureArray(value) {
  return Array.isArray(value) ? [...value].map((item) => String(item)).sort() : [];
}

function clearAiGenerationCaches() {
  suggestedActionPlanCache.clear();
  draftOutputCache.clear();
  aiResultCache.clear();
}

function renderAiResultLink(node, artifact, reason, draftState) {
  currentPreparedArtifact = null;
  const signature = getAiResultSignature(node, artifact, reason);
  const cached = aiResultCache.get(node.id);

  if (draftState?.status === "error") {
    updateAiResultLink({ status: "error", error: draftState.error });
    return;
  }

  if (draftState?.status === "loading") {
    updateAiResultLink({ status: "loading" });
    return;
  }

  if (draftState?.status !== "ready") {
    updateAiResultLink({ status: "idle" });
    return;
  }

  if (cached?.signature === signature && cached.status === "ready") {
    currentPreparedArtifact = cached.result;
    updateAiResultLink({ status: "ready", result: cached.result });
    return;
  }

  if (cached?.signature === signature && cached.status === "error") {
    updateAiResultLink({ status: "error", error: cached.error });
    return;
  }

  if (cached?.signature === signature && cached.status === "loading") {
    updateAiResultLink({ status: "loading" });
    return;
  }

  updateAiResultLink({ status: "idle" });
}

async function requestAiResult(node, signature) {
  aiResultCache.set(node.id, { status: "loading", signature });

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/ai-result`, {
      method: "POST",
    });
    const result = normalizeAiResult(payload.result);
    if (payload.status === "error" || result.error) {
      aiResultCache.set(node.id, {
        status: "error",
        signature,
        error: payload.error || result.error,
      });
      render();
      return;
    }

    aiResultCache.set(node.id, {
      status: "ready",
      signature,
      result,
    });
    attachAiResultToCompletedTask(node.id, result);
  } catch (error) {
    console.error("Failed to generate AI result link", error);
    aiResultCache.set(node.id, {
      status: "error",
      signature,
      error: error.message,
    });
  }

  render();
}

async function refreshCurrentAiResult() {
  const queue = getActiveQueue();
  const current = getCurrentItem(queue);
  if (!current || refreshingAiNodeId) return;

  const { node, reason } = current;
  const artifact = resolvePreparedArtifact(node, library.artifacts);
  const suggestedSignature = getSuggestedActionPlanSignature(node, reason);
  const draftSignature = getDraftOutputSignature(node, artifact, reason);
  const resultSignature = getAiResultSignature(node, artifact, reason);

  refreshingAiNodeId = node.id;
  suggestedActionPlanCache.set(node.id, { status: "loading", signature: suggestedSignature });
  draftOutputCache.set(node.id, { status: "loading", signature: draftSignature });
  aiResultCache.set(node.id, { status: "loading", signature: resultSignature });
  render();

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/refresh-ai`, {
      method: "POST",
    });
    const plan = normalizeSuggestedActionPlan(payload.plan);
    const output = normalizeDraftOutput(payload.output);
    const result = normalizeAiResult(payload.result);
    if (plan.error || output.error || result.error) {
      throw new Error(plan.error || output.error || result.error);
    }

    suggestedActionPlanCache.set(node.id, {
      status: "ready",
      signature: suggestedSignature,
      plan,
    });
    draftOutputCache.set(node.id, {
      status: "ready",
      signature: draftSignature,
      output,
    });
    aiResultCache.set(node.id, {
      status: "ready",
      signature: resultSignature,
      result,
    });
    attachAiResultToCompletedTask(node.id, result);
  } catch (error) {
    console.error("Failed to refresh AI result", error);
    suggestedActionPlanCache.set(node.id, {
      status: "error",
      signature: suggestedSignature,
      error: error.message,
    });
    draftOutputCache.set(node.id, {
      status: "error",
      signature: draftSignature,
      error: error.message,
    });
    aiResultCache.set(node.id, {
      status: "error",
      signature: resultSignature,
      error: error.message,
    });
  } finally {
    refreshingAiNodeId = null;
    render();
  }
}

function normalizeAiResult(result = {}) {
  const normalizedResult = result ?? {};
  return {
    title: typeof normalizedResult.title === "string" ? normalizedResult.title.trim() : "",
    docType: typeof normalizedResult.docType === "string" ? normalizedResult.docType.trim() : "本地 HTML",
    url: typeof normalizedResult.url === "string" ? normalizedResult.url.trim() : "",
    path: typeof normalizedResult.path === "string" ? normalizedResult.path.trim() : "",
    error: typeof normalizedResult.error === "string" ? normalizedResult.error.trim() : "",
  };
}

function getAiResultSignature(node, artifact, reason = "") {
  return JSON.stringify({
    resultVersion: "executed-ai-result-v2",
    draftSignature: getDraftOutputSignature(node, artifact, reason),
  });
}

function getPriorityLabel(nodeId, queue) {
  const node = queue.available.find((item) => item.node.id === nodeId)?.node ?? nodes.find((item) => item.id === nodeId);
  if (!node) return "优先级 P2";
  return {
    P0: "P0 · 必须马上做",
    P1: "P1 · 尽早完成",
    P2: "P2 · 其他节点",
  }[node.priority] ?? "P2 · 其他节点";
}

function getQueueRankLabel(nodeId, queue) {
  const index = queue.available.findIndex((item) => item.node.id === nodeId);
  if (index < 0) return "队列位置：未进入";
  return `队列第 ${index + 1} / ${queue.available.length}`;
}

function getPriorityClass(nodeId, queue) {
  const node = queue.available.find((item) => item.node.id === nodeId)?.node ?? nodes.find((item) => item.id === nodeId);
  return `priority-${String(node?.priority ?? "P2").toLowerCase()}`;
}

function renderQueue(queue, currentNodeId) {
  elements.queueChain.replaceChildren(
    ...queue.available.map((item, index) => createQueueCard(item, index, currentNodeId)),
  );
}

function createActionItem(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function createPreparedPoint(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function createPreparedBrief(text) {
  const item = document.createElement("li");
  item.className = "prepared-brief";
  item.textContent = text;
  return item;
}

function updateAiResultLink(state = {}) {
  if (state.status === "idle") {
    clearAutoFilledResultUrl();
    elements.aiResultLink.removeAttribute("href");
    elements.aiResultLink.ariaDisabled = "true";
    elements.aiResultLink.textContent = "AI 结果待生成";
    elements.aiResultLink.title = "点击上方生成按钮后才会生成 AI 结果";
    syncCompleteButtonState();
    return;
  }

  if (state.status === "loading") {
    clearAutoFilledResultUrl();
    elements.aiResultLink.removeAttribute("href");
    elements.aiResultLink.ariaDisabled = "true";
    elements.aiResultLink.textContent = aiAnalyzingText;
    elements.aiResultLink.title = "AI 结果生成中";
    syncCompleteButtonState();
    return;
  }

  if (state.status === "error") {
    clearAutoFilledResultUrl();
    elements.aiResultLink.removeAttribute("href");
    elements.aiResultLink.ariaDisabled = "true";
    elements.aiResultLink.textContent = "AI 结果生成失败";
    elements.aiResultLink.title = state.error || "请查看终端日志后重试。";
    syncCompleteButtonState();
    return;
  }

  const result = state.result ?? currentPreparedArtifact;
  if (!result?.url) {
    clearAutoFilledResultUrl();
    elements.aiResultLink.removeAttribute("href");
    elements.aiResultLink.ariaDisabled = "true";
    elements.aiResultLink.textContent = "AI 结果未生成";
    elements.aiResultLink.title = "AI 结果尚未生成";
    syncCompleteButtonState();
    return;
  }

  elements.aiResultLink.href = result.url;
  elements.aiResultLink.ariaDisabled = "false";
  elements.aiResultLink.textContent = "查看 AI 结果";
  elements.aiResultLink.title = `${result.docType ?? "AI 结果"} · ${result.title}`;
  fillManualResultUrl(result.url);
  syncCompleteButtonState();
}

function fillManualResultUrl(url) {
  if (!url) return;
  const currentValue = elements.manualResultUrl.value.trim();
  if (currentValue && currentValue !== autoFilledResultUrl) return;
  elements.manualResultUrl.value = url;
  autoFilledResultUrl = url;
}

function clearAutoFilledResultUrl() {
  if (autoFilledResultUrl && elements.manualResultUrl.value.trim() === autoFilledResultUrl) {
    elements.manualResultUrl.value = "";
  }
  autoFilledResultUrl = "";
}

function getCompletionUrl() {
  return elements.manualResultUrl.value.trim() || currentPreparedArtifact?.url || "";
}

function syncCompleteButtonState() {
  const hasCurrentTask = Boolean(getCurrentItem(getActiveQueue()));
  const hasResultUrl = Boolean(getCompletionUrl());
  elements.completeButton.disabled = !hasCurrentTask;
  elements.completeButton.title = !hasCurrentTask
    ? "没有可完成的当前任务"
    : hasResultUrl
      ? "完成当前任务并绑定结果链接"
      : "完成当前任务；之后可以手动生成或绑定结果链接";
}

function updateAiConfigDraft() {
  aiConfigDraft = {
    timeoutSeconds: elements.aiTimeoutSeconds.value,
    splitTimeoutSeconds: elements.aiSplitTimeoutSeconds.value,
  };
  aiConfigFeedback = null;
  renderAiConfigPanel();
}

async function saveAiConfig(event) {
  event.preventDefault();
  const timeoutSeconds = readPositiveSeconds(elements.aiTimeoutSeconds.value, "生成超时");
  const splitTimeoutSeconds = readPositiveSeconds(elements.aiSplitTimeoutSeconds.value, "拆分超时");
  if (!timeoutSeconds.ok || !splitTimeoutSeconds.ok) {
    aiConfigFeedback = {
      tone: "error",
      message: timeoutSeconds.error || splitTimeoutSeconds.error,
    };
    renderAiConfigPanel();
    return;
  }

  elements.aiConfigForm.classList.add("is-saving");
  aiConfigFeedback = { tone: "saving", message: "保存中..." };
  renderAiConfigPanel();

  try {
    const payload = await requestJson("/api/ai-config", {
      method: "PUT",
      body: JSON.stringify({
        ai: {
          timeoutMs: timeoutSeconds.value * 1000,
          splitTimeoutMs: splitTimeoutSeconds.value * 1000,
        },
      }),
    });
    projectConfig = normalizeProjectConfig(payload.project);
    aiConfigDraft = null;
    aiConfigFeedback = { tone: "success", message: "已保存到本地配置" };
    clearAiGenerationCaches();
    render();
  } catch (error) {
    console.error("Failed to persist AI config", error);
    aiConfigFeedback = { tone: "error", message: `保存失败：${error.message}` };
    renderAiConfigPanel();
  } finally {
    elements.aiConfigForm.classList.remove("is-saving");
  }
}

function readPositiveSeconds(value, label) {
  const parsedValue = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsedValue) && parsedValue > 0) {
    return { ok: true, value: parsedValue };
  }
  return { ok: false, error: `${label}必须是正整数秒` };
}

function createQueueCard(item, index, currentNodeId) {
  const { node } = item;
  const card = document.createElement("article");
  const priorityClass = `priority-${String(node.priority ?? "P2").toLowerCase()}`;
  card.className = `queue-card ${priorityClass}`;
  card.dataset.priority = node.priority ?? "P2";
  if (node.id === currentNodeId) card.classList.add("is-current");
  if (node.id === selectedNodeId) card.classList.add("is-selected");
  card.style.opacity = `${Math.max(0.74, 1 - index * 0.08)}`;

  const title = document.createElement("h3");
  title.className = "queue-card-title";
  title.textContent = node.title;

  const description = document.createElement("p");
  description.className = "queue-card-description";
  description.textContent = node.description;

  card.append(title, description);
  card.addEventListener("click", () => {
    selectedNodeId = node.id;
    render();
  });

  return card;
}

function completeSelectedTask() {
  const queue = getActiveQueue();
  const current = getCurrentItem(queue);
  if (!current) {
    syncCompleteButtonState();
    return;
  }

  const manualUrl = elements.manualResultUrl.value.trim();
  const preparedUrl = currentPreparedArtifact?.url ?? "";
  const resultUrl = manualUrl || preparedUrl;
  completeTaskWithResult(
    {
      source: manualUrl && manualUrl !== autoFilledResultUrl ? "manual" : resultUrl ? "ai" : "pending-ai",
      url: resultUrl,
      prepared: resultUrl && manualUrl !== resultUrl ? currentPreparedArtifact : null,
    },
    current,
  );
}

function completeTaskWithResult(result, current = getCurrentItem(getActiveQueue())) {
  if (!current) return;

  const completedNodeId = current.node.id;
  const completionResult = normalizeCompletionResult(current.node, result);

  nodes = completeTask(nodes, completedNodeId, completionResult);
  saveNodes();
  selectedNodeId = null;
  selectedTreeNodeId = completedNodeId;
  elements.manualResultUrl.value = "";
  autoFilledResultUrl = "";
  render();
}

function normalizeCompletionResult(node, result = {}) {
  const source = result.source || (result.url ? "manual" : "pending-ai");
  const prepared = result.prepared ?? (source === "ai" ? currentPreparedArtifact : null);
  const isManual = source === "manual";
  const isPending = source === "pending-ai" || !result.url;
  return {
    source,
    url: result.url ?? "",
    title: prepared?.title ?? `${node.title} 结果`,
    docType: prepared?.docType ?? (isManual ? "手动链接" : isPending ? "待补链接" : "AI 结果"),
    description:
      prepared?.description ??
      (isManual
        ? "用户完成任务时绑定的结果链接。"
        : isPending
          ? "任务已完成，尚未绑定结果链接。"
          : "完成任务时生成并绑定的 AI 结果。"),
    path: prepared?.path,
  };
}

function attachAiResultToCompletedTask(nodeId, result = {}) {
  const normalizedResult = normalizeAiResult(result);
  if (!normalizedResult.url) return false;

  let didUpdate = false;
  nodes = nodes.map((node) => {
    if (node.id !== nodeId || node.state !== TASK_STATES.DONE) return node;
    const existingUrl = typeof node.result?.url === "string" ? node.result.url.trim() : "";
    if (existingUrl) return node;

    didUpdate = true;
    return {
      ...node,
      result: normalizeCompletionResult(node, {
        source: "ai",
        url: normalizedResult.url,
        prepared: normalizedResult,
      }),
    };
  });

  if (!didUpdate) return false;
  saveNodes();
  return true;
}

function renderTree() {
  if (!nodes.some((node) => node.id === selectedTreeNodeId)) {
    selectedTreeNodeId = nodes[0]?.id ?? null;
  }

  const scrollContainer = elements.treeMap.parentElement;
  const scrollLeft = scrollContainer?.scrollLeft ?? 0;
  const scrollTop = scrollContainer?.scrollTop ?? 0;
  const previousCardRects = shouldAnimateTreeRender() ? getTreeCardRects() : new Map();
  const focus = getTreeFocus();
  const tree = buildFocusedTree(focus);
  elements.treeMap.replaceChildren(
    ...(tree.length > 0 ? tree.map((node) => createTreeNode(node, focus, 0)) : [createFirstRunPrompt("创建根目标", addRootNode)]),
  );
  renderNodeEditor(focus);

  restoreTreeScrollAfterRender(scrollContainer, scrollLeft, scrollTop);
  animateTreeRender(previousCardRects);
}

function createFirstRunPrompt(actionLabel, onAction) {
  const empty = document.createElement("article");
  empty.className = "empty-state first-run-empty";

  const content = document.createElement("div");
  content.className = "first-run-empty-content";

  const title = document.createElement("h2");
  title.textContent = "还没有目标树";

  const description = document.createElement("p");
  description.textContent = "从一个根目标开始，后续节点状态和 output 都会保存到本地数据层。";

  const button = document.createElement("button");
  button.className = "primary-action";
  button.type = "button";
  button.textContent = actionLabel;
  button.addEventListener("click", onAction);

  content.append(title, description, button);
  empty.append(content);
  return empty;
}

function renderNodeEditor(focus) {
  const selected = focus.selectedId ? focus.index.byId.get(focus.selectedId) : null;
  elements.nodeEditorDrawer.hidden = !isNodeEditorOpen || activeView !== "tree";
  const fields = [
    elements.nodeEditorTitle,
    elements.nodeEditorDescription,
    elements.nodeEditorPriority,
    elements.nodeEditorDependencySearch,
  ];

  if (!isNodeEditorOpen || !selected) {
    elements.nodeEditorHeading.textContent = "未选择节点";
    elements.nodeEditorMeta.textContent = "";
    elements.nodeEditorMeta.hidden = true;
    fields.forEach((field) => {
      field.disabled = true;
    });
    nodeEditorDraft = null;
    renderDependencyOptions(null);
    renderAiSplitButton(null);
    elements.nodeEditorStatus.textContent = "";
    return;
  }

  fields.forEach((field) => {
    field.disabled = false;
  });

  const draft = ensureNodeEditorDraft(selected);

  elements.nodeEditorHeading.textContent = draft.title.trim() || selected.title;
  elements.nodeEditorMeta.textContent = selected.parentId ? "" : "根节点";
  elements.nodeEditorMeta.hidden = Boolean(selected.parentId);
  syncNodeEditorField(elements.nodeEditorTitle, draft.title);
  syncNodeEditorField(elements.nodeEditorDescription, draft.description);
  syncNodeEditorField(elements.nodeEditorPriority, draft.priorityOverride ? draft.priority : "auto");
  renderDependencyOptions(selected);
  renderAiSplitButton(selected, draft);

  const feedback = nodeEditorFeedback?.nodeId === selected.id ? nodeEditorFeedback : null;
  elements.nodeEditorStatus.textContent = feedback?.message ?? "";
  elements.nodeEditorStatus.className = `node-editor-status ${feedback?.tone === "error" ? "is-error" : ""}`;
}

function renderAiSplitButton(selected, draft = null) {
  if (!selected) {
    elements.nodeEditorAiSplit.hidden = true;
    elements.nodeEditorAiSplit.disabled = true;
    return;
  }

  const hasChildren = hasChildNodes(selected.id);
  const isSplitting = splittingNodeIds.has(selected.id);
  const input = {
    title: (draft?.title ?? elements.nodeEditorTitle.value).trim(),
    description: (draft?.description ?? elements.nodeEditorDescription.value).trim(),
  };
  const needsRealInput = !input.title || isPlaceholderInput(input);

  elements.nodeEditorAiSplit.hidden = hasChildren;
  elements.nodeEditorAiSplit.disabled = hasChildren || isSplitting || needsRealInput;
  elements.nodeEditorAiSplit.textContent = isSplitting ? "AI 正在生成子节点" : "AI 生成子节点";
  elements.nodeEditorAiSplit.title = needsRealInput ? "先保存真实标题和描述" : "保存当前节点并生成子节点";
}

function ensureNodeEditorDraft(selected) {
  if (nodeEditorDraft?.nodeId === selected.id) return nodeEditorDraft;
  nodeEditorDraft = {
    nodeId: selected.id,
    title: selected.title,
    description: selected.description,
    priority: selected.priority ?? TASK_PRIORITIES.P2,
    priorityOverride: selected.priorityOverride === true,
  };
  return nodeEditorDraft;
}

function updateNodeEditorDraftFromFields() {
  if (!isNodeEditorOpen || !selectedTreeNodeId) return;
  nodeEditorDraft = {
    nodeId: selectedTreeNodeId,
    title: elements.nodeEditorTitle.value,
    description: elements.nodeEditorDescription.value,
    priority: normalizePriorityInput(elements.nodeEditorPriority.value, TASK_PRIORITIES.P2),
    priorityOverride: elements.nodeEditorPriority.value !== "auto",
  };
}

function normalizePriorityInput(value, fallback = TASK_PRIORITIES.P2) {
  return Object.values(TASK_PRIORITIES).includes(value) ? value : fallback;
}

function syncNodeEditorField(field, value) {
  const nextValue = value ?? "";
  if (document.activeElement === field) return;
  if (field.value !== nextValue) field.value = nextValue;
}

function renderDependencyOptions(selected) {
  if (!selected) {
    nodeEditorDependencyNodeId = null;
    nodeEditorDependencyIds = new Set();
    nodeEditorDependencyQuery = "";
    elements.nodeEditorDependencySearch.value = "";
    elements.nodeEditorDependencySearch.disabled = true;
    elements.nodeEditorDependencyAdd.disabled = true;
    elements.nodeEditorDependencySelected.replaceChildren();
    elements.nodeEditorDependencyOptions.replaceChildren();
    return;
  }

  ensureDependencyDraft(selected);
  elements.nodeEditorDependencySearch.disabled = false;
  syncNodeEditorField(elements.nodeEditorDependencySearch, nodeEditorDependencyQuery);
  const candidateNodes = getCandidateDependencyNodes(selected);
  const selectedNodes = [...nodeEditorDependencyIds]
    .map((nodeId) => nodes.find((node) => node.id === nodeId))
    .filter(Boolean);
  const query = nodeEditorDependencyQuery.trim();
  const optionNodes = getMatchingDependencyNodes(candidateNodes, query).slice(0, 8);
  const dependencyToAdd = findDependencyCandidate(candidateNodes, query);
  elements.nodeEditorDependencyAdd.disabled = !dependencyToAdd;
  elements.nodeEditorDependencyAdd.title = dependencyToAdd ? `添加前置依赖：${dependencyToAdd.title}` : "输入关键词后添加匹配节点";
  renderDependencyOptionsList(optionNodes);

  elements.nodeEditorDependencySelected.replaceChildren(
    ...(selectedNodes.length > 0
      ? selectedNodes.map((node) => createSelectedDependencyItem(node))
      : [createDependencyEmptyState(query ? "还没有添加前置依赖" : "暂无前置依赖")]),
  );
}

function getCandidateDependencyNodes(selected) {
  const blockedIds = new Set([
    selected.id,
    ...getAncestorIds(nodes, selected.id),
    ...getNodeAndDescendantIds(nodes, selected.id),
    ...nodeEditorDependencyIds,
  ]);
  return nodes.filter((node) => !blockedIds.has(node.id));
}

function getMatchingDependencyNodes(candidateNodes, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return candidateNodes;
  return candidateNodes.filter((node) => dependencySearchText(node).includes(normalizedQuery));
}

function findDependencyCandidate(candidateNodes, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return null;
  const matches = getMatchingDependencyNodes(candidateNodes, query);
  return (
    matches.find((node) => node.title.toLowerCase() === normalizedQuery) ??
    matches.find((node) => node.id.toLowerCase() === normalizedQuery) ??
    matches[0] ??
    null
  );
}

function renderDependencyOptionsList(optionNodes) {
  elements.nodeEditorDependencyOptions.replaceChildren(
    ...optionNodes.map((node) => {
      const option = document.createElement("option");
      option.value = node.title;
      option.label = node.description ? `${node.title} · ${node.description}` : node.title;
      return option;
    }),
  );
}

function addDependencyFromSearch() {
  const selected = selectedTreeNodeId ? indexNodes(nodes).byId.get(selectedTreeNodeId) : null;
  if (!selected) return;

  const dependencyToAdd = findDependencyCandidate(getCandidateDependencyNodes(selected), nodeEditorDependencyQuery);
  if (!dependencyToAdd) return;

  nodeEditorDependencyIds.add(dependencyToAdd.id);
  nodeEditorDependencyQuery = "";
  elements.nodeEditorDependencySearch.value = "";
  renderDependencyOptions(selected);
}

function ensureDependencyDraft(selected) {
  if (nodeEditorDependencyNodeId === selected.id) return;
  nodeEditorDependencyNodeId = selected.id;
  nodeEditorDependencyIds = new Set(selected.dependencies);
  nodeEditorDependencyQuery = "";
}

function dependencySearchText(node) {
  return [node.title, node.id, node.description].join(" ").toLowerCase();
}

function createSelectedDependencyItem(node) {
  const item = document.createElement("div");
  item.className = "node-dependency-item is-selected";
  item.role = "listitem";
  item.append(createDependencyTitle(node), createDependencyRemoveButton(node));
  return item;
}

function createDependencyTitle(node) {
  const title = document.createElement("span");
  title.className = "node-dependency-title";
  title.textContent = node.title;
  return title;
}

function createDependencyRemoveButton(node) {
  const button = document.createElement("button");
  button.className = "node-dependency-toggle is-remove";
  button.type = "button";
  button.textContent = "−";
  button.ariaLabel = `移除依赖：${node.title}`;
  button.addEventListener("click", () => {
    nodeEditorDependencyIds.delete(node.id);
    const selectedNode = selectedTreeNodeId ? indexNodes(nodes).byId.get(selectedTreeNodeId) : null;
    renderDependencyOptions(selectedNode);
  });
  return button;
}

function createDependencyEmptyState(text) {
  const empty = document.createElement("div");
  empty.className = "node-dependency-empty";
  empty.textContent = text;
  return empty;
}

function openNodeEditor(nodeId) {
  selectedTreeNodeId = nodeId;
  isNodeEditorOpen = true;
  nodeEditorFeedback = null;
  nodeEditorDraft = null;
  nodeEditorDependencyNodeId = null;
  render();
}

function closeNodeEditor() {
  isNodeEditorOpen = false;
  nodeEditorFeedback = null;
  nodeEditorDraft = null;
  nodeEditorDependencyNodeId = null;
  render();
}

function restoreTreeScrollAfterRender(scrollContainer, scrollLeft, scrollTop) {
  if (!scrollContainer || activeView !== "tree") return;
  scrollContainer.scrollLeft = scrollLeft;
  scrollContainer.scrollTop = scrollTop;
}

function shouldAnimateTreeRender() {
  return activeView === "tree" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getTreeCardRects() {
  return new Map(
    [...elements.treeMap.querySelectorAll(".tree-node-card[data-tree-id]")].map((card) => [
      card.dataset.treeId,
      card.getBoundingClientRect(),
    ]),
  );
}

function animateTreeRender(previousCardRects) {
  if (!shouldAnimateTreeRender() || previousCardRects.size === 0) return;

  requestAnimationFrame(() => {
    for (const card of elements.treeMap.querySelectorAll(".tree-node-card[data-tree-id]")) {
      const previousRect = previousCardRects.get(card.dataset.treeId);
      const currentRect = card.getBoundingClientRect();
      const baseTransform = getComputedStyle(card).transform;
      const settledTransform = baseTransform === "none" ? "none" : baseTransform;

      if (!previousRect) {
        animateNewTreeCard(card, settledTransform);
        continue;
      }

      const deltaX = previousRect.left - currentRect.left;
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const startTransform = appendTreeTransform(`translate(${deltaX}px, ${deltaY}px)`, settledTransform);
      card.animate(
        [
          { opacity: 0.78, transform: startTransform },
          { opacity: 1, transform: settledTransform },
        ],
        treeMotionTiming(320),
      );
    }
  });
}

function animateNewTreeCard(card, settledTransform) {
  const startTransform = appendTreeTransform("translateY(10px) scale(0.985)", settledTransform);
  card.animate(
    [
      { filter: "blur(0.8px)", opacity: 0, transform: startTransform },
      { filter: "blur(0)", opacity: 1, transform: settledTransform },
    ],
    treeMotionTiming(260),
  );
}

function appendTreeTransform(prefix, settledTransform) {
  return settledTransform === "none" ? prefix : `${prefix} ${settledTransform}`;
}

function treeMotionTiming(duration) {
  return {
    duration,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  };
}

function getTreeFocus() {
  const index = indexNodes(nodes);
  const stateById = deriveEffectiveStates(nodes);
  const selectedId = selectedTreeNodeId ?? nodes[0]?.id ?? null;
  const selectedNode = selectedId ? index.byId.get(selectedId) : null;
  const ancestorIds = new Set();
  const descendantIds = new Set();
  const ghostIds = new Set();
  const parentId = selectedNode?.parentId ?? null;
  const directChildren = selectedId ? (index.childrenByParentId.get(selectedId) ?? []) : [];

  if (parentId) {
    ancestorIds.add(parentId);
  }
  for (const child of directChildren) {
    descendantIds.add(child.id);
  }
  if (parentId) {
    for (const sibling of index.childrenByParentId.get(parentId) ?? []) {
      if (sibling.id !== selectedId) {
        ghostIds.add(sibling.id);
      }
    }
  }

  const relatedIds = new Set([selectedId, ...ancestorIds, ...descendantIds].filter(Boolean));
  return { selectedId, parentId, ancestorIds, descendantIds, ghostIds, relatedIds, index, stateById };
}

function buildFocusedTree(focus) {
  const selected = focus.selectedId ? focus.index.byId.get(focus.selectedId) : null;
  if (!selected) return buildTree(nodes);

  const directChildren = (focus.index.childrenByParentId.get(selected.id) ?? []).map((child) =>
    cloneTreeDisplayNode(child, [], focus.index),
  );
  const selectedSlice = cloneTreeDisplayNode(selected, directChildren, focus.index);

  if (!selected.parentId) {
    return [selectedSlice];
  }

  const parent = focus.index.byId.get(selected.parentId);
  if (!parent) return [selectedSlice];

  const parentChildren = (focus.index.childrenByParentId.get(parent.id) ?? []).map((child) =>
    child.id === selected.id ? selectedSlice : cloneTreeDisplayNode(child, [], focus.index, "ghost"),
  );
  return [cloneTreeDisplayNode(parent, parentChildren, focus.index)];
}

function cloneTreeDisplayNode(node, children, index, displayMode = "normal") {
  return {
    ...node,
    children,
    displayMode,
    displayChildCount: (index.childrenByParentId.get(node.id) ?? []).length,
  };
}

function isTreeDragInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest("button, a, input, textarea, select, [contenteditable='true']"));
}

function startTreeNodeDrag(event, nodeId) {
  if (isTreeDragInteractiveTarget(event.target)) {
    event.preventDefault();
    return;
  }

  draggingTreeNodeId = nodeId;
  treeDropTarget = null;
  event.currentTarget.classList.add("is-dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", nodeId);
  }
}

function handleTreeNodeDragOver(event, targetId) {
  if (!draggingTreeNodeId) return;

  const position = getTreeNodeDropPosition(event, event.currentTarget, targetId);
  if (!canMoveTreeNodeTo(draggingTreeNodeId, targetId, position)) return;

  event.preventDefault();
  event.stopPropagation();
  treeDropTarget = { targetId, position };
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  markTreeDropTarget(event.currentTarget, position);
}

function handleTreeNodeDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
  }
}

function dropTreeNode(event, targetId) {
  if (!draggingTreeNodeId) return;

  event.preventDefault();
  event.stopPropagation();
  const draggedId = draggingTreeNodeId;
  const position =
    treeDropTarget?.targetId === targetId
      ? treeDropTarget.position
      : getTreeNodeDropPosition(event, event.currentTarget, targetId);

  finishTreeDrag(event.currentTarget);
  if (!canMoveTreeNodeTo(draggedId, targetId, position)) return;

  runTreeTransition(() => {
    const movedNodes = moveTaskNode(nodes, { nodeId: draggedId, targetId, position });
    if (movedNodes === nodes) return;

    nodes = movedNodes;
    selectedTreeNodeId = draggedId;
    selectedNodeId = null;
    nodeEditorFeedback = null;
    saveNodes();
  });
}

function finishTreeDrag(activeCard = null) {
  activeCard?.classList.remove("is-dragging");
  draggingTreeNodeId = null;
  treeDropTarget = null;
  clearTreeDropTargets();
  for (const card of elements.treeMap.querySelectorAll(".tree-node-card.is-dragging")) {
    card.classList.remove("is-dragging");
  }
}

function clearTreeDropTargets() {
  for (const card of elements.treeMap.querySelectorAll(".tree-node-card.is-drop-before, .tree-node-card.is-drop-after, .tree-node-card.is-drop-inside")) {
    card.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
  }
}

function getTreeNodeDropPosition(event, card, targetId) {
  const targetNode = indexNodes(nodes).byId.get(targetId);
  if (!targetNode?.parentId) return "inside";

  const rect = card.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
  if (ratio < 0.28) return "before";
  if (ratio > 0.72) return "after";
  return "inside";
}

function canMoveTreeNodeTo(nodeId, targetId, position) {
  try {
    const index = indexNodes(nodes);
    const movingNode = index.byId.get(nodeId);
    const targetNode = index.byId.get(targetId);
    if (!movingNode || !targetNode || movingNode.id === targetNode.id) return false;
    if (position !== "inside" && !targetNode.parentId) return false;
    return !getNodeAndDescendantIds(nodes, nodeId).has(targetId);
  } catch {
    return false;
  }
}

function markTreeDropTarget(card, position) {
  clearTreeDropTargets();
  card.classList.add(`is-drop-${position}`);
}

function createTreeNode(node, focus, depth) {
  const wrapper = document.createElement("div");
  const hasChildren = node.children.length > 0;
  const childCount = node.displayChildCount ?? node.children.length;
  const isSelected = node.id === selectedTreeNodeId;
  const isAncestor = focus.ancestorIds.has(node.id);
  const isDescendant = focus.descendantIds.has(node.id);
  const isGhost = node.displayMode === "ghost" || focus.ghostIds.has(node.id);
  const isRelated = focus.relatedIds.has(node.id);
  const effectiveState = focus.stateById.get(node.id) ?? node.state;
  const isDone = effectiveState === TASK_STATES.DONE;
  const linkedRecords = getOutputRecordsForNode(node.id);
  const primaryResultRecord = linkedRecords.find((record) => record.url);
  wrapper.className = [
    "tree-family",
    depth === 0 ? "is-root" : "",
    hasChildren ? "has-children" : "is-leaf",
    node.children.length > 1 ? "has-multiple-children" : "has-one-child",
    isSelected ? "is-selected-family" : "",
    isAncestor ? "is-ancestor-family" : "",
    isDescendant ? "is-descendant-family" : "",
    isGhost ? "is-ghost-family" : "",
    !isRelated && !isGhost ? "is-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const card = document.createElement("article");
  card.className = "tree-node-card";
  card.dataset.treeId = node.id;
  if (isSelected) card.classList.add("is-selected");
  if (isAncestor) card.classList.add("is-ancestor");
  if (isDescendant) card.classList.add("is-descendant");
  if (isGhost) card.classList.add("is-ghost");
  if (!isRelated && !isGhost) card.classList.add("is-dimmed");
  card.classList.add(isDone ? "is-done" : "is-pending");
  card.role = "button";
  card.tabIndex = 0;
  card.ariaPressed = String(isSelected);
  card.draggable = true;
  card.style.viewTransitionName = getTreeTransitionName(node.id);

  const content = document.createElement("div");
  content.className = "tree-node-content";

  const header = document.createElement("div");
  header.className = "tree-node-header";

  const title = document.createElement("span");
  title.className = "tree-node-title";
  title.textContent = node.title;

  const meta = document.createElement("span");
  meta.className = "tree-node-meta";
  meta.textContent = childCount > 0 ? `${childCount} 个子节点` : "叶子行动";

  const priority = document.createElement("span");
  priority.className = `tree-node-priority priority-${String(node.priority ?? "P2").toLowerCase()}`;
  priority.textContent = node.priority ?? "P2";

  const stateToggle = document.createElement("button");
  stateToggle.className = "tree-state-toggle";
  stateToggle.type = "button";
  stateToggle.draggable = false;
  stateToggle.textContent = isDone ? "已完成" : "待完成";
  stateToggle.ariaLabel = `${node.title} 当前状态：${isDone ? "已完成" : "待完成"}，点击切换`;
  stateToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleTreeNodeState(node.id, isDone);
  });

  const detail = document.createElement("span");
  detail.className = "tree-node-detail";
  detail.append(meta, priority, stateToggle);
  if (isDone && primaryResultRecord) {
    detail.append(createTreeResultLink(primaryResultRecord));
  }

  header.append(title);
  content.append(header, detail);
  if (isSelected) {
    const description = document.createElement("p");
    description.className = "tree-node-description";
    description.textContent = node.description;
    content.append(description);

    const records = document.createElement("div");
    records.className = "tree-node-records";
    const label = document.createElement("span");
    label.className = "tree-node-records-label";
    label.textContent = "关联 Output";
    records.append(label);
    if (linkedRecords.length > 0) {
      records.append(...linkedRecords.map(createTreeRecordChip));
    } else {
      const empty = document.createElement("span");
      empty.className = "tree-node-record-empty";
      empty.textContent = "暂无";
      records.append(empty);
    }
    content.append(records);
  }

  const actions = document.createElement("div");
  actions.className = "tree-node-actions";
  actions.append(createTreeActionButton("✎", "编辑节点", () => openNodeEditor(node.id)));
  actions.append(createTreeActionButton("+", "添加子节点", () => addChildNode(node.id)));
  if (node.parentId) {
    actions.append(createTreeActionButton("−", "删除节点", () => deleteTreeNode(node.id), "danger"));
  }

  card.append(content, actions);
  card.addEventListener("click", () => {
    runTreeTransition(() => {
      if (selectedTreeNodeId !== node.id) nodeEditorFeedback = null;
      selectedTreeNodeId = node.id;
    });
  });
  card.addEventListener("dragstart", (event) => startTreeNodeDrag(event, node.id));
  card.addEventListener("dragover", (event) => handleTreeNodeDragOver(event, node.id));
  card.addEventListener("dragleave", handleTreeNodeDragLeave);
  card.addEventListener("drop", (event) => dropTreeNode(event, node.id));
  card.addEventListener("dragend", (event) => finishTreeDrag(event.currentTarget));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      runTreeTransition(() => {
        if (selectedTreeNodeId !== node.id) nodeEditorFeedback = null;
        selectedTreeNodeId = node.id;
      });
    }
  });

  wrapper.append(card);
  if (hasChildren) {
    const children = document.createElement("div");
    children.className = "tree-children";
    children.append(...node.children.map((child) => createTreeNode(child, focus, depth + 1)));
    wrapper.append(children);
  }

  return wrapper;
}

function getTreeTransitionName(nodeId) {
  return `tree-node-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function createTreeRecordChip(record) {
  const chip = record.url ? document.createElement("a") : document.createElement("span");
  chip.className = "tree-record-chip is-artifact";
  chip.textContent = `${record.docType ?? "Output"} · ${record.title}`;
  chip.title = `打开${record.docType ?? "Output"}：${record.title}`;
  if (record.url) {
    chip.href = record.url;
    chip.target = "_blank";
    chip.rel = "noreferrer";
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }
  return chip;
}

function createTreeResultLink(record) {
  const link = document.createElement("a");
  link.className = "tree-node-result-link";
  link.href = record.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "结果";
  link.title = `打开${record.docType ?? "Output"}：${record.title}`;
  link.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  return link;
}

function createTreeActionButton(label, title, onClick, tone = "default") {
  const button = document.createElement("button");
  button.className = `tree-node-action ${tone === "danger" ? "is-danger" : ""}`;
  button.type = "button";
  button.draggable = false;
  button.textContent = label;
  button.title = title;
  button.ariaLabel = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function toggleTreeNodeState(nodeId, isCurrentlyDone) {
  runTreeTransition(() => {
    const update = toggleTaskNodeState(nodes, nodeId, isCurrentlyDone);
    nodes = update.nodes;

    if (selectedNodeId && update.idsToUpdate.has(selectedNodeId) && update.nextState === TASK_STATES.DONE) {
      selectedNodeId = null;
    }

    saveNodes();
  });
}

function addChildNode(parentId) {
  const child = createNode({
    id: `node-${Date.now()}`,
    parentId,
    title: newNodeTitle,
    description: newNodeDescription,
    aiActions: ["明确输入", "做最小动作", "记录判断"],
    state: TASK_STATES.TODO,
    createdFrom: CREATED_FROM.USER,
  });

  runTreeTransition(() => {
    nodes = [...nodes, child];
    selectedTreeNodeId = child.id;
    selectedNodeId = null;
    isNodeEditorOpen = true;
    nodeEditorFeedback = {
      nodeId: child.id,
      tone: "success",
      message: "已添加节点，补充标题和描述后保存",
    };
    saveNodes();
  });
}

function addRootNode() {
  const root = createNode({
    id: `goal-${Date.now()}`,
    title: newRootNodeTitle,
    description: newRootNodeDescription,
    aiActions: ["明确目标", "拆解路径", "记录判断"],
    state: TASK_STATES.TODO,
    createdFrom: CREATED_FROM.USER,
  });

  runTreeTransition(() => {
    nodes = [root];
    selectedTreeNodeId = root.id;
    selectedNodeId = null;
    activeView = "tree";
    isNodeEditorOpen = true;
    nodeEditorFeedback = {
      nodeId: root.id,
      tone: "success",
      message: "已创建根目标，补充标题和描述后保存",
    };
    saveNodes();
  });
}

function deleteTreeNode(nodeId) {
  const update = deleteTaskNode(nodes, nodeId);
  if (!update.parentId) return;

  runTreeTransition(() => {
    nodes = update.nodes;
    selectedTreeNodeId = update.parentId;
    nodeEditorFeedback = { nodeId: update.parentId, tone: "success", message: "已删除节点" };
    if (selectedNodeId && update.deletedIds.has(selectedNodeId)) {
      selectedNodeId = null;
    }
    saveNodes();
  });
}

async function saveNodeEditor(event) {
  event.preventDefault();
  await persistNodeEditorDraft({ splitAfterSave: false });
}

async function splitSelectedNodeWithAi() {
  await persistNodeEditorDraft({ splitAfterSave: true });
}

async function persistNodeEditorDraft({ splitAfterSave = false } = {}) {
  updateNodeEditorDraftFromFields();
  const selectedId = selectedTreeNodeId;
  const selected = selectedId ? indexNodes(nodes).byId.get(selectedId) : null;
  if (!selected) return;

  const title = elements.nodeEditorTitle.value.trim();
  const description = elements.nodeEditorDescription.value.trim();
  const priorityInput = elements.nodeEditorPriority.value;
  const priorityOverride = priorityInput !== "auto";
  const priority = priorityOverride ? normalizePriorityInput(priorityInput) : selected.priority ?? TASK_PRIORITIES.P2;
  const dependencies = [...nodeEditorDependencyIds];
  const shouldSplit = splitAfterSave && !hasChildNodes(selected.id);

  if (!title) {
    showNodeEditorStatus(selected.id, "标题不能为空", "error");
    return;
  }

  try {
    const nextNode = createNode({
      ...selected,
      title,
      description,
      priority,
      priorityOverride,
      dependencies,
    });
    nodes = nodes.map((node) => (node.id === selected.id ? nextNode : node));
    suggestedActionPlanCache.delete(selected.id);
    draftOutputCache.delete(selected.id);
    aiResultCache.delete(selected.id);
    nodeEditorDraft = { nodeId: selected.id, title, description, priority, priorityOverride };
    nodeEditorFeedback = { nodeId: selected.id, tone: "success", message: "正在保存..." };
    render();
    const saveResult = await saveNodes();
    nodeEditorFeedback = {
      nodeId: selected.id,
      tone: saveResult.ok ? "success" : "error",
      message: saveResult.ok
        ? shouldSplit
          ? "已保存，AI 正在生成子节点..."
          : "已保存到本地数据层"
        : formatSaveError(saveResult.error),
    };
    render();

    if (saveResult.ok && shouldSplit) {
      await requestTaskNodeSplit(selected.id);
    }
  } catch (error) {
    showNodeEditorStatus(selected.id, error.message, "error");
  }
}

function isPlaceholderInput(input) {
  return (
    (input.title === newNodeTitle && input.description === newNodeDescription) ||
    (input.title === newRootNodeTitle && input.description === newRootNodeDescription)
  );
}

function hasChildNodes(nodeId) {
  return nodes.some((node) => node.parentId === nodeId);
}

async function requestTaskNodeSplit(nodeId) {
  splittingNodeIds.add(nodeId);
  render();
  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(nodeId)}/split-children`, {
      method: "POST",
    });
    nodes = hydrateNodes(payload.nodes);
    clearAiGenerationCaches();
    splittingNodeIds.delete(nodeId);
    selectedTreeNodeId = nodeId;
    const childCount = Array.isArray(payload.children) ? payload.children.length : 0;
    nodeEditorFeedback = {
      nodeId,
      tone: childCount > 0 ? "success" : "error",
      message: childCount > 0 ? `已生成 ${childCount} 个子节点` : "没有生成可用子节点",
    };
    render();
  } catch (error) {
    console.error("Failed to split task node", error);
    splittingNodeIds.delete(nodeId);
    showNodeEditorStatus(nodeId, `生成子节点失败：${error.message}`, "error");
  }
}

function showNodeEditorStatus(nodeId, message, tone = "success") {
  nodeEditorFeedback = { nodeId, message, tone };
  elements.nodeEditorStatus.textContent = message;
  elements.nodeEditorStatus.className = `node-editor-status ${tone === "error" ? "is-error" : ""}`;
}

function isNodeEditorBackdropEvent(event) {
  if (event.currentTarget !== elements.nodeEditorDrawer) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest(".tree-editor");
}

function rememberNodeEditorBackdropPointer(event) {
  nodeEditorBackdropPointerStarted = isNodeEditorBackdropEvent(event);
}

function closeNodeEditorFromBackdrop(event) {
  if (nodeEditorBackdropPointerStarted && isNodeEditorBackdropEvent(event)) closeNodeEditor();
  nodeEditorBackdropPointerStarted = false;
}

function renderMethods() {
  const completedTaskResults = getCompletedTaskResultRecords();

  elements.intermediateGrid.replaceChildren(...createArtifactCards(completedTaskResults));
  elements.skillGrid.replaceChildren(...createSkillCards(library.skills));
  elements.knowledgeGrid.replaceChildren(...createKnowledgeGroups(library.knowledge));
  renderWorkbenchSectionStates();
}

function renderWorkbenchSectionStates() {
  for (const section of elements.workbenchSections) {
    const sectionName = section.dataset.workbenchSection;
    const isCollapsed = collapsedWorkbenchSections.has(sectionName);
    const content = section.querySelector(".knowledge-grid");
    section.classList.toggle("is-collapsed", isCollapsed);
    section.setAttribute("aria-expanded", String(!isCollapsed));
    if (content) content.hidden = isCollapsed;
  }

  for (const button of elements.workbenchToggles) {
    const sectionName = button.dataset.workbenchToggle;
    const isCollapsed = collapsedWorkbenchSections.has(sectionName);
    const label = getWorkbenchSectionLabel(sectionName);
    const action = isCollapsed ? "展开" : "收起";
    button.setAttribute("aria-expanded", String(!isCollapsed));
    button.setAttribute("aria-label", `${action} ${label}`);
    button.title = `${action} ${label}`;
  }
}

function toggleWorkbenchSection(sectionName) {
  if (!sectionName) return;
  if (collapsedWorkbenchSections.has(sectionName)) {
    collapsedWorkbenchSections.delete(sectionName);
  } else {
    collapsedWorkbenchSections.add(sectionName);
  }
  writeCollapsedWorkbenchSections();
  renderWorkbenchSectionStates();
}

function getWorkbenchSectionLabel(sectionName) {
  return (
    {
      output: "Artifacts",
      skill: "Skill",
      knowledge: "Knowledge",
    }[sectionName] ?? "Section"
  );
}

function readCollapsedWorkbenchSections() {
  try {
    const value = JSON.parse(localStorage.getItem("polaris.collapsedWorkbenchSections") ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeCollapsedWorkbenchSections() {
  try {
    localStorage.setItem("polaris.collapsedWorkbenchSections", JSON.stringify([...collapsedWorkbenchSections]));
  } catch {
    // Ignore storage failures; the in-page state still works.
  }
}

function createArtifactCards(items) {
  if (items.length > 0) return items.map(createArtifactCard);

  const empty = document.createElement("article");
  empty.className = "artifact-card catalog-empty";
  empty.innerHTML = "<h3>还没有产物</h3><p>完成任务并生成或绑定链接后，会出现在这里。</p>";
  return [empty];
}

function createArtifactCard(item) {
  const card = document.createElement("article");
  card.className = "artifact-card method-card output-result-card";

  const header = document.createElement("div");
  header.className = "output-result-header";

  const taskTitle = document.createElement("p");
  taskTitle.className = "output-task-name";
  taskTitle.textContent = item.taskTitle ?? getNodeTitle(item.relatedNodeIds?.[0]);

  const typeTag = document.createElement("span");
  typeTag.className = "output-doc-type";
  typeTag.textContent = getArtifactTypeLabel(item);

  header.append(taskTitle, typeTag);

  const link = document.createElement("a");
  link.className = "output-doc-link";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = getArtifactLinkLabel(item);
  link.title = `打开结果：${item.title}`;

  card.append(header, link);
  return card;
}

function getArtifactLinkLabel(item) {
  const docType = item.docType || "结果文档";
  return `查看${docType}`;
}

function getArtifactTypeLabel(item) {
  const rawType = String(item.docType || item.source || "Link").trim();
  const normalizedType = rawType.toLowerCase();
  if (normalizedType.includes("base")) return "Base";
  if (normalizedType.includes("sheet")) return "Sheet";
  if (normalizedType.includes("html")) return "HTML";
  if (normalizedType.includes("doc")) return "Doc";
  if (normalizedType.includes("link") || normalizedType.includes("链接")) return "Link";
  return rawType.replace(/^飞书\s*/i, "").replace(/^手动\s*/i, "") || "Link";
}

function createSkillCards(items) {
  if (items.length > 0) return items.map((item) => createSkillCard(item, { showType: false }));

  const empty = document.createElement("article");
  empty.className = "catalog-empty";
  empty.innerHTML = "<h3>还没有 Skill</h3><p>在 skills 目录新增 md 文件后重启服务，这里会显示文件名和 description。</p>";
  return [empty];
}

function createSkillCard(item, options = {}) {
  return createEditableIndexCard(item, "skill-card", options);
}

function createKnowledgeGroups(items) {
  const groups = groupItemsByType(items);
  return groups.map(createKnowledgeGroupCard);
}

function groupItemsByType(items) {
  const groups = new Map();
  for (const item of items) {
    const type = item.type || "未分类";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(item);
  }

  return [...groups.entries()].map(([type, groupItems]) => ({
    type,
    items: groupItems,
  }));
}

function createKnowledgeGroupCard(group) {
  const isCollapsed = collapsedKnowledgeGroups.has(group.type);
  const isExpanded = expandedKnowledgeGroups.has(group.type);
  const visibleLimit = 6;
  const visibleItems = isCollapsed ? [] : isExpanded ? group.items : group.items.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, group.items.length - visibleItems.length);

  const cluster = document.createElement("article");
  cluster.className = `knowledge-cluster ${isExpanded ? "is-open" : ""} ${isCollapsed ? "is-collapsed" : ""}`;

  const header = document.createElement("div");
  header.className = "knowledge-cluster-header";
  header.setAttribute("role", "button");
  header.tabIndex = 0;
  header.setAttribute("aria-expanded", String(!isCollapsed));
  header.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    toggleKnowledgeGroupCollapsed(group.type);
  });
  header.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleKnowledgeGroupCollapsed(group.type);
  });

  const heading = document.createElement("div");
  heading.className = "knowledge-cluster-heading";

  const label = document.createElement("span");
  label.className = "knowledge-cluster-label";
  label.textContent = group.type;

  const title = document.createElement("h3");
  title.textContent = getKnowledgeGroupTitle(group);

  heading.append(label, title);

  const summary = document.createElement("p");
  summary.className = "knowledge-cluster-summary";
  summary.textContent = getKnowledgeGroupSummary(group);

  const meta = document.createElement("div");
  meta.className = "knowledge-cluster-meta";

  const count = document.createElement("span");
  count.className = "knowledge-cluster-count";
  count.textContent = `${group.items.length} 条`;
  meta.append(count);

  const collapseToggle = document.createElement("button");
  collapseToggle.className = "knowledge-cluster-collapse";
  collapseToggle.type = "button";
  const collapseLabel = isCollapsed ? `展开 ${group.type}` : `收起 ${group.type}`;
  collapseToggle.setAttribute("aria-label", collapseLabel);
  collapseToggle.title = collapseLabel;
  collapseToggle.setAttribute("aria-expanded", String(!isCollapsed));
  collapseToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleKnowledgeGroupCollapsed(group.type);
  });
  meta.append(collapseToggle);

  if (!isCollapsed && group.items.length > visibleLimit) {
    const toggle = document.createElement("button");
    toggle.className = "knowledge-cluster-toggle";
    toggle.type = "button";
    toggle.textContent = isExpanded ? "收起" : `展开 ${hiddenCount} 条`;
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleKnowledgeGroup(group.type);
    });
    meta.append(toggle);
  }

  header.append(heading, summary, meta);

  const list = document.createElement("div");
  list.className = "knowledge-entry-list";
  list.hidden = isCollapsed;
  list.replaceChildren(...visibleItems.map((item) => createKnowledgeCard(item)));

  cluster.append(header, list);
  return cluster;
}

function getKnowledgeGroupTitle(group) {
  return group.items[0]?.sourceDescription || `${group.type} 知识条目`;
}

function getKnowledgeGroupSummary(group) {
  const datedCount = group.items.filter((item) => item.date).length;
  const paths = new Set(group.items.map((item) => item.path).filter(Boolean));
  return `${datedCount || group.items.length} 条可复用判断 · ${paths.size || 1} 个来源`;
}

function createCatalogGroupCard(group, options) {
  const groupCard = document.createElement("article");
  const densityClass = group.items.length >= 3 ? "is-large" : group.items.length === 1 ? "is-single" : "is-medium";
  groupCard.className = [
    "catalog-group",
    options.groupClassName,
    densityClass,
    options.summaryMode ? "is-summary" : "",
    options.expanded ? "is-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const header = document.createElement("div");
  header.className = "catalog-group-header";

  const heading = document.createElement("div");
  const label = document.createElement("span");
  label.className = "catalog-label";
  label.textContent = options.label;

  heading.append(label);

  if (!options.summaryMode && options.showTitle !== false) {
    const title = document.createElement("h3");
    title.textContent = group.type;
    heading.append(title);
  }

  const count = document.createElement("span");
  count.className = "catalog-count";
  count.textContent = `${group.items.length} 条`;

  header.append(heading, count);

  const list = document.createElement("div");
  list.className = `catalog-list ${options.summaryMode ? "catalog-detail-list" : ""}`.trim();
  list.hidden = options.summaryMode && !options.expanded;
  list.replaceChildren(...group.items.map(options.createItem));

  groupCard.append(header, list);

  if (options.summaryMode) {
    groupCard.role = "button";
    groupCard.tabIndex = 0;
    groupCard.ariaExpanded = String(options.expanded);
    groupCard.addEventListener("click", (event) => {
      if (event.target.closest(".method-card")) return;
      options.onToggle();
    });
    groupCard.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      options.onToggle();
    });
  }

  return groupCard;
}

function toggleKnowledgeGroup(groupType) {
  if (expandedKnowledgeGroups.has(groupType)) {
    expandedKnowledgeGroups.delete(groupType);
  } else {
    expandedKnowledgeGroups.add(groupType);
  }
  renderMethods();
}

function toggleKnowledgeGroupCollapsed(groupType) {
  if (collapsedKnowledgeGroups.has(groupType)) {
    collapsedKnowledgeGroups.delete(groupType);
  } else {
    collapsedKnowledgeGroups.add(groupType);
  }
  renderMethods();
}

function createKnowledgeCard(item, options = {}) {
  const knowledgeTitle = item.brief || item.title || "未命名知识";
  const card = document.createElement("article");
  card.className = "knowledge-row method-card is-md-file";
  card.role = "button";
  card.tabIndex = 0;
  card.setAttribute("aria-label", `打开知识详情：${knowledgeTitle}`);

  const date = document.createElement("small");
  date.className = "knowledge-row-date";
  date.textContent = item.date || item.type;

  const body = document.createElement("div");
  body.className = "knowledge-row-body";

  const title = document.createElement("h3");
  title.textContent = knowledgeTitle;

  body.append(title);
  card.append(date, body);
  card.addEventListener("click", () => openMarkdownEditor(item));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMarkdownEditor(item);
    }
  });
  return card;
}

function createEditableIndexCard(item, className, options = {}) {
  const card = document.createElement("article");
  card.className = `method-card index-card ${className} is-md-file`;
  card.role = "button";
  card.tabIndex = 0;

  const type = document.createElement("small");
  type.textContent = options.metaText ? options.metaText(item) : item.type;

  const title = document.createElement("h3");
  title.textContent = item.title;

  const heading = document.createElement("div");
  heading.className = "index-card-heading";
  if (options.showType !== false) heading.append(type);
  heading.append(title);

  const description = document.createElement("p");
  description.textContent = item.description;

  card.append(heading, description);
  card.addEventListener("click", () => openMarkdownEditor(item));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMarkdownEditor(item);
    }
  });
  return card;
}

function openMarkdownEditor(item) {
  editingMarkdownItem = item;
  elements.markdownEditorTitle.textContent = item.brief || item.title;
  elements.markdownEditorPath.textContent = formatMarkdownEditorPath(item);
  elements.markdownEditorTextarea.value = item.markdown;
  elements.markdownEditor.hidden = false;
  requestAnimationFrame(() => focusMarkdownEntry(item));
}

function formatMarkdownEditorPath(item) {
  return [item.type, item.date, item.path].filter(Boolean).join(" · ");
}

function focusMarkdownEntry(item) {
  const range = findMarkdownEntryHeadingRange(item.markdown, item);
  elements.markdownEditorTextarea.focus();
  if (!range) return;

  elements.markdownEditorTextarea.setSelectionRange(range.start, range.end);
  const lineNumber = item.markdown.slice(0, range.start).split(/\r?\n/).length;
  const lineHeight = Number.parseFloat(getComputedStyle(elements.markdownEditorTextarea).lineHeight) || 22;
  elements.markdownEditorTextarea.scrollTop = Math.max(0, (lineNumber - 4) * lineHeight);
}

function findMarkdownEntryHeadingRange(markdown, item) {
  if (typeof markdown !== "string" || !markdown) return null;
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  if (headings.length === 0) return null;

  const entryIndex = getMarkdownEntryIndex(item);
  const match = Number.isInteger(entryIndex) ? headings[entryIndex] : findMarkdownHeadingByDate(headings, item.date);
  if (!match) return null;

  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function getMarkdownEntryIndex(item) {
  const match = String(item.id ?? "").match(/-(\d+)-[a-f0-9]{8}$/);
  if (!match) return null;
  return Number(match[1]) - 1;
}

function findMarkdownHeadingByDate(headings, date) {
  if (!date) return null;
  return headings.find((match) => match[1].trim() === date) ?? null;
}

function closeMarkdownEditor() {
  editingMarkdownItem = null;
  elements.markdownEditor.hidden = true;
}

async function saveMarkdownEditor() {
  if (!editingMarkdownItem) return;
  const markdown = elements.markdownEditorTextarea.value;
  try {
    const data = await requestJson(
      `/api/library/${encodeURIComponent(editingMarkdownItem.kind)}/${encodeURIComponent(editingMarkdownItem.id)}/markdown`,
      {
        method: "PUT",
        body: JSON.stringify({ markdown }),
      },
    );
    Object.assign(editingMarkdownItem, data.item);
    elements.markdownEditorPath.textContent = `${editingMarkdownItem.path} · 已保存`;
    clearAiGenerationCaches();
    render();
  } catch (error) {
    console.error("Failed to persist markdown", error);
    elements.markdownEditorPath.textContent = `${editingMarkdownItem.path} · 保存失败`;
  }
}

elements.viewButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.viewButton;
    render();
  });
});
elements.completeButton.addEventListener("click", completeSelectedTask);
elements.refreshAiButton.addEventListener("click", refreshCurrentAiResult);
elements.aiConfigForm.addEventListener("submit", saveAiConfig);
elements.aiTimeoutSeconds.addEventListener("input", updateAiConfigDraft);
elements.aiSplitTimeoutSeconds.addEventListener("input", updateAiConfigDraft);
elements.nodeEditorForm.addEventListener("submit", saveNodeEditor);
elements.nodeEditorAiSplit.addEventListener("click", splitSelectedNodeWithAi);
elements.nodeEditorTitle.addEventListener("input", updateNodeEditorDraftFromFields);
elements.nodeEditorDescription.addEventListener("input", updateNodeEditorDraftFromFields);
elements.nodeEditorPriority.addEventListener("change", updateNodeEditorDraftFromFields);
elements.nodeEditorDependencyAdd.addEventListener("click", addDependencyFromSearch);
elements.nodeEditorDependencySearch.addEventListener("input", () => {
  nodeEditorDependencyQuery = elements.nodeEditorDependencySearch.value;
  const selected = selectedTreeNodeId ? indexNodes(nodes).byId.get(selectedTreeNodeId) : null;
  renderDependencyOptions(selected);
});
elements.nodeEditorDependencySearch.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addDependencyFromSearch();
});
elements.nodeEditorClose.addEventListener("click", closeNodeEditor);
elements.nodeEditorDrawer.addEventListener("pointerdown", rememberNodeEditorBackdropPointer);
elements.nodeEditorDrawer.addEventListener("click", closeNodeEditorFromBackdrop);
elements.manualResultUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    completeSelectedTask();
  }
});
elements.manualResultUrl.addEventListener("input", syncCompleteButtonState);
elements.markdownEditorClose.addEventListener("click", closeMarkdownEditor);
elements.markdownEditorSave.addEventListener("click", saveMarkdownEditor);
elements.markdownEditor.addEventListener("click", (event) => {
  if (event.target === elements.markdownEditor) closeMarkdownEditor();
});
elements.workbenchToggles.forEach((button) => {
  button.addEventListener("click", () => toggleWorkbenchSection(button.dataset.workbenchToggle));
});

init();
