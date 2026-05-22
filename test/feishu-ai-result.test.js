import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFeishuDocContent } from "../src/feishu-ai-result.js";

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
});
