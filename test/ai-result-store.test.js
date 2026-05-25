import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createDraftOutputSignature,
  createAiResultSignature,
  createSuggestedActionPlanSignature,
  hasAiResultOutputContent,
  hasDraftOutputContent,
  hasSuggestedActionPlanContent,
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

  it("keeps AI analysis signatures stable when only surrounding context changes", () => {
    const node = createNode();
    const artifact = { title: "差异点草稿", docType: "Feishu Doc" };

    assert.equal(
      createSuggestedActionPlanSignature({ node, reason: "A", contextDigest: "context-a" }),
      createSuggestedActionPlanSignature({ node, reason: "B", contextDigest: "context-b" }),
    );
    assert.equal(
      createDraftOutputSignature({ node, artifact, contextDigest: "context-a", actionPlanDigest: "plan-a" }),
      createDraftOutputSignature({ node, artifact, contextDigest: "context-b", actionPlanDigest: "plan-b" }),
    );
    assert.equal(
      createAiResultSignature({ node, artifact, contextDigest: "context-a", actionPlanDigest: "plan-a" }),
      createAiResultSignature({ node, artifact, contextDigest: "context-b", actionPlanDigest: "plan-b" }),
    );
    assert.notEqual(
      createSuggestedActionPlanSignature({ node }),
      createSuggestedActionPlanSignature({ node: { ...node, priority: "P0" } }),
    );
  });

  it("reuses legacy local results that only differ by context digest", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-ai-legacy-results-"));
    const node = createNode();
    const legacySignature = JSON.stringify({
      version: "rich-context-v3-openclaw-content",
      id: node.id,
      title: node.title,
      tag: node.tag,
      description: node.description,
      dependencies: node.dependencies,
      state: node.state,
      reason: "旧队列原因",
      contextDigest: "old-context",
    });

    writeAiResult({
      dataRoot,
      kind: "suggested-action-plan",
      nodeId: node.id,
      signature: legacySignature,
      payload: {
        plan: {
          summary: "沿用本地旧分析。",
          steps: ["不重新生成"],
        },
      },
    });

    const readBack = readAiResult({
      dataRoot,
      kind: "suggested-action-plan",
      nodeId: node.id,
      signature: createSuggestedActionPlanSignature({ node, reason: "新队列原因", contextDigest: "new-context" }),
    });

    assert.equal(readBack.plan.summary, "沿用本地旧分析。");

    const artifact = { title: "差异点草稿", docType: "Feishu Doc" };
    const legacyDraftSignature = JSON.stringify({
      version: "rich-context-v3-openclaw-content",
      id: node.id,
      title: node.title,
      tag: node.tag,
      description: node.description,
      dependencies: node.dependencies,
      state: node.state,
      artifactTitle: artifact.title,
      artifactType: artifact.docType,
      contextDigest: "old-context",
      actionPlanDigest: "old-plan",
    });
    writeAiResult({
      dataRoot,
      kind: "draft-output",
      nodeId: node.id,
      signature: legacyDraftSignature,
      payload: {
        output: {
          title: "旧草稿",
          summary: "沿用本地旧草稿。",
          points: ["不重新生成"],
        },
      },
    });

    const draftReadBack = readAiResult({
      dataRoot,
      kind: "draft-output",
      nodeId: node.id,
      signature: createDraftOutputSignature({
        node,
        artifact,
        contextDigest: "new-context",
        actionPlanDigest: "new-plan",
      }),
    });

    assert.equal(draftReadBack.output.summary, "沿用本地旧草稿。");
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
        title: "差异点分析结果",
        summary: "明确方案判断口径。",
        markdown: "| 维度 | 传统路径 | AI 路径 |\n|---|---|---|\n| 输入 | 人工整理 | 自动读取上下文 |",
        points: ["传统路径依赖人工整理", "AI 路径应自动读取上下文"],
      },
    });

    assert.equal(result.docType, "本地 HTML");
    assert.match(result.url, /^\/ai-results\/documents\/.+\.html$/);
    assert.equal(existsSync(result.path), true);
    const html = readFileSync(result.path, "utf8");
    assert.match(html, /差异点分析结果/);
    assert.match(html, /实施依据/);
    assert.match(html, /<table>/);
    assert.match(html, /自动读取上下文/);
  });

  it("does not treat terminal status or HTML as usable AI content", () => {
    assert.equal(hasSuggestedActionPlanContent({ summary: "completed", steps: [] }), false);
    assert.equal(hasSuggestedActionPlanContent({ summary: "", steps: ["completed"] }), false);
    assert.equal(hasDraftOutputContent({ title: "completed", summary: "", brief: "", points: [] }), false);
    assert.equal(hasDraftOutputContent({ title: "", summary: "<html><h1>Bad Gateway</h1></html>", brief: "" }), false);
    assert.equal(hasAiResultOutputContent({ title: "只有标题", summary: "只有摘要", points: [] }), false);
    assert.equal(hasAiResultOutputContent({ markdown: "| 维度 | 结果 |\n|---|---|\n| A | B |" }), true);
  });

  it("uses a separate AI result signature version from the draft card", () => {
    const node = createNode();
    const artifact = { title: "差异点草稿", docType: "Feishu Doc" };

    assert.notEqual(createAiResultSignature({ node, artifact }), createDraftOutputSignature({ node, artifact }));
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
    priority: "P2",
  };
}
