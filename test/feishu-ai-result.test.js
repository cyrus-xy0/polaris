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
        title: "火山服务器部署方案",
        summary: "明确部署落地要求。",
        brief: "围绕资源选型、容器化部署、健康检查和故障恢复形成可执行方案，保障 Web demo 能稳定访问。",
        points: ["资源选型", "容器部署"],
      },
      artifact: { docType: "飞书 Doc", title: "部署草稿" },
      actionPlan: {
        summary: "先定资源，再部署验证。",
        steps: ["确认服务器资源", "构建 Docker 镜像", "验证公网访问"],
      },
    });

    assert.match(xml, /<title>火山服务器部署方案<\/title>/);
    assert.match(xml, /<callout emoji="✅"/);
    assert.match(xml, /AI 结果 brief/);
    assert.match(xml, /实施依据：Suggest Action Plan/);
    assert.match(xml, /确认服务器资源/);
    assert.match(xml, /参考产物：飞书 Doc · 部署草稿/);
    assert.match(xml, /<li>资源选型<\/li>/);
  });
});
