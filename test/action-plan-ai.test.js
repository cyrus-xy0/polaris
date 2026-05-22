import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildDraftOutputPrompt,
  findLocalActionPlanGenerator,
  generateDraftOutput,
  generateSuggestedActionPlan,
  parseActionPlanOutput,
  parseDraftOutput,
} from "../src/action-plan-ai.js";
import { CREATED_FROM, TASK_STATES, TASK_TAGS, createNode } from "../src/task-nodes.js";

describe("action plan AI", () => {
  it("leaves the suggested action plan blank when no local generator exists", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-no-generator-"));
    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      env: { PATH: "" },
      includePath: false,
    });

    assert.deepEqual(plan, { summary: "", steps: [], provider: null });
  });

  it("leaves draft output blank when no local generator exists", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-no-draft-generator-"));
    const output = await generateDraftOutput({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      env: { PATH: "" },
      includePath: false,
    });

    assert.deepEqual(output, { title: "", summary: "", brief: "", points: [], provider: null });
  });

  it("uses a service-local openclaw executable before falling back to static steps", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (!input.includes('测试节点')) process.exit(2);",
        "  console.log(JSON.stringify({ summary: '先收敛输入，再执行验证', steps: ['收集上下文', '生成行动计划', '记录判断'] }));",
        "});",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const generator = findLocalActionPlanGenerator({ serviceRoot });
    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
    });

    assert.equal(generator.name, "openclaw");
    assert.equal(plan.provider, "openclaw");
    assert.equal(plan.summary, "先收敛输入，再执行验证");
    assert.deepEqual(plan.steps, ["收集上下文", "生成行动计划", "记录判断"]);
  });

  it("runs hermes in quiet query mode so the output is generated text", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-hermes-"));
    const commandPath = join(serviceRoot, "hermes");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'chat') process.exit(3);",
        "if (process.argv[3] !== '--quiet') process.exit(4);",
        "if (process.argv[4] !== '--query') process.exit(5);",
        "if (!process.argv[5].includes('测试节点')) process.exit(6);",
        "console.log(JSON.stringify({ summary: 'Hermes 已生成建议', steps: ['读取节点上下文', '生成建议步骤', '返回结构化结果'] }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
    });

    assert.equal(plan.provider, "hermes");
    assert.equal(plan.summary, "Hermes 已生成建议");
    assert.deepEqual(plan.steps, ["读取节点上下文", "生成建议步骤", "返回结构化结果"]);
  });

  it("can discover a local hermes executable from PATH after service-local locations", () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-path-service-"));
    const pathRoot = mkdtempSync(join(tmpdir(), "polaris-path-bin-"));
    const commandPath = join(pathRoot, "hermes");
    writeFileSync(commandPath, "#!/bin/sh\nexit 0\n");
    chmodSync(commandPath, 0o755);

    const generator = findLocalActionPlanGenerator({
      serviceRoot,
      dataRoot: serviceRoot,
      env: { PATH: pathRoot },
    });

    assert.equal(generator.name, "hermes");
    assert.equal(generator.commandPath, commandPath);
  });

  it("generates draft output through hermes", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-draft-hermes-"));
    const commandPath = join(serviceRoot, "hermes");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'chat') process.exit(3);",
        "if (!process.argv[5].includes('Draft Output')) process.exit(4);",
        "console.log(JSON.stringify({ title: '差异点定义草稿', summary: '说明草稿要验证的关键差异。', brief: '围绕传统方案与 AI-native 方案的关键差异，提炼判断标准和反证方法，帮助后续 demo 设计保持代际差异。' }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const output = await generateDraftOutput({
      node: createTestNode(),
      artifact: { docType: "飞书 Doc", title: "测试草稿" },
      serviceRoot,
      dataRoot: serviceRoot,
    });

    assert.equal(output.provider, "hermes");
    assert.equal(output.title, "差异点定义草稿");
    assert.equal(output.summary, "说明草稿要验证的关键差异。");
    assert.equal(
      output.brief,
      "围绕传统方案与 AI-native 方案的关键差异，提炼判断标准和反证方法，帮助后续 demo 设计保持代际差异。",
    );
    assert.deepEqual(output.points, []);
  });

  it("generates draft output through openclaw with the action plan on stdin", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-draft-openclaw-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (!input.includes('必须遵循的 Suggest Action Plan')) process.exit(4);",
        "  if (!input.includes('读取上文')) process.exit(5);",
        "  console.log(JSON.stringify({ title: '按计划产出草稿', summary: '严格依据行动计划生成结果。', brief: '先读取上文，再应用本地 knowhow 和 skill，最后形成可检查的结果 brief，确保 Draft Output 与 Suggest Action Plan 保持一致。' }));",
        "});",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const output = await generateDraftOutput({
      node: createTestNode(),
      artifact: { docType: "飞书 Doc", title: "测试草稿" },
      actionPlan: {
        summary: "按计划执行。",
        steps: ["读取上文", "应用 knowhow", "生成结果"],
      },
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(output.provider, "openclaw");
    assert.equal(output.title, "按计划产出草稿");
    assert.match(output.brief, /Suggest Action Plan/);
  });

  it("parses plain text generator output as ordered action steps", () => {
    const plan = parseActionPlanOutput("1. 收集输入\n2. 生成建议\n3. 回写结果");

    assert.equal(plan.summary, "");
    assert.deepEqual(plan.steps, ["收集输入", "生成建议", "回写结果"]);
  });

  it("parses plain text draft output as points", () => {
    const output = parseDraftOutput("1. 背景判断\n2. 核心差异\n3. 验收标准");

    assert.equal(output.title, "");
    assert.equal(output.brief, "背景判断；核心差异；验收标准");
    assert.deepEqual(output.points, ["背景判断", "核心差异", "验收标准"]);
  });

  it("parses draft JSON embedded in diff-like model output", () => {
    const output = parseDraftOutput(
      [
        "┊ review diff",
        '+{"title":"差异界定","summary":"明确关键差异。","points":["逻辑差异","反证标准","验收方法"]}',
      ].join("\n"),
    );

    assert.equal(output.title, "差异界定");
    assert.equal(output.summary, "明确关键差异。");
    assert.equal(output.brief, "逻辑差异；反证标准；验收方法");
    assert.deepEqual(output.points, ["逻辑差异", "反证标准", "验收方法"]);
  });

  it("includes lineage, knowhow, skills, and accumulated results in draft prompts", () => {
    const prompt = buildDraftOutputPrompt({
      node: createTestNode(),
      actionPlan: {
        summary: "按计划落地。",
        steps: ["读取上文", "应用 knowhow", "生成结果"],
      },
      aiContext: {
        taskLineage: [{ title: "北极星目标", tag: "思考", state: "待做", description: "找到 ToB AI 场景。" }],
        upstreamTasks: [{ title: "前置判断", tag: "验证", state: "完成", description: "已验证。", result: { url: "https://example.feishu.cn/docx/result" } }],
        knowledge: [{ type: "Knowhow", title: "AI-native 原则", description: "读上下文、执行动作、沉淀结果。", markdown: "不要只把 AI 当输入框。" }],
        skills: [{ type: "Skill", title: "反证优先", description: "先找失败证据。" }],
        artifacts: [{ type: "产物", title: "前置结果", description: "已完成材料。", url: "https://example.feishu.cn/docx/result" }],
        accumulatedResults: [{ title: "已完成任务", tag: "整理", state: "完成", description: "沉淀结论。", conclusion: { shouldContinue: true } }],
      },
    });

    assert.match(prompt, /任务上文输入/);
    assert.match(prompt, /Knowhow \/ 知识库/);
    assert.match(prompt, /Skill \/ 可复用能力/);
    assert.match(prompt, /其他任务积累结果/);
    assert.match(prompt, /不要只把 AI 当输入框/);
    assert.match(prompt, /必须遵循的 Suggest Action Plan/);
    assert.match(prompt, /1\. 读取上文/);
  });
});

function createTestNode() {
  return createNode({
    id: "test-node",
    title: "测试节点",
    tag: TASK_TAGS.EXECUTE,
    description: "验证本地生成器能根据节点上下文生成建议步骤。",
    aiActions: ["旧步骤"],
    dependencies: [],
    state: TASK_STATES.TODO,
    createdFrom: CREATED_FROM.USER,
  });
}
