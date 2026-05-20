import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleNodes } from "../src/sample-tree.js";
import {
  buildActiveQueue,
  buildPreparedResult,
  completeTask,
  getRecordsForNode,
  resolvePreparedArtifact,
} from "../src/app-logic.js";

describe("app logic", () => {
  it("ranks the strongest next task from the task data", () => {
    const queue = buildActiveQueue(sampleNodes);

    assert.equal(queue.current.node.id, "study-real-cases");
    assert.equal(queue.current.score, 95);
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

  it("resolves prepared output from artifacts before falling back", () => {
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
    assert.match(buildPreparedResult(node).summary, /最小 demo/);
  });
});
