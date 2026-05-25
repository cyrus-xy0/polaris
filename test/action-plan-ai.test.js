import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildAiResultOutputPrompt,
  buildDraftOutputPrompt,
  buildTaskNodeSplitPrompt,
  findLocalActionPlanGenerator,
  generateAiResultOutput,
  generateDraftOutput,
  generateSuggestedActionPlan,
  generateTaskNodeSplit,
  parseAiResultOutput,
  parseActionPlanOutput,
  parseDraftOutput,
  parseTaskNodeSplitOutput,
} from "../src/action-plan-ai.js";
import { CREATED_FROM, TASK_STATES, createNode } from "../src/task-nodes.js";

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

  it("leaves AI result output blank when no local generator exists", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-no-result-generator-"));
    const output = await generateAiResultOutput({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      env: { PATH: "" },
      includePath: false,
    });

    assert.deepEqual(output, {
      title: "",
      summary: "",
      resultType: "analysis",
      markdown: "",
      points: [],
      nextActions: [],
      shouldContinue: null,
      provider: null,
    });
  });

  it("leaves task-node split blank when no local generator exists", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-no-split-generator-"));
    const split = await generateTaskNodeSplit({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      env: { PATH: "" },
      includePath: false,
    });

    assert.deepEqual(split, { summary: "", nodes: [], provider: null });
  });

  it("uses a service-local openclaw executable before falling back to static steps", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'agent') process.exit(2);",
        "if (process.argv[3] !== '--agent') process.exit(3);",
        "if (process.argv[4] !== 'main') process.exit(4);",
        "const messageIndex = process.argv.indexOf('--message');",
        "if (messageIndex < 0) process.exit(5);",
        "if (!process.argv[messageIndex + 1].includes('测试节点')) process.exit(6);",
        "if (!process.argv.includes('--json')) process.exit(7);",
        "console.log(JSON.stringify({ response: JSON.stringify({ summary: '先收敛输入，再执行验证', steps: ['收集上下文', '生成行动计划', '记录判断'] }) }));",
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

  it("returns quickly when the local generator exceeds the configured timeout", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-timeout-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => { console.log(JSON.stringify({ response: JSON.stringify({ summary: '太晚了', steps: ['不应返回'] }) })); }, 1000);",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const startedAt = Date.now();
    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      timeoutMs: 50,
      includePath: false,
    });

    assert.equal(plan.provider, "openclaw");
    assert.deepEqual(plan.steps, []);
    assert.match(plan.error, /timed out after 50ms/);
    assert.ok(Date.now() - startedAt < 700);
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

  it("generates draft output through openclaw one-shot mode", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-draft-openclaw-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'agent') process.exit(2);",
        "if (process.argv[3] !== '--agent') process.exit(3);",
        "if (process.argv[4] !== 'main') process.exit(4);",
        "const prompt = process.argv[process.argv.indexOf('--message') + 1] || '';",
        "if (!prompt.includes('必须遵循的 Suggest Action Plan')) process.exit(4);",
        "if (!prompt.includes('读取上文')) process.exit(5);",
        "console.log(JSON.stringify({ response: JSON.stringify({ title: '按计划产出草稿', summary: '严格依据行动计划生成结果。', brief: '先读取上文，再应用本地 knowhow 和 skill，最后形成可检查的结果 brief，确保 Draft Output 与 Suggest Action Plan 保持一致。' }) }));",
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

  it("generates an executed AI result instead of a Draft Output card extraction", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-result-hermes-"));
    const commandPath = join(serviceRoot, "hermes");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'chat') process.exit(3);",
        "const prompt = process.argv[5] || '';",
        "if (!prompt.includes('真实产物')) process.exit(4);",
        "if (!prompt.includes('不是 Draft Output 卡片内容')) process.exit(5);",
        "console.log(JSON.stringify({ title: '案例迁移分析表', summary: '筛出三类可迁移模式。', resultType: 'analysis-table', markdown: '| 角色 | 案例 | 可迁移设计 |\\n|---|---|---|\\n| RevOps | Clari Copilot | Pipeline 风险预警 |', points: ['RevOps 优先进入', '从风险预警切入'], nextActions: ['把结果写入 Pitchdeck'], shouldContinue: true }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const output = await generateAiResultOutput({
      node: createTestNode(),
      artifact: { docType: "飞书 Base", title: "真实案例分析表", url: "https://example.feishu.cn/base/cases" },
      actionPlan: {
        summary: "按案例路径执行。",
        steps: ["筛案例", "写分析表", "判断迁移"],
      },
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(output.provider, "hermes");
    assert.equal(output.title, "案例迁移分析表");
    assert.match(output.markdown, /\| 角色 \| 案例 \| 可迁移设计 \|/);
    assert.deepEqual(output.points, ["RevOps 优先进入", "从风险预警切入"]);
    assert.equal(output.shouldContinue, true);
  });

  it("does not render OpenClaw diagnostic output as AI content", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-diagnostic-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "console.log('Crestodian online. Little claws, typed tools.');",
        "console.log('Default agent: main');",
        "console.log('Gateway: reachable (ws://127.0.0.1:18789, local loopback)');",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(plan.provider, "openclaw");
    assert.deepEqual(plan.steps, []);
    assert.match(plan.error, /Crestodian 状态信息/);
  });

  it("does not render OpenClaw completion status as AI content", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-completed-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ status: 'completed', output: 'completed' }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(plan.provider, "openclaw");
    assert.deepEqual(plan.steps, []);
    assert.match(plan.error, /只返回了 completed 状态/);
  });

  it("extracts real OpenClaw content instead of terminal status text", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-content-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({",
        "  status: 'completed',",
        "  output: 'completed',",
        "  result: { content: [{ type: 'text', text: JSON.stringify({ summary: '真实内容已返回', steps: ['读取上下文', '生成计划', '写入结果'] }) }] }",
        "}));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(plan.provider, "openclaw");
    assert.equal(plan.summary, "真实内容已返回");
    assert.deepEqual(plan.steps, ["读取上下文", "生成计划", "写入结果"]);
  });

  it("can target a configured OpenClaw agent from the environment", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-openclaw-agent-env-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'agent') process.exit(2);",
        "if (process.argv[3] !== '--agent') process.exit(3);",
        "if (process.argv[4] !== 'qa') process.exit(4);",
        "console.log(JSON.stringify({ response: JSON.stringify({ summary: '指定 qa agent 生成', steps: ['读取上下文', '输出计划', '保存结果'] }) }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      env: { ...process.env, POLARIS_OPENCLAW_AGENT: "qa" },
      includePath: false,
    });

    assert.equal(plan.provider, "openclaw");
    assert.equal(plan.summary, "指定 qa agent 生成");
    assert.deepEqual(plan.steps, ["读取上下文", "输出计划", "保存结果"]);
  });

  it("generates task-node split through openclaw", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-split-openclaw-"));
    const commandPath = join(serviceRoot, "openclaw");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] !== 'agent') process.exit(2);",
        "if (process.argv[3] !== '--agent') process.exit(3);",
        "if (process.argv[4] !== 'main') process.exit(4);",
        "const prompt = process.argv[process.argv.indexOf('--message') + 1] || '';",
        "if (!prompt.includes('任务节点拆解助手')) process.exit(4);",
        "if (!prompt.includes('测试节点')) process.exit(5);",
        "console.log(JSON.stringify({ response: JSON.stringify({ summary: '先理解，再执行，再验证', nodes: [{ title: '明确判断口径', description: '确认输入和完成标准。', aiActions: ['读取输入', '写出口径'] }, { title: '执行最小验证', description: '完成一个可检查的验证动作。', aiActions: ['执行验证', '记录结果'] }] }) }));",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const split = await generateTaskNodeSplit({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
      includePath: false,
    });

    assert.equal(split.provider, "openclaw");
    assert.equal(split.summary, "先理解，再执行，再验证");
    assert.deepEqual(
      split.nodes.map((node) => node.title),
      ["明确判断口径", "执行最小验证"],
    );
  });

  it("parses plain text generator output as ordered action steps", () => {
    const plan = parseActionPlanOutput("1. 收集输入\n2. 生成建议\n3. 回写结果");

    assert.equal(plan.summary, "");
    assert.deepEqual(plan.steps, ["收集输入", "生成建议", "回写结果"]);
  });

  it("treats terminal status text as empty generator output", () => {
    assert.deepEqual(parseActionPlanOutput("completed"), { summary: "", steps: [], provider: null });
    assert.deepEqual(parseDraftOutput("completed"), { title: "", summary: "", brief: "", points: [], provider: null });
    assert.deepEqual(parseAiResultOutput("completed"), {
      title: "",
      summary: "",
      resultType: "analysis",
      markdown: "",
      points: [],
      nextActions: [],
      shouldContinue: null,
      provider: null,
    });
    assert.deepEqual(parseTaskNodeSplitOutput("completed"), { summary: "", nodes: [], provider: null });
  });

  it("parses plain text draft output as points", () => {
    const output = parseDraftOutput("1. 背景判断\n2. 核心差异\n3. 验收标准");

    assert.equal(output.title, "");
    assert.equal(output.brief, "背景判断；核心差异；验收标准");
    assert.deepEqual(output.points, ["背景判断", "核心差异", "验收标准"]);
  });

  it("parses plain text AI result output as markdown content", () => {
    const output = parseAiResultOutput("1. 已完成案例筛选\n2. 已形成迁移判断");

    assert.equal(output.summary, "已完成案例筛选");
    assert.equal(output.markdown, "1. 已完成案例筛选\n2. 已形成迁移判断");
    assert.deepEqual(output.points, ["已完成案例筛选", "已形成迁移判断"]);
  });

  it("parses plain text task-node split as executable child nodes", () => {
    const split = parseTaskNodeSplitOutput("1. 明确输入\n2. 执行验证\n3. 记录结论");

    assert.equal(split.summary, "");
    assert.deepEqual(
      split.nodes.map((node) => node.title),
      ["明确输入", "执行验证", "记录结论"],
    );
    assert.deepEqual(split.nodes[0].aiActions, ["明确输入", "执行最小动作", "记录结果"]);
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
        taskLineage: [{ title: "北极星目标", state: "待做", description: "找到 ToB AI 场景。" }],
        upstreamTasks: [{ title: "前置判断", state: "完成", description: "已验证。", result: { url: "https://example.feishu.cn/docx/result" } }],
        knowledge: [{ type: "Knowhow", title: "AI-native 原则", description: "读上下文、执行动作、沉淀结果。", markdown: "不要只把 AI 当输入框。" }],
        skills: [{ type: "Skill", title: "反证优先", description: "先找失败证据。" }],
        artifacts: [{ type: "产物", title: "前置结果", description: "已完成材料。", url: "https://example.feishu.cn/docx/result" }],
        accumulatedResults: [{ title: "已完成任务", state: "完成", description: "沉淀结论。", conclusion: { shouldContinue: true } }],
      },
    });

    assert.match(prompt, /任务上文输入/);
    assert.match(prompt, /Knowhow \/ 知识库/);
    assert.match(prompt, /Skill \/ 可复用能力/);
    assert.match(prompt, /其他任务积累结果/);
    assert.match(prompt, /不要只把 AI 当输入框/);
    assert.match(prompt, /必须遵循的 Suggest Action Plan/);
    assert.match(prompt, /1\. 读取上文/);
    assert.match(prompt, /优先级：P2/);
  });

  it("builds AI result prompts for actual task outputs", () => {
    const prompt = buildAiResultOutputPrompt({
      node: createTestNode(),
      artifact: { docType: "飞书 Base", title: "真实案例分析表", url: "https://example.feishu.cn/base/cases" },
      actionPlan: {
        summary: "按计划产出实际结果。",
        steps: ["筛案例", "写入分析表", "判断是否继续"],
      },
    });

    assert.match(prompt, /查看 AI 结果/);
    assert.match(prompt, /不是 Draft Output 卡片内容/);
    assert.match(prompt, /Markdown 表格/);
    assert.match(prompt, /真实案例分析表/);
    assert.match(prompt, /1\. 筛案例/);
  });

  it("builds task-node split prompts from node title and description", () => {
    const prompt = buildTaskNodeSplitPrompt({
      node: createTestNode(),
      aiContext: {
        taskLineage: [{ title: "北极星目标", state: "待做", description: "找到 ToB AI 场景。" }],
      },
    });

    assert.match(prompt, /任务节点拆解助手/);
    assert.match(prompt, /测试节点/);
    assert.match(prompt, /预拆分成一组可执行子节点/);
    assert.match(prompt, /北极星目标/);
  });
});

function createTestNode() {
  return createNode({
    id: "test-node",
    title: "测试节点",
    description: "验证本地生成器能根据节点上下文生成建议步骤。",
    aiActions: ["旧步骤"],
    dependencies: [],
    state: TASK_STATES.TODO,
    createdFrom: CREATED_FROM.USER,
  });
}
