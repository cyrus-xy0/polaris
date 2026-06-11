import { TASK_PRIORITIES, TASK_STATES, buildExecutableQueue, createNode, deriveEffectiveStates, indexNodes } from "./task-nodes.js";

const studyRealCasesActions = [
  "定案例筛选口径",
  "找真实落地案例",
  "只保留有客户/流程/效果的案例",
  "拆可迁移设计",
  "写入案例分析表",
];

export function migrateTaskNodes(nodes) {
  return nodes.map((node) => {
    if (node.id !== "study-real-cases") return node;
    if (!node.aiActions.includes("找 3 个案例")) return node;

    return {
      ...node,
      aiActions: studyRealCasesActions,
    };
  });
}

export function buildActiveQueue(nodes) {
  return buildExecutableQueue(nodes, { ranker: rankTaskNode });
}

export function rankTaskNode(node) {
  const priorityScore = {
    [TASK_PRIORITIES.P0]: 1000,
    [TASK_PRIORITIES.P1]: 700,
    [TASK_PRIORITIES.P2]: 300,
  }[node.priority ?? TASK_PRIORITIES.P2];
  return {
    priority: node.priority ?? TASK_PRIORITIES.P2,
    score: priorityScore,
    reason: formatPriorityReason(node),
  };
}

export function refreshTaskPriorities(nodes = []) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const index = indexNodes(nodes);
  const stateById = deriveEffectiveStates(nodes);
  const leafScores = scoreExecutableLeafNodes(nodes, index, stateById);
  const priorityById = new Map(nodes.map((node) => [node.id, TASK_PRIORITIES.P2]));

  leafScores.forEach((entry, index) => {
    if (index === 0) {
      priorityById.set(entry.node.id, TASK_PRIORITIES.P0);
    } else if (entry.score >= 80 || index <= 2) {
      priorityById.set(entry.node.id, TASK_PRIORITIES.P1);
    }
  });

  for (const node of [...nodes].reverse()) {
    const children = index.childrenByParentId.get(node.id) ?? [];
    if (stateById.get(node.id) === TASK_STATES.DONE) {
      priorityById.set(node.id, TASK_PRIORITIES.P2);
      continue;
    }
    if (node.priorityOverride) {
      priorityById.set(node.id, node.priority ?? TASK_PRIORITIES.P2);
      continue;
    }
    const childPriorities = children.map((child) => priorityById.get(child.id) ?? TASK_PRIORITIES.P2);
    if (childPriorities.includes(TASK_PRIORITIES.P0)) {
      priorityById.set(node.id, TASK_PRIORITIES.P0);
    } else if (childPriorities.includes(TASK_PRIORITIES.P1)) {
      priorityById.set(node.id, TASK_PRIORITIES.P1);
    }
  }

  return nodes.map((node) => ({
    ...node,
    priority: priorityById.get(node.id) ?? TASK_PRIORITIES.P2,
  }));
}

function scoreExecutableLeafNodes(nodes, index, stateById) {
  const dependentCounts = countTransitiveDependents(nodes);
  const leafCountsByNodeId = countLeafDescendants(index);
  const remainingLeavesByParentId = countRemainingLeavesByParent(index, stateById);

  return nodes
    .filter((node) => {
      const effectiveState = stateById.get(node.id);
      const children = index.childrenByParentId.get(node.id) ?? [];
      return children.length === 0 && effectiveState !== TASK_STATES.DONE && effectiveState !== TASK_STATES.BLOCKED;
    })
    .map((node) => ({
      node,
      score:
        40 +
        Math.min(30, (dependentCounts.get(node.id) ?? 0) * 10) +
        Math.min(20, (leafCountsByNodeId.get(node.parentId) ?? 0) * 3) +
        scoreDeadlineSignal(node) +
        scoreParentCompletionCriticality(node, remainingLeavesByParentId),
    }))
    .sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title));
}

function countTransitiveDependents(nodes) {
  const directDependentsById = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) {
    for (const dependencyId of node.dependencies ?? []) {
      directDependentsById.get(dependencyId)?.push(node.id);
    }
  }

  return new Map(
    nodes.map((node) => {
      const seen = new Set();
      const stack = [...(directDependentsById.get(node.id) ?? [])];
      while (stack.length > 0) {
        const dependentId = stack.pop();
        if (seen.has(dependentId)) continue;
        seen.add(dependentId);
        stack.push(...(directDependentsById.get(dependentId) ?? []));
      }
      return [node.id, seen.size];
    }),
  );
}

function countLeafDescendants(index) {
  const counts = new Map();
  for (const node of index.byId.values()) {
    counts.set(node.id, countLeavesUnderNode(node, index));
  }
  return counts;
}

function countLeavesUnderNode(node, index) {
  const children = index.childrenByParentId.get(node.id) ?? [];
  if (children.length === 0) return 1;
  return children.reduce((total, child) => total + countLeavesUnderNode(child, index), 0);
}

function countRemainingLeavesByParent(index, stateById) {
  const counts = new Map();
  for (const node of index.byId.values()) {
    if ((index.childrenByParentId.get(node.id) ?? []).length > 0) continue;
    if (stateById.get(node.id) === TASK_STATES.DONE) continue;
    counts.set(node.parentId ?? null, (counts.get(node.parentId ?? null) ?? 0) + 1);
  }
  return counts;
}

function scoreDeadlineSignal(node) {
  const text = `${node.title} ${node.description} ${(node.aiActions ?? []).join(" ")}`.toLowerCase();
  if (/(ddl|deadline|截止|到期|今天|今日|马上|立即|紧急|必须|快到|due)/i.test(text)) return 35;
  if (/(明天|本周|这周|尽快|高优|关键|阻塞|前置)/i.test(text)) return 20;
  return 0;
}

function scoreParentCompletionCriticality(node, remainingLeavesByParentId) {
  if (!node.parentId) return 0;
  return remainingLeavesByParentId.get(node.parentId) === 1 ? 18 : 0;
}

function formatPriorityReason(node) {
  if (node.priority === TASK_PRIORITIES.P0) {
    return `P0 当前最高优，必须马上做：${node.title}`;
  }
  if (node.priority === TASK_PRIORITIES.P1) {
    return `P1 能早一点完成更好：${node.title}`;
  }
  return `P2 其他可执行节点：${node.title}`;
}

export function getAllRecords(library) {
  return [...(library.knowledge ?? []), ...(library.skills ?? []), ...(library.artifacts ?? [])];
}

export function getRecordsForNode(library, nodeId) {
  return getAllRecords(library).filter((item) => item.relatedNodeIds?.includes(nodeId));
}

export function getContextCandidateRecords(library = {}) {
  return getAllRecords(library).map((record) => ({
    ref: getRecordContextRef(record),
    id: record.id,
    kind: record.kind,
    type: record.type,
    title: getContextRecordTitle(record),
    brief: record.brief,
    description: record.description,
    usage: record.usage,
    date: record.date,
    sourceDescription: record.sourceDescription,
  }));
}

export function applyWorkspaceIntelligenceToNode(node, intelligence = {}, validRefs = [], updatedAt = new Date().toISOString()) {
  const currentRefs = normalizeContextRefs(node.contextRefs);
  const validRefSet = new Set(validRefs);
  const selectedRefs = isContextManuallyCleared(currentRefs)
    ? []
    : normalizeContextRefList(intelligence.contextRefs)
        .filter((ref) => validRefSet.has(ref) && !currentRefs.exclude.includes(ref));
  const whyNow = intelligence.whyNow && typeof intelligence.whyNow === "object" ? intelligence.whyNow : {};
  return createNode({
    ...node,
    contextRefs: {
      include: [...new Set([...currentRefs.include, ...selectedRefs])],
      exclude: currentRefs.exclude,
    },
    aiInsights: {
      ...node.aiInsights,
      whyNow: {
        summary: typeof whyNow.summary === "string" ? whyNow.summary.trim() : "",
        tags: normalizeWhyNowTags(whyNow.tags),
        provider: typeof intelligence.provider === "string" ? intelligence.provider : null,
        updatedAt,
      },
    },
  });
}

export function buildAiContextForNode({ nodes = [], library = {}, nodeId, reason = "" } = {}) {
  const index = indexNodes(nodes);
  const node = index.byId.get(nodeId);
  if (!node) {
    return {
      reason,
      taskLineage: [],
      upstreamTasks: [],
      knowledge: [],
      skills: [],
      artifacts: [],
      accumulatedResults: [],
    };
  }

  const lineage = getLineage(node, index);
  const upstreamTaskIds = new Set([
    ...lineage.map((item) => item.id),
    ...(node.dependencies ?? []),
  ]);
  const upstreamTasks = [...upstreamTaskIds]
    .map((id) => index.byId.get(id))
    .filter((item) => item && item.id !== node.id)
    .map(serializeTaskContext);
  const relatedNodeIds = new Set([node.id, ...upstreamTaskIds]);
  const contextRefs = normalizeContextRefs(node.contextRefs);
  const selectedContextRecords = isContextManuallyCleared(contextRefs)
    ? []
    : selectRelevantContextRecords({
        records: getAllRecords(library),
        relatedNodeIds,
        contextText: [
          node.title,
          node.description,
          ...(node.aiActions ?? []),
          reason,
          ...lineage.flatMap((item) => [item.title, item.description]),
          ...upstreamTasks.flatMap((item) => [item.title, item.description, ...(item.aiActions ?? [])]),
        ].join(" "),
        includeRefs: contextRefs.include,
        excludeRefs: contextRefs.exclude,
      });
  const knowledge = selectedContextRecords.filter((record) => record.kind === "knowledge");
  const skills = selectedContextRecords.filter((record) => record.kind === "skills");
  const artifacts = selectedContextRecords.filter((record) => record.kind === "artifacts");
  const accumulatedResults = nodes
    .filter((item) => item.id !== node.id && (item.result || item.conclusion))
    .map(serializeTaskContext)
    .slice(0, 16);

  return {
    reason,
    taskLineage: lineage.map(serializeTaskContext),
    upstreamTasks,
    knowledge,
    skills,
    artifacts,
    accumulatedResults,
  };
}

export function resolvePreparedArtifact(node, artifacts = []) {
  const linkedArtifact = artifacts.find((item) => item.relatedNodeIds?.includes(node.id));
  return linkedArtifact ?? null;
}

export function completeTask(nodes, nodeId, result) {
  return nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          state: TASK_STATES.DONE,
          result,
        }
      : node,
  );
}

export function toggleTaskNodeState(nodes, nodeId, isCurrentlyDone) {
  const nextState = isCurrentlyDone ? TASK_STATES.TODO : TASK_STATES.DONE;
  const idsToUpdate = getNodeAndDescendantIds(nodes, nodeId);
  if (nextState === TASK_STATES.TODO) {
    for (const ancestorId of getAncestorIds(nodes, nodeId)) {
      idsToUpdate.add(ancestorId);
    }
  }

  return {
    nextState,
    idsToUpdate,
    nodes: nodes.map((node) =>
      idsToUpdate.has(node.id)
        ? {
            ...node,
            state: nextState,
          }
        : node,
    ),
  };
}

export function moveTaskNode(nodes, { nodeId, targetId, position = "inside" } = {}) {
  const normalizedPosition = normalizeMovePosition(position);
  const index = indexNodes(nodes);
  const movingNode = index.byId.get(nodeId);
  const targetNode = index.byId.get(targetId);

  if (!movingNode || !targetNode || movingNode.id === targetNode.id) return nodes;

  const movingIds = getNodeAndDescendantIds(nodes, movingNode.id);
  if (movingIds.has(targetNode.id)) return nodes;

  const targetIdsToPass = getNodeAndDescendantIds(nodes, targetNode.id);
  const remainingNodes = nodes.filter((node) => !movingIds.has(node.id));
  const movingNodes = nodes.filter((node) => movingIds.has(node.id));
  const finalPosition = !targetNode.parentId && normalizedPosition !== "inside" ? "inside" : normalizedPosition;
  const nextParentId = finalPosition === "inside" ? targetNode.id : targetNode.parentId;
  const insertIndex = getMoveInsertIndex(remainingNodes, targetNode.id, finalPosition, targetIdsToPass);

  if (insertIndex < 0) return nodes;

  const nextMovingNodes = movingNodes.map((node) =>
    node.id === movingNode.id
      ? createNode({
          ...node,
          parentId: nextParentId ?? null,
        })
      : node,
  );

  return [
    ...remainingNodes.slice(0, insertIndex),
    ...nextMovingNodes,
    ...remainingNodes.slice(insertIndex),
  ];
}

function normalizeMovePosition(position) {
  if (position === "before" || position === "after" || position === "inside") return position;
  return "inside";
}

function getMoveInsertIndex(nodes, targetId, position, targetIdsToPass) {
  const targetIndex = nodes.findIndex((node) => node.id === targetId);
  if (targetIndex < 0) return -1;
  if (position === "before") return targetIndex;

  let lastIndex = targetIndex;
  for (let index = targetIndex; index < nodes.length; index += 1) {
    if (targetIdsToPass.has(nodes[index].id)) lastIndex = index;
  }
  return lastIndex + 1;
}

export function getNodeAndDescendantIds(nodes, nodeId) {
  const index = indexNodes(nodes);
  const ids = new Set([nodeId]);
  const stack = [...(index.childrenByParentId.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const child = stack.pop();
    ids.add(child.id);
    stack.push(...(index.childrenByParentId.get(child.id) ?? []));
  }

  return ids;
}

export function getAncestorIds(nodes, nodeId) {
  const index = indexNodes(nodes);
  const ids = new Set();
  let current = index.byId.get(nodeId);

  while (current?.parentId) {
    ids.add(current.parentId);
    current = index.byId.get(current.parentId);
  }

  return ids;
}

export function inheritAncestorDependencies(nodes = []) {
  const index = indexNodes(nodes);
  const inheritedByNodeId = new Map();

  const getInheritedDependencies = (node) => {
    if (!node?.id) return [];
    if (inheritedByNodeId.has(node.id)) return inheritedByNodeId.get(node.id);

    const parent = node.parentId ? index.byId.get(node.parentId) : null;
    const inherited = parent
      ? [...getInheritedDependencies(parent), ...(parent.dependencies ?? [])]
      : [];
    const uniqueInherited = [...new Set(inherited)].filter((dependencyId) => dependencyId !== node.id);
    inheritedByNodeId.set(node.id, uniqueInherited);
    return uniqueInherited;
  };

  return nodes.map((node) => {
    const dependencies = [...new Set([...getInheritedDependencies(node), ...(node.dependencies ?? [])])].filter(
      (dependencyId) => dependencyId !== node.id,
    );
    if (dependencies.length === node.dependencies.length && dependencies.every((dependencyId, index) => dependencyId === node.dependencies[index])) {
      return node;
    }
    return createNode({
      ...node,
      dependencies,
    });
  });
}

function getLineage(node, index) {
  const lineage = [];
  let current = node;

  while (current) {
    lineage.unshift(current);
    current = current.parentId ? index.byId.get(current.parentId) : null;
  }

  return lineage;
}

function selectRelevantContextRecords({ records = [], relatedNodeIds, contextText = "", includeRefs = [], excludeRefs = [] } = {}) {
  const includeRefSet = new Set(includeRefs);
  const excludeRefSet = new Set(excludeRefs);
  const tokens = tokenizeContextText(contextText);

  return (records ?? [])
    .map((record, index) => {
      const ref = getRecordContextRef(record);
      if (excludeRefSet.has(ref) || excludeRefSet.has(record.id)) return null;

      const isManual = includeRefSet.has(ref) || includeRefSet.has(record.id);
      const isDirect = record.relatedNodeIds?.some((id) => relatedNodeIds.has(id));
      const textScore = scoreRecordRelevance(record, tokens);
      const score = (isManual ? 1000 : 0) + (isDirect ? 500 : 0) + textScore;
      if (!isManual && !isDirect && textScore <= 0) return null;

      return {
        record: serializeRecordContext(record),
        score,
        index,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.record);
}

function isContextManuallyCleared(contextRefs = {}) {
  return contextRefs.include.length === 0 && contextRefs.exclude.length > 0;
}

function tokenizeContextText(value) {
  return [
    ...new Set(
      String(value ?? "")
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 60);
}

function scoreRecordRelevance(record, tokens) {
  if (tokens.length === 0) return 0;
  const weightedFields = [
    [record.title, 6],
    [record.brief, 6],
    [record.type, 3],
    [record.docType, 3],
    [record.description, 3],
    [record.usage, 3],
    [record.sourceDescription, 2],
    [record.markdown, 1],
  ];
  return weightedFields.reduce((score, [field, weight]) => {
    const text = String(field ?? "").toLowerCase();
    if (!text) return score;
    return score + tokens.filter((token) => text.includes(token)).length * weight;
  }, 0);
}

function normalizeContextRefs(contextRefs = {}) {
  return {
    include: normalizeContextRefList(contextRefs.include),
    exclude: normalizeContextRefList(contextRefs.exclude),
  };
}

function normalizeContextRefList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean))];
}

function getRecordContextRef(record) {
  return `${record.kind ?? "record"}:${record.id}`;
}

function getContextRecordTitle(record) {
  return record.brief || record.title || record.description || record.type || record.docType || "未命名上下文";
}

function normalizeWhyNowTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => {
      if (typeof tag === "string") {
        const text = tag.trim();
        return text ? { text, tone: "neutral" } : null;
      }
      if (!tag || typeof tag !== "object") return null;
      const text = typeof tag.text === "string" ? tag.text.trim() : "";
      if (!text) return null;
      const tone = typeof tag.tone === "string" ? tag.tone.trim() : "neutral";
      return { text, tone: tone || "neutral" };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function serializeTaskContext(node) {
  return {
    id: node.id,
    title: node.title,
    description: node.description,
    state: node.state,
    priority: node.priority,
    aiActions: node.aiActions,
    conclusion: node.conclusion,
    result: node.result,
  };
}

function serializeRecordContext(record) {
  return {
    id: record.id,
    kind: record.kind,
    type: record.type,
    title: record.title,
    brief: record.brief,
    description: record.description,
    usage: record.usage,
    date: record.date,
    sourceDescription: record.sourceDescription,
    docType: record.docType,
    url: record.url,
    markdown: record.markdown,
  };
}

export function deleteTaskNode(nodes, nodeId) {
  const index = indexNodes(nodes);
  const node = index.byId.get(nodeId);
  if (!node?.parentId) return { nodes, parentId: null, deletedIds: new Set() };

  const deletedIds = getNodeAndDescendantIds(nodes, nodeId);
  return {
    nodes: nodes
      .filter((candidate) => !deletedIds.has(candidate.id))
      .map((candidate) => ({
        ...candidate,
        dependencies: candidate.dependencies.filter((dependencyId) => !deletedIds.has(dependencyId)),
      })),
    parentId: node.parentId,
    deletedIds,
  };
}

export function wouldCreateDependencyCycle(nodes, nodeId, dependencyId) {
  return getDependencyCycleBlockerIds(nodes, nodeId).has(dependencyId);
}

export function getDependencyCycleBlockerIds(nodes, nodeId) {
  if (!nodeId) return new Set(nodes.map((node) => node.id));

  const index = indexNodes(nodes);
  if (!index.byId.has(nodeId)) return new Set(nodes.map((node) => node.id));

  const blockerIds = new Set([nodeId]);
  for (const node of nodes) {
    if (node.id !== nodeId && hasDependencyPath(index, node.id, nodeId)) {
      blockerIds.add(node.id);
    }
  }

  return blockerIds;
}

function hasDependencyPath(index, fromId, toId) {
  const visited = new Set();
  const stack = [fromId];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === toId) return true;
    if (visited.has(currentId)) continue;

    visited.add(currentId);
    const current = index.byId.get(currentId);
    stack.push(...(current?.dependencies ?? []));
  }

  return false;
}
