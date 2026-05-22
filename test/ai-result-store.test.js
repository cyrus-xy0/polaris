import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createDraftOutputSignature,
  createAiResultSignature,
  createSuggestedActionPlanSignature,
  readAiResult,
  writeAiResult,
  writeAiResultDocument,
} from "../src/ai-result-store.js";

describe("AI result store", () => {
  it("persists generated action plans before they are read back", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-ai-results-"));
    const node = createNode();
    const signature = createSuggestedActionPlanSignature({ node, reason: "当前最高优先级" });

    const saved = writeAiResult({
      dataRoot,
      kind: "suggested-action-plan",
      nodeId: node.id,
      signature,
      payload: {
        plan: {
          summary: "先确认差异，再收敛动作。",
          steps: ["列传统做法", "列 AI-native 做法", "写判断标准"],
          provider: "test",
        },
      },
    });
    const readBack = readAiResult({
      dataRoot,
      kind: "suggested-action-plan",
      nodeId: node.id,
      signature,
    });

    assert.equal(saved.filePath, readBack.filePath);
    assert.equal(readBack.plan.summary, "先确认差异，再收敛动作。");
    assert.deepEqual(readBack.plan.steps, ["列传统做法", "列 AI-native 做法", "写判断标准"]);
    assert.equal(readBack.provider, undefined);
    assert.match(readBack.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores persisted draft output when the node signature changes", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-ai-draft-results-"));
    const node = createNode();
    const signature = createDraftOutputSignature({
      node,
      artifact: { title: "差异点草稿", docType: "Feishu Doc" },
    });

    writeAiResult({
      dataRoot,
      kind: "draft-output",
      nodeId: node.id,
      signature,
      payload: {
        output: {
          title: "差异点定义草稿",
          summary: "明确方案判断口径。",
          points: ["传统路径", "AI 路径", "验收标准"],
          provider: "test",
        },
      },
    });

    assert.equal(
      readAiResult({
        dataRoot,
        kind: "draft-output",
        nodeId: node.id,
        signature: createDraftOutputSignature({
          node: { ...node, description: "描述发生变化" },
          artifact: { title: "差异点草稿", docType: "Feishu Doc" },
        }),
      }),
      null,
    );
  });

  it("writes the AI result link target as a local HTML document", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-ai-result-document-"));
    const node = createNode();
    const artifact = { title: "差异点草稿", docType: "Feishu Doc" };
    const signature = createAiResultSignature({ node, artifact });
    const result = writeAiResultDocument({
      dataRoot,
      node,
      signature,
      artifact,
      actionPlan: {
        summary: "按计划产出。",
        steps: ["读取上文", "生成 brief"],
      },
      output: {
        title: "差异点定义草稿",
        summary: "明确方案判断口径。",
        points: ["传统路径", "AI 路径"],
      },
    });

    assert.equal(result.docType, "本地 HTML");
    assert.match(result.url, /^\/ai-results\/documents\/.+\.html$/);
    assert.equal(existsSync(result.path), true);
    const html = readFileSync(result.path, "utf8");
    assert.match(html, /差异点定义草稿/);
    assert.match(html, /实施依据/);
  });
});

function createNode() {
  return {
    id: "define-ai-native-difference",
    title: "定义 AI-native 差异点",
    tag: "思考",
    description: "明确这个方案为什么不是传统 SaaS 加聊天框。",
    dependencies: [],
    state: "待做",
  };
}
