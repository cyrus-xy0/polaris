import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sampleNodes } from "../src/sample-tree.js";
import {
  buildActiveQueue,
  buildAiContextForNode,
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
  });

  it("builds AI context from task lineage, knowhow, skills, and accumulated results", () => {
    const context = buildAiContextForNode({
      nodes: [
        {
          id: "root",
          parentId: null,
          title: "北极星",
          tag: "思考",
          description: "找到 ToB AI 场景。",
          aiActions: [],
          dependencies: [],
          state: "待做",
        },
        {
          id: "previous",
          parentId: "root",
          title: "前置判断",
          tag: "验证",
          description: "已经验证过的判断。",
          aiActions: [],
          dependencies: [],
          state: "完成",
          result: { source: "ai", url: "https://example.feishu.cn/docx/result" },
        },
        {
          id: "current",
          parentId: "root",
          title: "当前任务",
          tag: "执行",
          description: "要生成行动方案。",
          aiActions: ["读取上下文"],
          dependencies: ["previous"],
          state: "待做",
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
  });
});
