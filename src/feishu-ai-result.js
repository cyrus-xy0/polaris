import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderMarkdownToFeishuXml } from "./markdown-renderer.js";

const defaultTimeoutMs = 120_000;

export async function publishAiResultToFeishu({
  dataRoot,
  node,
  output,
  artifact = null,
  actionPlan = null,
  timeoutMs = defaultTimeoutMs,
}) {
  const contentPath = writeFeishuDocSource({ dataRoot, node, output, artifact, actionPlan });
  const cliOutput = await runLarkCli(
    [
      "docs",
      "+create",
      "--api-version",
      "v2",
      "--as",
      "user",
      "--parent-position",
      "my_library",
      "--content",
      `@${basename(contentPath)}`,
    ],
    { cwd: dirname(contentPath), timeoutMs },
  );
  const url = extractCreatedDocUrl(cliOutput);
  if (!url) {
    throw new Error("飞书文档已创建但未返回 URL。");
  }

  return {
    title: output.title || `${node.title} AI 结果`,
    docType: "飞书 Doc",
    url,
    path: contentPath,
  };
}

export function buildFeishuDocContent({ node, output, artifact = null, actionPlan = null }) {
  const title = output.title || `${node.title} AI 结果`;
  const brief = output.summary || output.brief || node.description;
  const points = Array.isArray(output.points) ? output.points : [];
  const nextActions = Array.isArray(output.nextActions) ? output.nextActions.filter(Boolean) : [];
  const resultBody = output.markdown ? renderMarkdownToFeishuXml(output.markdown) : "";
  const artifactLine = artifact?.title
    ? `<p>参考产物：${renderArtifactXml(artifact)}</p>`
    : "";
  const pointList =
    points.length > 0
      ? `<h1>关键结论</h1><ul>${points.map((point) => `<li>${escapeXml(point)}</li>`).join("")}</ul>`
      : "";
  const nextActionList =
    nextActions.length > 0
      ? `<h1>后续动作</h1><ul>${nextActions.map((action) => `<li>${escapeXml(action)}</li>`).join("")}</ul>`
      : "";
  const actionPlanSteps = Array.isArray(actionPlan?.steps) ? actionPlan.steps.filter(Boolean) : [];
  const actionPlanSection =
    actionPlanSteps.length > 0
      ? `<h1>实施依据：Suggest Action Plan</h1><p>${escapeXml(actionPlan.summary ?? "以下步骤是本结果的实施约束。")}</p><ol>${actionPlanSteps.map((step) => `<li seq="auto">${escapeXml(step)}</li>`).join("")}</ol>`
      : "";

  return [
    `<title>${escapeXml(title)}</title>`,
    `<callout emoji="✅" background-color="light-green" border-color="green"><p>${escapeXml(brief)}</p></callout>`,
    "<h1>任务节点</h1>",
    `<p>${escapeXml(node.title)}</p>`,
    `<p>${escapeXml(node.description)}</p>`,
    artifactLine,
    "<hr/>",
    actionPlanSection,
    actionPlanSection ? "<hr/>" : "",
    "<h1>实际结果</h1>",
    resultBody || `<p>${escapeXml(output.brief || brief)}</p>`,
    pointList,
    nextActionList,
  ]
    .filter(Boolean)
    .join("");
}

function writeFeishuDocSource({ dataRoot, node, output, artifact, actionPlan }) {
  const filePath = resolveFeishuDocSourcePath({ dataRoot, nodeId: node.id, title: output.title });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buildFeishuDocContent({ node, output, artifact, actionPlan }), "utf8");
  return filePath;
}

function resolveFeishuDocSourcePath({ dataRoot, nodeId, title }) {
  const raw = `${nodeId}:${title ?? ""}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const safeNodeId = String(nodeId ?? "node")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return join(resolve(dataRoot), "ai-results", "feishu-doc-source", `${safeNodeId || "node"}-${hash}.xml`);
}

function runLarkCli(args, { cwd, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("lark-cli", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectPromise(new Error("创建飞书文档超时。"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(extractCliError(stderr) || extractCliError(stdout) || `lark-cli exited with code ${code}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function extractCreatedDocUrl(output) {
  const payload = parseJson(output);
  return payload?.data?.document?.url ?? payload?.document?.url ?? "";
}

function extractCliError(output) {
  const payload = parseJson(output);
  return payload?.error?.message || payload?.message || output.trim();
}

function parseJson(output) {
  const text = String(output ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const objectStart = text.indexOf("{");
    const objectEnd = text.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        return JSON.parse(text.slice(objectStart, objectEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function renderArtifactXml(artifact) {
  const label = `${artifact.docType ?? "Output"} · ${artifact.title}`;
  if (!artifact.url) return escapeXml(label);
  return `<a href="${escapeXmlAttribute(artifact.url)}">${escapeXml(label)}</a>`;
}

function escapeXmlAttribute(value) {
  return escapeXml(value).replace(/"/g, "&quot;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
