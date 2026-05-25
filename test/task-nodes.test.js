import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TASK_STATES,
  TASK_PRIORITIES,
  buildExecutableQueue,
  buildTree,
  createNode,
  deriveEffectiveStates,
  listLeafNodes,
} from "../src/task-nodes.js";
import { sampleNodes } from "../src/sample-tree.js";

describe("task node structure v1", () => {
  it("defaults new nodes to P2 priority", () => {
    const node = createNode({
      id: "new-node",
      title: "新节点",
      description: "默认优先级。",
      aiActions: ["明确输入"],
    });

    assert.equal(node.priority, TASK_PRIORITIES.P2);
    assert.equal(node.priorityOverride, false);
  });

  it("builds the sample as a recursive tree", () => {
    const tree = buildTree(sampleNodes);

    assert.equal(tree.length, 1);
    assert.equal(tree[0].id, "polaris");
    assert.equal(tree[0].children[0].id, "find-scenario");
  });

  it("only leaf nodes enter the executable queue", () => {
    const leaves = listLeafNodes(sampleNodes);
    const queue = buildExecutableQueue(sampleNodes);

    const leafIds = leaves.map((node) => node.id);
    const queueIds = queue.available.map((item) => item.node.id);

    assert.ok(leafIds.includes("try-demo"));
    assert.ok(leafIds.includes("study-real-cases"));
    assert.ok(!queueIds.includes("polaris"));
    assert.deepEqual(queueIds.sort(), leafIds.sort());
  });

  it("keeps demo and case study parallel when neither depends on the other", () => {
    const queue = buildExecutableQueue(sampleNodes);

    assert.ok(queue.available.some((item) => item.node.id === "try-demo"));
    assert.ok(queue.available.some((item) => item.node.id === "study-real-cases"));
    assert.equal(queue.blocked.length, 0);
  });

  it("blocks demo when demo depends on case study", () => {
    const nodes = sampleNodes.map((node) =>
      node.id === "try-demo"
        ? createNode({
            ...node,
            dependencies: ["study-real-cases"],
          })
        : node,
    );

    const queue = buildExecutableQueue(nodes);

    assert.ok(queue.available.some((item) => item.node.id === "study-real-cases"));
    assert.ok(queue.blocked.some((item) => item.node.id === "try-demo"));
    assert.deepEqual(queue.blocked[0].blockedBy, ["study-real-cases"]);
  });

  it("auto-completes the parent when all child leaves are done", () => {
    const nodes = sampleNodes.map((node) =>
      ["map-pitchdeck-workflow", "try-demo", "study-real-cases"].includes(node.id)
        ? createNode({
            ...node,
            state: TASK_STATES.DONE,
          })
        : node,
    );

    const states = deriveEffectiveStates(nodes);

    assert.equal(states.get("try-demo"), TASK_STATES.DONE);
    assert.equal(states.get("study-real-cases"), TASK_STATES.DONE);
    assert.equal(states.get("analyze-pitchdeck-management"), TASK_STATES.DONE);
  });

  it("keeps a parent incomplete when any child is incomplete", () => {
    const nodes = sampleNodes.map((node) =>
      node.id === "analyze-pitchdeck-management"
        ? createNode({
            ...node,
            state: TASK_STATES.DONE,
          })
        : node.id === "study-real-cases"
          ? createNode({
              ...node,
              state: TASK_STATES.TODO,
            })
          : node,
    );

    const states = deriveEffectiveStates(nodes);

    assert.equal(states.get("study-real-cases"), TASK_STATES.TODO);
    assert.equal(states.get("analyze-pitchdeck-management"), TASK_STATES.TODO);
  });
});
