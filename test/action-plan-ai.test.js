import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findLocalActionPlanGenerator,
  generateSuggestedActionPlan,
  parseActionPlanOutput,
} from "../src/action-plan-ai.js";
import { CREATED_FROM, TASK_STATES, TASK_TAGS, createNode } from "../src/task-nodes.js";

describe("action plan AI", () => {
  it("leaves the suggested action plan blank when no local generator exists", async () => {
    const serviceRoot = mkdtempSync(join(tmpdir(), "polaris-no-generator-"));
    const plan = await generateSuggestedActionPlan({
      node: createTestNode(),
      serviceRoot,
      dataRoot: serviceRoot,
    });

    assert.deepEqual(plan, { summary: "", steps: [], provider: null });
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

  it("parses plain text generator output as ordered action steps", () => {
    const plan = parseActionPlanOutput("1. 收集输入\n2. 生成建议\n3. 回写结果");

    assert.equal(plan.summary, "");
    assert.deepEqual(plan.steps, ["收集输入", "生成建议", "回写结果"]);
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
