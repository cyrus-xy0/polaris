export const TASK_TAGS = Object.freeze({
  THINK: "思考",
  EXECUTE: "执行",
  COMMUNICATE: "沟通",
  VERIFY: "验证",
  ORGANIZE: "整理",
});

export const TASK_STATES = Object.freeze({
  TODO: "待做",
  IN_PROGRESS: "进行中",
  DONE: "完成",
  BLOCKED: "阻塞",
});

export const TASK_PRIORITIES = Object.freeze({
  P0: "P0",
  P1: "P1",
  P2: "P2",
});

export const CREATED_FROM = Object.freeze({
  USER: "user",
  AI_SPLIT: "ai_split",
  REVIEW: "review",
});

const VALID_TAGS = new Set(Object.values(TASK_TAGS));
const VALID_STATES = new Set(Object.values(TASK_STATES));
const VALID_PRIORITIES = new Set(Object.values(TASK_PRIORITIES));
const VALID_CREATED_FROM = new Set(Object.values(CREATED_FROM));

export function validateNode(node) {
  const errors = [];

  if (!node || typeof node !== "object") {
    return ["node must be an object"];
  }

  if (!node.id) errors.push("id is required");
  if (!node.title) errors.push("title is required");
  if (!VALID_TAGS.has(node.tag)) errors.push(`tag must be one of: ${[...VALID_TAGS].join(", ")}`);
  if (!VALID_STATES.has(node.state)) errors.push(`state must be one of: ${[...VALID_STATES].join(", ")}`);
  if (!VALID_PRIORITIES.has(node.priority)) {
    errors.push(`priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`);
  }
  if (!VALID_CREATED_FROM.has(node.createdFrom)) {
    errors.push(`createdFrom must be one of: ${[...VALID_CREATED_FROM].join(", ")}`);
  }
  if (
    !Array.isArray(node.aiActions) ||
    node.aiActions.length === 0 ||
    node.aiActions.some((action) => typeof action !== "string" || action.trim().length === 0)
  ) {
    errors.push("aiActions must contain at least one action string");
  }
  if (!Array.isArray(node.dependencies)) {
    errors.push("dependencies must be an array");
  }

  return errors;
}

export function createNode(input) {
  const node = {
    id: input.id,
    parentId: input.parentId ?? null,
    title: input.title,
    tag: input.tag,
    description: input.description ?? "",
    aiActions: input.aiActions ?? ["明确下一步", "执行最小动作", "记录判断"],
    dependencies: input.dependencies ?? [],
    state: input.state ?? TASK_STATES.TODO,
    priority: input.priority ?? TASK_PRIORITIES.P2,
    conclusion: input.conclusion ?? null,
    result: input.result ?? null,
    createdFrom: input.createdFrom ?? CREATED_FROM.USER,
  };

  const errors = validateNode(node);
  if (errors.length > 0) {
    throw new Error(`Invalid task node "${node.id ?? "unknown"}": ${errors.join("; ")}`);
  }

  return node;
}

export function indexNodes(nodes) {
  const byId = new Map();
  const childrenByParentId = new Map();

  for (const node of nodes) {
    if (byId.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);

    const parentId = node.parentId ?? null;
    if (!childrenByParentId.has(parentId)) {
      childrenByParentId.set(parentId, []);
    }
    childrenByParentId.get(parentId).push(node);
  }

  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      throw new Error(`Node "${node.id}" references missing parent "${node.parentId}"`);
    }
    for (const dependencyId of node.dependencies) {
      if (!byId.has(dependencyId)) {
        throw new Error(`Node "${node.id}" references missing dependency "${dependencyId}"`);
      }
    }
  }

  return { byId, childrenByParentId };
}

export function isLeaf(node, index) {
  return (index.childrenByParentId.get(node.id) ?? []).length === 0;
}

export function buildTree(nodes) {
  const index = indexNodes(nodes);

  function attachChildren(node) {
    return {
      ...node,
      children: (index.childrenByParentId.get(node.id) ?? []).map(attachChildren),
    };
  }

  return (index.childrenByParentId.get(null) ?? []).map(attachChildren);
}

export function deriveEffectiveStates(nodes) {
  const index = indexNodes(nodes);
  const stateById = new Map();
  const visiting = new Set();

  function dependenciesComplete(node) {
    return node.dependencies.every((dependencyId) => deriveState(dependencyId) === TASK_STATES.DONE);
  }

  function deriveState(nodeId) {
    if (stateById.has(nodeId)) return stateById.get(nodeId);
    if (visiting.has(nodeId)) throw new Error(`Cycle detected while deriving state at "${nodeId}"`);

    const node = index.byId.get(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);

    visiting.add(nodeId);
    const children = index.childrenByParentId.get(nodeId) ?? [];
    const childStates = children.map((child) => deriveState(child.id));

    let effectiveState = node.state;
    if (!dependenciesComplete(node)) {
      effectiveState = TASK_STATES.BLOCKED;
    } else if (children.length > 0 && childStates.every((state) => state === TASK_STATES.DONE)) {
      effectiveState = TASK_STATES.DONE;
    } else if (children.length > 0 && childStates.some((state) => state === TASK_STATES.IN_PROGRESS)) {
      effectiveState = TASK_STATES.IN_PROGRESS;
    } else if (children.length > 0 && node.state === TASK_STATES.BLOCKED) {
      effectiveState = TASK_STATES.BLOCKED;
    } else if (children.length > 0) {
      effectiveState = TASK_STATES.TODO;
    }

    visiting.delete(nodeId);
    stateById.set(nodeId, effectiveState);
    return effectiveState;
  }

  for (const node of nodes) {
    deriveState(node.id);
  }

  return stateById;
}

export function listLeafNodes(nodes) {
  const index = indexNodes(nodes);
  return nodes.filter((node) => isLeaf(node, index));
}

export function getBlockedBy(node, stateById) {
  return node.dependencies.filter((dependencyId) => stateById.get(dependencyId) !== TASK_STATES.DONE);
}

export function buildExecutableQueue(nodes, options = {}) {
  const stateById = deriveEffectiveStates(nodes);
  const leaves = listLeafNodes(nodes);
  const ranker = options.ranker ?? defaultRanker;

  const available = [];
  const blocked = [];

  for (const node of leaves) {
    const effectiveState = stateById.get(node.id);
    if (effectiveState === TASK_STATES.DONE) continue;

    const blockedBy = getBlockedBy(node, stateById);
    if (blockedBy.length > 0 || effectiveState === TASK_STATES.BLOCKED) {
      blocked.push({ node, blockedBy });
      continue;
    }

    const recommendation = ranker(node, { nodes, stateById });
    available.push({
      node,
      reason: recommendation.reason,
      aiActions: node.aiActions,
      score: recommendation.score,
      priority: recommendation.priority ?? node.priority,
    });
  }

  available.sort((a, b) => b.score - a.score);

  return {
    current: available[0] ?? null,
    available,
    blocked,
  };
}

function defaultRanker(node) {
  return {
    score: 0,
    reason: `依赖已满足，可以立即开始：${node.title}`,
  };
}
