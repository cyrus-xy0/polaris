import { TASK_STATES, buildExecutableQueue, indexNodes } from "./task-nodes.js";

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
  if (node.id === "study-real-cases") {
    return {
      score: 95,
      reason: "先学习真实案例，可以减少凭空设计。",
    };
  }

  if (node.id === "try-demo") {
    return {
      score: 88,
      reason: "demo 能快速验证 pitchdeck 管理场景是否有产品感觉。",
    };
  }

  return {
    score: 50,
    reason: `依赖已满足，可以立即开始：${node.title}`,
  };
}

export function getAllRecords(library) {
  return [...(library.knowledge ?? []), ...(library.skills ?? []), ...(library.artifacts ?? [])];
}

export function getRecordsForNode(library, nodeId) {
  return getAllRecords(library).filter((item) => item.relatedNodeIds?.includes(nodeId));
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
  const knowledge = selectContextRecords(library.knowledge, relatedNodeIds, { includeGlobal: true });
  const skills = selectContextRecords(library.skills, relatedNodeIds, { includeGlobal: true });
  const artifacts = selectContextRecords(library.artifacts, relatedNodeIds);
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
  if (linkedArtifact) return linkedArtifact;

  return {
    docType: "飞书 Doc",
    url: `https://example.feishu.cn/docx/ai-output-${node.id}`,
    title: `${node.title} 结果草稿`,
  };
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

function getLineage(node, index) {
  const lineage = [];
  let current = node;

  while (current) {
    lineage.unshift(current);
    current = current.parentId ? index.byId.get(current.parentId) : null;
  }

  return lineage;
}

function selectContextRecords(records = [], relatedNodeIds, { includeGlobal = false } = {}) {
  const direct = [];
  const global = [];

  for (const record of records ?? []) {
    if (record.relatedNodeIds?.some((id) => relatedNodeIds.has(id))) {
      direct.push(serializeRecordContext(record));
    } else if (includeGlobal) {
      global.push(serializeRecordContext(record));
    }
  }

  return [...direct, ...global].slice(0, includeGlobal ? 14 : 8);
}

function serializeTaskContext(node) {
  return {
    id: node.id,
    title: node.title,
    tag: node.tag,
    description: node.description,
    state: node.state,
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
    nodes: nodes.filter((candidate) => !deletedIds.has(candidate.id)),
    parentId: node.parentId,
    deletedIds,
  };
}
