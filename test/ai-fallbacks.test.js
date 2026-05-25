import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createFallbackAiResultOutput,
  createFallbackDraftOutput,
  createFallbackSuggestedActionPlan,
  createFallbackTaskNodeSplit,
} from "../src/ai-fallbacks.js";

describe("AI fallbacks", () => {
  it("creates a usable local suggested action plan", () => {
    const plan = createFallbackSuggestedActionPlan({
      node: createNode({
        aiActions: ["读取上下文", "形成判断"],
      }),
      reason: "当前最高优先级",
    });

    assert.equal(plan.provider, "local-fallback");
    assert.match(plan.summary, /AI 服务暂不可用/);
    assert.deepEqual(plan.steps.slice(0, 3), ["确认「定义 AI-native 差异点」的输入、边界和验收标准", "读取上下文", "形成判断"]);
  });

  it("creates a draft output that the UI can render as content", () => {
    const output = createFallbackDraftOutput({
      node: createNode(),
      artifact: { docType: "飞书 Doc", title: "差异点草稿" },
      actionPlan: {
        summary: "按计划执行。",
        steps: ["列传统做法", "列 AI-native 做法", "写判断标准"],
      },
    });

    assert.equal(output.provider, "local-fallback");
    assert.match(output.title, /结果草稿$/);
    assert.match(output.summary, /本地可继续推进/);
    assert.match(output.brief, /列传统做法/);
    assert.deepEqual(output.points, ["列传统做法", "列 AI-native 做法", "写判断标准"]);
  });

  it("creates a local AI result with markdown and next actions", () => {
    const output = createFallbackAiResultOutput({
      node: createNode(),
      artifact: { docType: "飞书 Base", title: "案例表" },
      actionPlan: {
        steps: ["筛案例", "写分析表", "判断迁移价值"],
      },
    });

    assert.equal(output.provider, "local-fallback");
    assert.equal(output.resultType, "local-fallback");
    assert.match(output.markdown, /\| 任务目标 \| 定义 AI-native 差异点 \|/);
    assert.match(output.markdown, /飞书 Base · 案例表/);
    assert.match(output.markdown, /1\. 筛案例/);
    assert.equal(output.points.length, 3);
    assert.deepEqual(output.nextActions, ["补充执行证据", "重新生成 AI 结果", "把最终产物链接回任务节点"]);
  });

  it("creates minimal child nodes for task split failures", () => {
    const split = createFallbackTaskNodeSplit(createNode());

    assert.equal(split.provider, "local-fallback");
    assert.equal(split.nodes.length, 3);
    assert.deepEqual(
      split.nodes.map((node) => node.tag),
      ["思考", "执行", "验证"],
    );
  });
});

function createNode(overrides = {}) {
  return {
    id: "define-ai-native-difference",
    title: "定义 AI-native 差异点",
    tag: "思考",
    description: "明确这个方案为什么不是传统 SaaS 加聊天框。",
    aiActions: ["明确判断口径", "执行反证"],
    dependencies: [],
    state: "待做",
    priority: "P2",
    ...overrides,
  };
}
