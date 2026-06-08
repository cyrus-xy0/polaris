import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleNodes } from "../src/sample-tree.js";
import {
  buildActiveQueue,
  buildAiContextForNode,
  completeTask,
  deleteTaskNode,
  getRecordsForNode,
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
    assert.equal(context.knowledge.some((record) => record.id === "k-global"), true);
    assert.equal(context.skills.some((record) => record.id === "s-manual"), true);
    assert.equal(context.artifacts.some((record) => record.id === "a-manual"), true);
  });

  it("keeps automatically selected AI context compact while preserving manual includes", () => {
    const context = buildAiContextForNode({
      nodes: [
        createNode({
          id: "current",
          title: "Current",
          description: "Current task",
          aiActions: ["use context"],
          contextRefs: {
            include: ["skills:s-manual"],
          },
        }),
      ],
      library: {
        knowledge: Array.from({ length: 8 }, (_, index) => ({
          id: `k-global-${index}`,
          kind: "knowledge",
          title: `Global knowledge ${index}`,
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
        ],
        artifacts: [],
      },
      nodeId: "current",
    });

    assert.equal(context.knowledge.length, 3);
    assert.equal(context.skills.length, 4);
    assert.equal(context.skills[0].id, "s-manual");
  });
});
