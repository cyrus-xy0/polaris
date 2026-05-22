import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { buildFeishuDocContent, publishAiResultToFeishu } from "../src/feishu-ai-result.js";

describe("Feishu AI result publisher", () => {
  it("builds DocxXML content for the user-owned result document", () => {
    const xml = buildFeishuDocContent({
      node: {
        id: "setup-volcano-deploy",
        title: "准备火山服务器部署",
        description: "让 Web demo 后续能变成可持续访问的服务。",
      },
      output: {
        title: "火山服务器部署结果",
        summary: "明确部署落地要求。",
        markdown:
          "| 模块 | 结果 |\n|---|---|\n| 资源选型 | 2C4G 起步 |\n| 容器部署 | Docker Compose 管理服务 |",
        points: ["资源选型完成", "容器部署路径明确"],
        nextActions: ["补充健康检查脚本"],
      },
      artifact: { docType: "飞书 Doc", title: "部署草稿", url: "https://example.feishu.cn/docx/deploy" },
      actionPlan: {
        summary: "先定资源，再部署验证。",
        steps: ["确认服务器资源", "构建 Docker 镜像", "验证公网访问"],
      },
    });

    assert.match(xml, /<title>火山服务器部署结果<\/title>/);
    assert.match(xml, /<callout emoji="✅"/);
    assert.match(xml, /实际结果/);
    assert.match(xml, /<table>/);
    assert.match(xml, /<th background-color="light-gray">模块<\/th>/);
    assert.match(xml, /Docker Compose 管理服务/);
    assert.match(xml, /实施依据：Suggest Action Plan/);
    assert.match(xml, /确认服务器资源/);
    assert.match(xml, /href="https:\/\/example.feishu.cn\/docx\/deploy"/);
    assert.match(xml, /<li>资源选型完成<\/li>/);
    assert.match(xml, /补充健康检查脚本/);
  });

  it("creates a skeleton first and appends long AI result documents", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-feishu-publish-"));
    const binDir = mkdtempSync(join(tmpdir(), "polaris-lark-cli-"));
    const logPath = join(dataRoot, "lark-cli-log.jsonl");
    const commandPath = join(binDir, "lark-cli");
    writeFileSync(
      commandPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const contentArg = args[args.indexOf('--content') + 1] || '';",
        "const contentPath = contentArg.startsWith('@') ? path.resolve(process.cwd(), contentArg.slice(1)) : '';",
        "const content = contentPath ? fs.readFileSync(contentPath, 'utf8') : contentArg;",
        "fs.appendFileSync(process.env.LARK_CLI_LOG, JSON.stringify({ args, contentLength: content.length, content }) + '\\n');",
        "if (args[0] === 'docs' && args[1] === '+create') {",
        "  console.log(JSON.stringify({ ok: true, data: { document: { url: 'https://bytedance.larkoffice.com/docx/test-long-result' } } }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'docs' && args[1] === '+update' && args.includes('append')) {",
        "  console.log(JSON.stringify({ ok: true }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
    );
    chmodSync(commandPath, 0o755);

    const longRows = Array.from(
      { length: 42 },
      (_, index) => `| 角色 ${index + 1} | 案例 ${index + 1} | 可迁移设计 ${index + 1} |`,
    ).join("\n");
    const result = await publishAiResultToFeishu({
      dataRoot,
      node: {
        id: "study-real-cases",
        title: "实际落地案例学习",
        description: "学习真实落地案例，避免凭空设计。",
      },
      output: {
        title: "ToB Agent 落地案例分析表",
        summary: "已完成案例筛选和迁移分析。",
        markdown: `| 角色 | 案例 | 可迁移设计 |\n|---|---|---|\n${longRows}`,
        points: ["保留高频流程样本", "GTM 和 Pitchdeck 各有最近似案例"],
      },
      actionPlan: {
        summary: "按角色筛案例并写入分析表。",
        steps: ["筛案例", "写分析表", "判断迁移"],
      },
      timeoutMs: 2_000,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        LARK_CLI_LOG: logPath,
      },
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(result.url, "https://bytedance.larkoffice.com/docx/test-long-result");
    assert.equal(calls[0].args[1], "+create");
    assert.match(calls[0].content, /<title>ToB Agent 落地案例分析表<\/title>/);
    assert.doesNotMatch(calls[0].content, /角色 42/);
    assert.equal(calls[1].args[1], "+update");
    assert.match(calls.slice(1).map((call) => call.content).join(""), /角色 42/);
  });
});
