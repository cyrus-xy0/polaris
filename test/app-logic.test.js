import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleNodes } from "../src/sample-tree.js";
import {
  applyWorkspaceIntelligenceToNode,
  buildActiveQueue,
  buildAiContextForNode,
  completeTask,
  deleteTaskNode,
  getContextCandidateRecords,
  getRecordsForNode,
  inheritAncestorDependencies,
  moveTaskNode,
  refreshTaskPriorities,
  resolvePreparedArtifact,
  wouldCreateDependencyCycle,
} from "../src/app-logic.js";
import { TASK_PRIORITIES, TASK_STATES, buildTree, createNode } from "../src/task-nodes.js";

describe("app logic", () => {
  it("ranks the strongest next task from the task data", () => {
    const prioritizedNodes = refreshTaskPriorities(sampleNodes);
    const queue = buildActiveQueue(prioritizedNodes);

    assert.equal(queue.current.node.priority, TASK_PRIORITIES.P0);
    assert.equal(queue.current.priority, TASK_PRIORITIES.P0);
    assert.ok(queue.current.score > queue.available.at(-1).score);
  });

  it("refreshes priorities into P0, P1, and P2 buckets", () => {
    const prioritizedNodes = refreshTaskPriorities(sampleNodes);
    const priorities = new Set(prioritizedNodes.map((node) => node.priority));

    assert.equal(priorities.has(TASK_PRIORITIES.P0), true);
    assert.equal(priorities.has(TASK_PRIORITIES.P1), true);
    assert.equal(priorities.has(TASK_PRIORITIES.P2), true);
  });

  it("preserves user priority overrides when task priorities refresh", () => {
    const automaticNodes = refreshTaskPriorities(sampleNodes);
    const automaticCurrentId = automaticNodes.find((node) => node.priority === TASK_PRIORITIES.P0).id;
    const manualNodes = automaticNodes.map((node) =>
      node.id === automaticCurrentId
        ? {
            ...node,
            priority: TASK_PRIORITIES.P2,
            priorityOverride: true,
          }
        : node,
    );

    const refreshedNodes = refreshTaskPriorities(manualNodes);
    const overriddenNode = refreshedNodes.find((node) => node.id === automaticCurrentId);

    assert.equal(overriddenNode.priority, TASK_PRIORITIES.P2);
    assert.equal(overriddenNode.priorityOverride, true);
  });

  it("reorders sibling task nodes by moving the full node block", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A" }),
      createNode({ id: "b", parentId: "root", title: "B" }),
      createNode({ id: "c", parentId: "root", title: "C" }),
    ];

    const movedNodes = moveTaskNode(nodes, { nodeId: "c", targetId: "a", position: "before" });
    const rootChildren = buildTree(movedNodes)[0].children.map((node) => node.id);

    assert.deepEqual(rootChildren, ["c", "a", "b"]);
  });

  it("reorders sibling task nodes by moving a node after the target subtree", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A" }),
      createNode({ id: "a1", parentId: "a", title: "A1" }),
      createNode({ id: "b", parentId: "root", title: "B" }),
      createNode({ id: "c", parentId: "root", title: "C" }),
    ];

    const movedNodes = moveTaskNode(nodes, { nodeId: "c", targetId: "a", position: "after" });
    const rootChildren = buildTree(movedNodes)[0].children.map((node) => node.id);

    assert.deepEqual(rootChildren, ["a", "c", "b"]);
  });

  it("moves a nested task node before a target sibling under another parent", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A" }),
      createNode({ id: "a1", parentId: "a", title: "A1" }),
      createNode({ id: "b", parentId: "root", title: "B" }),
      createNode({ id: "b1", parentId: "b", title: "B1" }),
    ];

    const movedNodes = moveTaskNode(nodes, { nodeId: "a1", targetId: "b1", position: "before" });
    const tree = buildTree(movedNodes)[0];
    const a = tree.children.find((node) => node.id === "a");
    const b = tree.children.find((node) => node.id === "b");

    assert.deepEqual(a.children.map((node) => node.id), []);
    assert.deepEqual(b.children.map((node) => node.id), ["a1", "b1"]);
  });

  it("reparents a task node with its child subtree intact", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A" }),
      createNode({ id: "a1", parentId: "a", title: "A1" }),
      createNode({ id: "b", parentId: "root", title: "B" }),
    ];

    const movedNodes = moveTaskNode(nodes, { nodeId: "a", targetId: "b", position: "inside" });
    const tree = buildTree(movedNodes)[0];
    const b = tree.children.find((node) => node.id === "b");

    assert.deepEqual(tree.children.map((node) => node.id), ["b"]);
    assert.deepEqual(b.children.map((node) => node.id), ["a"]);
    assert.deepEqual(b.children[0].children.map((node) => node.id), ["a1"]);
  });

  it("does not move a node into its own descendant", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A" }),
      createNode({ id: "a1", parentId: "a", title: "A1" }),
    ];

    const movedNodes = moveTaskNode(nodes, { nodeId: "a", targetId: "a1", position: "inside" });

    assert.strictEqual(movedNodes, nodes);
  });

  it("inherits dependencies from every ancestor task node", () => {
    const nodes = [
      createNode({ id: "root", title: "Root", dependencies: ["setup"] }),
      createNode({ id: "setup", title: "Setup" }),
      createNode({ id: "research", title: "Research" }),
      createNode({ id: "a", parentId: "root", title: "A", dependencies: ["research"] }),
      createNode({ id: "a1", parentId: "a", title: "A1" }),
    ];

    const inherited = inheritAncestorDependencies(nodes);

    assert.deepEqual(inherited.find((node) => node.id === "a").dependencies, ["setup", "research"]);
    assert.deepEqual(inherited.find((node) => node.id === "a1").dependencies, ["setup", "research"]);
  });

  it("removes deleted nodes from remaining dependency lists", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "research", parentId: "root", title: "Research" }),
      createNode({ id: "draft", parentId: "root", title: "Draft", dependencies: ["research"] }),
    ];

    const update = deleteTaskNode(nodes, "research");

    assert.deepEqual(update.deletedIds, new Set(["research"]));
    assert.deepEqual(update.nodes.find((node) => node.id === "draft").dependencies, []);
    assert.doesNotThrow(() => buildActiveQueue(update.nodes));
  });

  it("detects dependency choices that would create a cycle", () => {
    const nodes = [
      createNode({ id: "root", title: "Root" }),
      createNode({ id: "a", parentId: "root", title: "A", dependencies: ["b"] }),
      createNode({ id: "b", parentId: "root", title: "B", dependencies: ["c"] }),
      createNode({ id: "c", parentId: "root", title: "C" }),
      createNode({ id: "d", parentId: "root", title: "D" }),
    ];

    assert.equal(wouldCreateDependencyCycle(nodes, "c", "a"), true);
    assert.equal(wouldCreateDependencyCycle(nodes, "c", "d"), false);
  });

  it("matches library records to related task nodes", () => {
    const records = getRecordsForNode(
      {
        knowledge: [{ id: "k1", relatedNodeIds: ["try-demo"] }],
        skills: [{ id: "s1", relatedNodeIds: ["other"] }],
        artifacts: [{ id: "a1", relatedNodeIds: ["try-demo"] }],
      },
      "try-demo",
    );

    assert.deepEqual(
      records.map((record) => record.id),
      ["k1", "a1"],
    );
  });

  it("keeps completion as pure node data transformation", () => {
    const nodes = completeTask(sampleNodes, "study-real-cases", {
      source: "manual",
      url: "https://example.feishu.cn/docx/manual-result",
    });
    const completed = nodes.find((node) => node.id === "study-real-cases");

    assert.equal(completed.state, "完成");
    assert.equal(completed.result.source, "manual");
  });

  it("removes a completed task from the queue even when its output link is still pending", () => {
    const prioritizedNodes = refreshTaskPriorities(sampleNodes);
    const queue = buildActiveQueue(prioritizedNodes);
    const currentId = queue.current.node.id;
    const nodes = completeTask(prioritizedNodes, currentId, {
      source: "pending-ai",
      url: "",
    });
    const completed = nodes.find((node) => node.id === currentId);
    const nextQueue = buildActiveQueue(nodes);

    assert.equal(completed.state, TASK_STATES.DONE);
    assert.equal(completed.result.source, "pending-ai");
    assert.equal(nextQueue.available.some((item) => item.node.id === currentId), false);
  });

  it("resolves prepared output only from explicit artifacts", () => {
    const node = sampleNodes.find((candidate) => candidate.id === "try-demo");
    const artifact = resolvePreparedArtifact(node, [
      {
        docType: "飞书 Doc",
        title: "Demo 草稿",
        url: "https://example.feishu.cn/docx/demo",
        relatedNodeIds: ["try-demo"],
      },
    ]);

    assert.equal(artifact.title, "Demo 草稿");
    assert.equal(resolvePreparedArtifact(node, []), null);
  });

  it("builds AI context from task lineage, knowhow, skills, and accumulated results", () => {
    const context = buildAiContextForNode({
      nodes: [
        {
          id: "root",
          parentId: null,
          title: "北极星",
          description: "找到 ToB AI 场景。",
          aiActions: [],
          dependencies: [],
          state: "待做",
        },
        {
          id: "previous",
          parentId: "root",
          title: "前置判断",
          description: "已经验证过的判断。",
          aiActions: [],
          dependencies: [],
          state: "完成",
          priority: "P2",
          result: { source: "ai", url: "https://example.feishu.cn/docx/result" },
        },
        {
          id: "current",
          parentId: "root",
          title: "当前任务",
          description: "要生成行动方案。",
          aiActions: ["读取上下文"],
          dependencies: ["previous"],
          state: "待做",
          priority: "P0",
        },
      ],
      library: {
        knowledge: [{ id: "k1", kind: "knowledge", title: "AI-native 原则", relatedNodeIds: ["root"], markdown: "让 AI 读上下文、执行动作、沉淀结果。" }],
        skills: [{ id: "s1", kind: "skills", title: "反证优先", relatedNodeIds: ["current"], usage: "先找失败证据。" }],
        artifacts: [{ id: "a1", kind: "artifacts", title: "前置结果", relatedNodeIds: ["previous"], url: "https://example.feishu.cn/docx/result" }],
      },
      nodeId: "current",
    });

    assert.deepEqual(
      context.taskLineage.map((task) => task.id),
      ["root", "current"],
    );
    assert.equal(context.upstreamTasks.some((task) => task.id === "previous"), true);
    assert.equal(context.knowledge[0].title, "AI-native 原则");
    assert.equal(context.skills[0].title, "反证优先");
    assert.equal(context.accumulatedResults[0].result.url, "https://example.feishu.cn/docx/result");
    assert.equal(context.taskLineage.at(-1).priority, "P0");
  });

  it("applies manual AI context includes and excludes", () => {
    const context = buildAiContextForNode({
      nodes: [
        createNode({
          id: "root",
          title: "Root",
          description: "Root task",
          aiActions: ["plan"],
        }),
        createNode({
          id: "current",
          parentId: "root",
          title: "Current",
          description: "Current task",
          aiActions: ["use context"],
          contextRefs: {
            include: ["skills:s-manual", "artifacts:a-manual"],
            exclude: ["knowledge:k-auto"],
          },
        }),
      ],
      library: {
        knowledge: [
          { id: "k-auto", kind: "knowledge", title: "Auto knowledge", relatedNodeIds: ["current"] },
          { id: "k-global", kind: "knowledge", title: "Global knowledge", relatedNodeIds: [] },
        ],
        skills: [
          { id: "s-manual", kind: "skills", title: "Manual skill", relatedNodeIds: [] },
        ],
        artifacts: [
          { id: "a-manual", kind: "artifacts", title: "Manual artifact", relatedNodeIds: [] },
        ],
      },
      nodeId: "current",
    });

    assert.equal(context.knowledge.some((record) => record.id === "k-auto"), false);
    assert.equal(context.knowledge.some((record) => record.id === "k-global"), false);
    assert.equal(context.skills.some((record) => record.id === "s-manual"), true);
    assert.equal(context.artifacts.some((record) => record.id === "a-manual"), true);
  });

  it("keeps all relevant AI-selected context while preserving manual includes", () => {
    const context = buildAiContextForNode({
      nodes: [
        createNode({
          id: "current",
          title: "Current launch analysis",
          description: "Current task needs launch context",
          aiActions: ["use context"],
          contextRefs: {
            include: ["skills:s-manual"],
          },
        }),
      ],
      library: {
        knowledge: Array.from({ length: 8 }, (_, index) => ({
          id: `k-launch-${index}`,
          kind: "knowledge",
          title: `Launch knowledge ${index}`,
          description: "Relevant launch context",
          relatedNodeIds: [],
        })),
        skills: [
          { id: "s-manual", kind: "skills", title: "Manual skill", relatedNodeIds: [] },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `s-global-${index}`,
            kind: "skills",
            title: `Global skill ${index}`,
            relatedNodeIds: [],
          })),
          { id: "s-launch", kind: "skills", title: "Launch skill", description: "Relevant launch context", relatedNodeIds: [] },
        ],
        artifacts: [],
      },
      nodeId: "current",
    });

    const selected = [...context.knowledge, ...context.skills, ...context.artifacts];
    assert.equal(selected.length, 10);
    assert.equal(context.skills[0].id, "s-manual");
    assert.equal(selected.some((record) => record.id === "s-global-0"), false);
  });

  it("persists all valid workspace intelligence context refs", () => {
    const refs = Array.from({ length: 8 }, (_, index) => `knowledge:k${index}`);
    const node = createNode({
      id: "current",
      title: "Current",
      description: "Current task",
      aiActions: ["plan"],
    });
    const updated = applyWorkspaceIntelligenceToNode(
      node,
      { contextRefs: refs },
      refs,
    );

    assert.deepEqual(updated.contextRefs.include, refs);
  });

  it("keeps AI context empty after the user manually clears bound context", () => {
    const node = createNode({
      id: "current",
      title: "Launch plan",
      description: "Needs launch context",
      contextRefs: {
        include: [],
        exclude: ["knowledge:k1"],
      },
    });
    const context = buildAiContextForNode({
      nodes: [node],
      library: {
        knowledge: [{ id: "k2", kind: "knowledge", title: "Launch knowledge", description: "Relevant launch context", relatedNodeIds: ["current"] }],
        skills: [{ id: "s1", kind: "skills", title: "Launch skill", description: "Relevant launch context", relatedNodeIds: ["current"] }],
        artifacts: [],
      },
      nodeId: "current",
    });
    const updated = applyWorkspaceIntelligenceToNode(
      node,
      { contextRefs: ["knowledge:k2", "skills:s1"] },
      ["knowledge:k2", "skills:s1"],
    );

    assert.deepEqual(context.knowledge, []);
    assert.deepEqual(context.skills, []);
    assert.deepEqual(updated.contextRefs.include, []);
  });

  it("persists AI-selected workspace context without overriding user exclusions", () => {
    const node = createNode({
      id: "current",
      title: "Current",
      description: "Current task",
      aiActions: ["plan"],
      contextRefs: {
        include: ["knowledge:k1"],
        exclude: ["skills:s2"],
      },
    });
    const candidates = getContextCandidateRecords({
      knowledge: [{ id: "k1", kind: "knowledge", title: "Keep", relatedNodeIds: [] }],
      skills: [{ id: "s2", kind: "skills", title: "Excluded", relatedNodeIds: [] }],
      artifacts: [{ id: "a3", kind: "artifacts", title: "Artifact", relatedNodeIds: [] }],
    });
    const updated = applyWorkspaceIntelligenceToNode(
      node,
      {
        provider: "hermes",
        whyNow: {
          summary: "先处理当前任务。",
          tags: [{ text: "方向先定", tone: "strong" }],
        },
        contextRefs: ["skills:s2", "artifacts:a3", "unknown:x"],
      },
      candidates.map((candidate) => candidate.ref),
      "2026-06-08T00:00:00.000Z",
    );

    assert.deepEqual(updated.contextRefs.include, ["knowledge:k1", "artifacts:a3"]);
    assert.deepEqual(updated.contextRefs.exclude, ["skills:s2"]);
    assert.equal(updated.aiInsights.whyNow.provider, "hermes");
    assert.deepEqual(updated.aiInsights.whyNow.tags, [{ text: "方向先定", tone: "strong" }]);
  });
});
