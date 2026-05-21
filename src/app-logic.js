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

export function buildDraftOutputPoints(node) {
  return node.aiActions.map((action) => `产出：${action}`);
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

export function getArtifactDisplayType(artifact) {
  if (artifact.docType === "飞书 Base") return "Feishu Base";
  if (artifact.docType === "飞书 Doc") return "Feishu Doc";
  return artifact.docType;
}

export function buildPreparedResult(node) {
  if (node.id === "study-real-cases") {
    return {
      title: "真实案例分析表 v0.1",
      summary: "AI 会读取知识库里的 ToB Agent 落地趋势和真实案例表，再按客户、流程、效果和可迁移设计生成一版可确认结果。",
    };
  }

  if (node.id === "try-demo") {
    return {
      title: "Pitchdeck 管理 demo 草稿 v0.1",
      summary: "AI 会读取样例 deck、AI-native 工作流原则和当前节点要求，先生成一个可以马上验证的最小 demo 草稿。",
    };
  }

  if (node.id.includes("scenario") || node.id.includes("gtm")) {
    return {
      title: `${node.title} 判断草稿 v0.1`,
      summary: "AI 会读取行业判断、场景价值筛选标准和当前节点要求，先把关键证据收敛成一版可确认的判断结果。",
    };
  }

  return {
    title: `${node.title} 结果草稿 v0.1`,
    summary: "AI 会读取相关知识库、Skill 和当前任务要求，先生成一版可以直接确认、修改或沉淀的结果草稿。",
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
