import {
  CREATED_FROM,
  TASK_STATES,
  TASK_TAGS,
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
  resolvePreparedArtifact,
  toggleTaskNodeState,
} from "/src/app-logic.js";

let nodes = [];
let library = { knowledge: [], skills: [], artifacts: [] };
let selectedNodeId = null;
let selectedTreeNodeId = null;
let activeView = "today";
let editingMarkdownItem = null;
let currentPreparedArtifact = null;
const expandedKnowledgeGroups = new Set();
let nodeEditorFeedback = null;
let isNodeEditorOpen = false;
const suggestedActionPlanCache = new Map();
const draftOutputCache = new Map();

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
  actionPlanSummary: document.querySelector("#action-plan-summary"),
  actionPlanSteps: document.querySelector("#action-plan-steps"),
  preparedResultTitle: document.querySelector("#prepared-result-title"),
  preparedResultSummary: document.querySelector("#prepared-result-summary"),
  preparedResultPoints: document.querySelector("#prepared-result-points"),
  queueChain: document.querySelector("#queue-chain"),
  aiResultLink: document.querySelector("#ai-result-link"),
  completeButton: document.querySelector("#complete-button"),
  manualResultUrl: document.querySelector("#manual-result-url"),
  treeMap: document.querySelector("#tree-map"),
  nodeEditorDrawer: document.querySelector("#node-editor-drawer"),
  nodeEditorForm: document.querySelector("#node-editor-form"),
  nodeEditorHeading: document.querySelector("#node-editor-heading"),
  nodeEditorMeta: document.querySelector("#node-editor-meta"),
  nodeEditorTitle: document.querySelector("#node-editor-title"),
  nodeEditorDescription: document.querySelector("#node-editor-description"),
  nodeEditorTag: document.querySelector("#node-editor-tag"),
  nodeEditorState: document.querySelector("#node-editor-state"),
  nodeEditorActions: document.querySelector("#node-editor-actions"),
  nodeEditorDependencies: document.querySelector("#node-editor-dependencies"),
  nodeEditorReset: document.querySelector("#node-editor-reset"),
  nodeEditorStatus: document.querySelector("#node-editor-status"),
  nodeEditorClose: document.querySelector("#node-editor-close"),
  knowledgeGrid: document.querySelector("#knowledge-grid"),
  skillGrid: document.querySelector("#skill-grid"),
  intermediateGrid: document.querySelector("#intermediate-grid"),
  markdownEditor: document.querySelector("#markdown-editor"),
  markdownEditorTitle: document.querySelector("#markdown-editor-title"),
  markdownEditorPath: document.querySelector("#markdown-editor-path"),
  markdownEditorTextarea: document.querySelector("#markdown-editor-textarea"),
  markdownEditorClose: document.querySelector("#markdown-editor-close"),
  markdownEditorSave: document.querySelector("#markdown-editor-save"),
};

async function loadAppData() {
  const data = await requestJson("/api/bootstrap");
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

async function saveNodes() {
  try {
    await requestJson("/api/task-nodes", {
      method: "PUT",
      body: JSON.stringify({ nodes }),
    });
    return true;
  } catch (error) {
    console.error("Failed to persist task nodes", error);
    return false;
  }
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
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return payload;
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

function renderView() {
  for (const [viewName, view] of Object.entries(elements.views)) {
    view.classList.toggle("is-active", viewName === activeView);
  }
  for (const button of elements.viewButtons) {
    button.classList.toggle("is-active", button.dataset.viewButton === activeView);
  }
}

function renderEmptyState() {
  elements.currentTitle.textContent = "今天的叶子任务都完成了";
  elements.currentSummary.textContent = "可以回到目标树继续拆分，或者复盘刚才完成的判断。";
  elements.currentPriority.textContent = "队列已清空";
  elements.currentPriority.className = "node-chip muted";
  elements.currentRank.textContent = "队列位置：无";
  elements.actionPlanSummary.textContent = "队列已经清空，下一步应该让目标树继续产生可执行动作。";
  elements.actionPlanSteps.replaceChildren(...["复盘完成内容", "补充判断结论", "拆出下一批行动"].map(createActionItem));
  elements.preparedResultTitle.textContent = "Feishu Doc";
  elements.preparedResultSummary.textContent = "AI 会把已完成的判断和产物整理回知识库，作为后续节点的输入。";
  elements.preparedResultPoints.replaceChildren(...["整理已完成节点", "补齐判断结论", "生成下一批任务输入"].map(createPreparedPoint));
  currentPreparedArtifact = {
    docType: "飞书 Doc",
    title: "今日复盘草稿",
    url: "https://example.feishu.cn/docx/daily-review",
  };
  updateAiResultLink();
  elements.queueChain.innerHTML = '<div class="empty-state">没有可执行叶子节点</div>';
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
  renderSuggestedActionPlan(node, reason);
  renderDraftOutput(node);
}

function renderSuggestedActionPlan(node, reason) {
  const signature = getSuggestedActionPlanSignature(node, reason);
  const cached = suggestedActionPlanCache.get(node.id);

  if (cached?.signature === signature && cached.status === "ready") {
    renderActionPlan(cached.plan);
    return;
  }

  renderActionPlan({ summary: "", steps: [] });
  if (cached?.signature === signature && cached.status === "loading") return;
  requestSuggestedActionPlan(node, signature);
}

async function requestSuggestedActionPlan(node, signature) {
  suggestedActionPlanCache.set(node.id, { status: "loading", signature });

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/suggested-action-plan`, {
      method: "POST",
    });
    suggestedActionPlanCache.set(node.id, {
      status: "ready",
      signature,
      plan: normalizeSuggestedActionPlan(payload.plan),
    });
  } catch (error) {
    console.error("Failed to generate suggested action plan", error);
    suggestedActionPlanCache.set(node.id, {
      status: "ready",
      signature,
      plan: { summary: "", steps: [] },
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
  };
}

function getSuggestedActionPlanSignature(node, reason) {
  return JSON.stringify({
    id: node.id,
    title: node.title,
    tag: node.tag,
    description: node.description,
    dependencies: node.dependencies,
    state: node.state,
    reason,
  });
}

function renderDraftOutput(node) {
  const artifact = resolvePreparedArtifact(node, library.artifacts);
  const signature = getDraftOutputSignature(node, artifact);
  const cached = draftOutputCache.get(node.id);
  currentPreparedArtifact = artifact;
  updateAiResultLink();

  if (cached?.signature === signature && cached.status === "ready") {
    renderDraftOutputContent(cached.output);
    return;
  }

  renderDraftOutputContent({ title: "", summary: "", points: [] });
  if (cached?.signature === signature && cached.status === "loading") return;
  requestDraftOutput(node, signature);
}

async function requestDraftOutput(node, signature) {
  draftOutputCache.set(node.id, { status: "loading", signature });

  try {
    const payload = await requestJson(`/api/task-nodes/${encodeURIComponent(node.id)}/draft-output`, {
      method: "POST",
    });
    draftOutputCache.set(node.id, {
      status: "ready",
      signature,
      output: normalizeDraftOutput(payload.output),
    });
  } catch (error) {
    console.error("Failed to generate draft output", error);
    draftOutputCache.set(node.id, {
      status: "ready",
      signature,
      output: { title: "", summary: "", points: [] },
    });
  }

  render();
}

function renderDraftOutputContent(output) {
  elements.preparedResultTitle.textContent = output.title;
  elements.preparedResultSummary.textContent = output.summary;
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
    points,
  };
}

function getDraftOutputSignature(node, artifact) {
  return JSON.stringify({
    id: node.id,
    title: node.title,
    tag: node.tag,
    description: node.description,
    dependencies: node.dependencies,
    state: node.state,
    artifactTitle: artifact?.title ?? "",
    artifactType: artifact?.docType ?? "",
  });
}

function getPriorityLabel(nodeId, queue) {
  const index = queue.available.findIndex((item) => item.node.id === nodeId);
  if (index < 0) return "候选任务";
  return index === 0 ? "优先级 P1 · 当前推荐" : `优先级 P${index + 1}`;
}

function getQueueRankLabel(nodeId, queue) {
  const index = queue.available.findIndex((item) => item.node.id === nodeId);
  if (index < 0) return "队列位置：未进入";
  return `队列第 ${index + 1} / ${queue.available.length}`;
}

function getPriorityClass(nodeId, queue) {
  const index = queue.available.findIndex((item) => item.node.id === nodeId);
  if (index <= 0) return "priority-p1";
  if (index === 1) return "priority-p2";
  return "priority-p3";
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

function updateAiResultLink() {
  if (!currentPreparedArtifact?.url) {
    elements.aiResultLink.removeAttribute("href");
    elements.aiResultLink.ariaDisabled = "true";
    elements.aiResultLink.textContent = "AI 结果未生成";
    return;
  }

  elements.aiResultLink.href = currentPreparedArtifact.url;
  elements.aiResultLink.ariaDisabled = "false";
  elements.aiResultLink.textContent = "查看 AI 结果";
  elements.aiResultLink.title = `${currentPreparedArtifact.docType ?? "AI 结果"} · ${currentPreparedArtifact.title}`;
}

function createQueueCard(item, index, currentNodeId) {
  const { node, reason } = item;
  const card = document.createElement("article");
  const priorityClass = index === 0 ? "priority-p1" : index === 1 ? "priority-p2" : "priority-p3";
  card.className = `queue-card ${priorityClass}`;
  card.dataset.priority = index < 9 ? `P${index + 1}` : "P9+";
  if (node.id === currentNodeId) card.classList.add("is-current");
  if (node.id === selectedNodeId) card.classList.add("is-selected");
  card.style.opacity = `${Math.max(0.74, 1 - index * 0.08)}`;

  const title = document.createElement("h3");
  title.textContent = node.title;

  const description = document.createElement("p");
  description.textContent = node.description;

  const capsule = document.createElement("div");
  capsule.className = "queue-capsule";
  capsule.innerHTML = `<div><strong>为什么：</strong>${reason}</div><div><strong>下一步：</strong>${node.aiActions[0]}</div>`;

  card.append(title, description, capsule);
  card.addEventListener("click", () => {
    selectedNodeId = node.id;
    render();
  });

  return card;
}

function completeSelectedTask() {
  const manualUrl = elements.manualResultUrl.value.trim();
  completeTaskWithResult({
    source: manualUrl ? "manual" : "ai",
    url: manualUrl || currentPreparedArtifact?.url || "",
  });
}

function completeTaskWithResult(result) {
  const queue = getActiveQueue();
  const current = getCurrentItem(queue);
  if (!current) return;

  nodes = completeTask(nodes, current.node.id, result);
  saveNodes();
  selectedNodeId = null;
  elements.manualResultUrl.value = "";
  render();
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
  elements.treeMap.replaceChildren(...tree.map((node) => createTreeNode(node, focus, 0)));
  renderNodeEditor(focus);

  restoreTreeScrollAfterRender(scrollContainer, scrollLeft, scrollTop);
  animateTreeRender(previousCardRects);
}

function renderNodeEditor(focus) {
  const selected = focus.selectedId ? focus.index.byId.get(focus.selectedId) : null;
  elements.nodeEditorDrawer.hidden = !isNodeEditorOpen || activeView !== "tree";
  const fields = [
    elements.nodeEditorTitle,
    elements.nodeEditorDescription,
    elements.nodeEditorTag,
    elements.nodeEditorState,
    elements.nodeEditorActions,
    elements.nodeEditorDependencies,
    elements.nodeEditorReset,
  ];

  if (!isNodeEditorOpen || !selected) {
    elements.nodeEditorHeading.textContent = "未选择节点";
    elements.nodeEditorMeta.textContent = "";
    fields.forEach((field) => {
      field.disabled = true;
    });
    elements.nodeEditorStatus.textContent = "";
    return;
  }

  fields.forEach((field) => {
    field.disabled = false;
  });

  elements.nodeEditorHeading.textContent = selected.title;
  elements.nodeEditorMeta.textContent = selected.parentId ? `ID · ${selected.id}` : "根节点";
  elements.nodeEditorTitle.value = selected.title;
  elements.nodeEditorDescription.value = selected.description;
  renderSelectOptions(elements.nodeEditorTag, Object.values(TASK_TAGS), selected.tag);
  renderSelectOptions(elements.nodeEditorState, Object.values(TASK_STATES), selected.state);
  elements.nodeEditorActions.value = selected.aiActions.join("\n");
  renderDependencyOptions(selected);

  const feedback = nodeEditorFeedback?.nodeId === selected.id ? nodeEditorFeedback : null;
  elements.nodeEditorStatus.textContent = feedback?.message ?? "";
  elements.nodeEditorStatus.className = `node-editor-status ${feedback?.tone === "error" ? "is-error" : ""}`;
}

function renderSelectOptions(select, values, selectedValue) {
  select.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = value === selectedValue;
      return option;
    }),
  );
}

function renderDependencyOptions(selected) {
  const blockedIds = new Set([
    selected.id,
    ...getAncestorIds(nodes, selected.id),
    ...getNodeAndDescendantIds(nodes, selected.id),
  ]);
  const selectedDependencies = new Set(selected.dependencies);
  const options = nodes
    .filter((node) => !blockedIds.has(node.id))
    .map((node) => {
      const option = document.createElement("option");
      option.value = node.id;
      option.textContent = node.title;
      option.selected = selectedDependencies.has(node.id);
      return option;
    });

  elements.nodeEditorDependencies.replaceChildren(...options);
}

function openNodeEditor(nodeId) {
  selectedTreeNodeId = nodeId;
  isNodeEditorOpen = true;
  nodeEditorFeedback = null;
  render();
}

function closeNodeEditor() {
  isNodeEditorOpen = false;
  nodeEditorFeedback = null;
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
  const linkedRecords = getRecordsForNode(node.id);
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

  const stateToggle = document.createElement("button");
  stateToggle.className = "tree-state-toggle";
  stateToggle.type = "button";
  stateToggle.textContent = isDone ? "已完成" : "待完成";
  stateToggle.ariaLabel = `${node.title} 当前状态：${isDone ? "已完成" : "待完成"}，点击切换`;
  stateToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleTreeNodeState(node.id, isDone);
  });

  const detail = document.createElement("span");
  detail.className = "tree-node-detail";
  detail.append(meta, stateToggle);

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

function createTreeActionButton(label, title, onClick, tone = "default") {
  const button = document.createElement("button");
  button.className = `tree-node-action ${tone === "danger" ? "is-danger" : ""}`;
  button.type = "button";
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
    title: "新的行动节点",
    tag: TASK_TAGS.THINK,
    description: "写清楚这个节点要推进什么。",
    aiActions: ["明确输入", "做最小动作", "记录判断"],
    state: TASK_STATES.TODO,
    createdFrom: CREATED_FROM.USER,
  });

  runTreeTransition(() => {
    nodes = [...nodes, child];
    selectedTreeNodeId = child.id;
    selectedNodeId = null;
    nodeEditorFeedback = { nodeId: child.id, tone: "success", message: "已添加子节点" };
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
  const selectedId = selectedTreeNodeId;
  const selected = selectedId ? indexNodes(nodes).byId.get(selectedId) : null;
  if (!selected) return;

  const title = elements.nodeEditorTitle.value.trim();
  const aiActions = parseActionLines(elements.nodeEditorActions.value);
  const dependencies = [...elements.nodeEditorDependencies.selectedOptions].map((option) => option.value);

  if (!title) {
    showNodeEditorStatus(selected.id, "标题不能为空", "error");
    return;
  }

  if (aiActions.length === 0) {
    showNodeEditorStatus(selected.id, "行动列表不能为空", "error");
    return;
  }

  try {
    const nextNode = createNode({
      ...selected,
      title,
      description: elements.nodeEditorDescription.value.trim(),
      tag: elements.nodeEditorTag.value,
      state: elements.nodeEditorState.value,
      aiActions,
      dependencies,
    });
    nodes = nodes.map((node) => (node.id === selected.id ? nextNode : node));
    suggestedActionPlanCache.delete(selected.id);
    draftOutputCache.delete(selected.id);
    nodeEditorFeedback = { nodeId: selected.id, tone: "success", message: "正在保存..." };
    render();
    const saved = await saveNodes();
    nodeEditorFeedback = {
      nodeId: selected.id,
      tone: saved ? "success" : "error",
      message: saved ? "已保存到本地数据层" : "保存失败，请查看终端日志",
    };
    render();
  } catch (error) {
    showNodeEditorStatus(selected.id, error.message, "error");
  }
}

function parseActionLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resetNodeEditor() {
  nodeEditorFeedback = selectedTreeNodeId
    ? { nodeId: selectedTreeNodeId, tone: "success", message: "已重置表单" }
    : null;
  renderTree();
}

function showNodeEditorStatus(nodeId, message, tone = "success") {
  nodeEditorFeedback = { nodeId, message, tone };
  elements.nodeEditorStatus.textContent = message;
  elements.nodeEditorStatus.className = `node-editor-status ${tone === "error" ? "is-error" : ""}`;
}

function closeNodeEditorFromBackdrop(event) {
  if (event.target === elements.nodeEditorDrawer) closeNodeEditor();
}

function renderMethods() {
  const queue = getActiveQueue();
  const current = getCurrentItem(queue);
  const currentArtifacts = current
    ? library.artifacts.filter((item) => item.relatedNodeIds?.includes(current.node.id))
    : library.artifacts;

  elements.intermediateGrid.replaceChildren(...createArtifactCards(currentArtifacts));
  elements.skillGrid.replaceChildren(...createSkillGroups(library.skills));
  elements.knowledgeGrid.replaceChildren(...createKnowledgeGroups(library.knowledge));
}

function createArtifactCards(items) {
  if (items.length > 0) return items.map(createArtifactCard);

  const empty = document.createElement("article");
  empty.className = "artifact-card catalog-empty";
  empty.innerHTML = "<h3>当前节点还没有产物</h3><p>完成任务时绑定飞书 Doc / Base 链接后，会出现在这里。</p>";
  return [empty];
}

function createArtifactCard(item) {
  const card = document.createElement("article");
  card.className = "artifact-card method-card is-feishu-artifact";

  const type = document.createElement("small");
  type.textContent = item.docType;

  const title = document.createElement("h3");
  title.textContent = item.title;

  const description = document.createElement("p");
  description.textContent = item.description;

  const relation = document.createElement("div");
  relation.className = "record-node-links artifact-task-links";
  const relationLabel = document.createElement("span");
  relationLabel.className = "record-node-links-label";
  relationLabel.textContent = "相关任务";
  relation.append(relationLabel);
  for (const nodeId of item.relatedNodeIds ?? []) {
    const nodeChip = document.createElement("button");
    nodeChip.className = "record-node-chip";
    nodeChip.type = "button";
    nodeChip.textContent = getNodeTitle(nodeId);
    nodeChip.title = getNodeTitle(nodeId);
    nodeChip.addEventListener("click", (event) => {
      event.stopPropagation();
      selectTreeNode(nodeId);
    });
    relation.append(nodeChip);
  }

  const meta = document.createElement("a");
  meta.className = "method-card-link";
  meta.href = item.url;
  meta.target = "_blank";
  meta.rel = "noreferrer";
  meta.textContent = "打开飞书链接";

  card.append(type, title, description, relation, meta);
  return card;
}

function createSkillGroups(items) {
  const groups = groupItemsByType(items);
  return groups.map(createSkillGroupCard);
}

function createSkillGroupCard(group) {
  return createCatalogGroupCard(group, {
    groupClassName: "skill-catalog-group",
    label: group.type,
    showTitle: false,
    createItem: (item) => createSkillCard(item, { showType: false }),
  });
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
  return createCatalogGroupCard(group, {
    groupClassName: "knowledge-catalog-group",
    label: group.type,
    summaryMode: true,
    expanded: expandedKnowledgeGroups.has(group.type),
    getBrief: getKnowledgeGroupBrief,
    onToggle: () => toggleKnowledgeGroup(group.type),
    createItem: (item) => createKnowledgeCard(item, { showType: false }),
  });
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

  if (options.summaryMode) {
    const brief = document.createElement("p");
    brief.className = "catalog-brief";
    brief.textContent = options.getBrief(group);
    heading.append(brief);
  } else if (options.showTitle !== false) {
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

function getKnowledgeGroupBrief(group) {
  if (group.items.length === 1) return group.items[0].description;

  const titles = group.items.map((item) => item.title).join("、");
  return `${group.items.length} 条${group.type}知识：${titles}。`;
}

function toggleKnowledgeGroup(groupType) {
  if (expandedKnowledgeGroups.has(groupType)) {
    expandedKnowledgeGroups.delete(groupType);
  } else {
    expandedKnowledgeGroups.add(groupType);
  }
  renderMethods();
}

function createKnowledgeCard(item, options = {}) {
  return createEditableIndexCard(item, "knowledge-card", options);
}

function createEditableIndexCard(item, className, options = {}) {
  const card = document.createElement("article");
  card.className = `method-card index-card ${className} is-md-file`;
  card.role = "button";
  card.tabIndex = 0;

  const type = document.createElement("small");
  type.textContent = item.type;

  const title = document.createElement("h3");
  title.textContent = item.title;

  const description = document.createElement("p");
  description.textContent = item.description;

  const content = [title, description];
  if (options.showType !== false) content.unshift(type);
  card.append(...content);
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
  elements.markdownEditorTitle.textContent = item.title;
  elements.markdownEditorPath.textContent = item.path;
  elements.markdownEditorTextarea.value = item.markdown;
  elements.markdownEditor.hidden = false;
  elements.markdownEditorTextarea.focus();
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
elements.nodeEditorForm.addEventListener("submit", saveNodeEditor);
elements.nodeEditorReset.addEventListener("click", resetNodeEditor);
elements.nodeEditorClose.addEventListener("click", closeNodeEditor);
elements.nodeEditorDrawer.addEventListener("click", closeNodeEditorFromBackdrop);
elements.manualResultUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    completeSelectedTask();
  }
});
elements.markdownEditorClose.addEventListener("click", closeMarkdownEditor);
elements.markdownEditorSave.addEventListener("click", saveMarkdownEditor);
elements.markdownEditor.addEventListener("click", (event) => {
  if (event.target === elements.markdownEditor) closeMarkdownEditor();
});

init();
