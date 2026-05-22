import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const aiResultDirName = "ai-results";

const aiContextVersion = "rich-context-v3-openclaw-content";

export function createAiContextDigest(aiContext = null) {
  return createHash("sha256").update(JSON.stringify(aiContext ?? null)).digest("hex").slice(0, 16);
}

export function createSuggestedActionPlanSignature({ node, reason = "", contextDigest = "" }) {
  return JSON.stringify({
    version: aiContextVersion,
    id: node.id,
    title: node.title,
    tag: node.tag,
    description: node.description,
    dependencies: node.dependencies,
    state: node.state,
    reason,
    contextDigest,
  });
}

export function createDraftOutputSignature({ node, artifact = null, contextDigest = "", actionPlanDigest = "" }) {
  return JSON.stringify({
    version: aiContextVersion,
    id: node.id,
    title: node.title,
    tag: node.tag,
    description: node.description,
    dependencies: node.dependencies,
    state: node.state,
    artifactTitle: artifact?.title ?? "",
    artifactType: artifact?.docType ?? "",
    contextDigest,
    actionPlanDigest,
  });
}

export function createAiResultSignature({ node, artifact = null, contextDigest = "", actionPlanDigest = "" }) {
  return createDraftOutputSignature({ node, artifact, contextDigest, actionPlanDigest });
}

export function readAiResult({ dataRoot, kind, nodeId, signature = null }) {
  const filePath = resolveAiResultPath({ dataRoot, kind, nodeId });
  if (!existsSync(filePath)) return null;

  const record = JSON.parse(readFileSync(filePath, "utf8"));
  if (record.kind !== kind || record.nodeId !== nodeId) return null;
  if (signature !== null && record.signature !== signature) return null;
  return {
    ...record,
    filePath,
  };
}

export function writeAiResult({ dataRoot, kind, nodeId, signature, payload }) {
  const filePath = resolveAiResultPath({ dataRoot, kind, nodeId });
  mkdirSync(dirname(filePath), { recursive: true });

  const record = {
    kind,
    nodeId,
    signature,
    updatedAt: new Date().toISOString(),
    ...payload,
  };
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
  return readAiResult({ dataRoot, kind, nodeId, signature });
}

export function writeAiResultDocument({ dataRoot, node, signature, output, artifact = null, actionPlan = null }) {
  const title = output.title || `${node.title} AI 结果`;
  const filePath = resolveAiResultDocumentPath({ dataRoot, nodeId: node.id, signature });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderAiResultHtml({ title, node, output, artifact, actionPlan }), "utf8");

  const relativePath = relative(join(resolve(dataRoot), aiResultDirName), filePath);
  return {
    title,
    docType: "本地 HTML",
    url: `/ai-results/${relativePath.split("/").join("/")}`,
    path: filePath,
  };
}

export function hasSuggestedActionPlanContent(plan = {}) {
  const summary = typeof plan.summary === "string" ? plan.summary.trim() : "";
  const steps = Array.isArray(plan.steps) ? plan.steps.filter(hasMeaningfulAiText) : [];
  return hasMeaningfulAiText(summary) || steps.length > 0;
}

export function hasDraftOutputContent(output = {}) {
  return (
    hasMeaningfulAiText(output.title) ||
    hasMeaningfulAiText(output.summary) ||
    hasMeaningfulAiText(output.brief) ||
    (Array.isArray(output.points) && output.points.some(hasMeaningfulAiText))
  );
}

function hasMeaningfulAiText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return false;
  if (/^(completed|complete|succeeded|success|done|finished|ok)$/i.test(text)) return false;
  if (/^<(!doctype|html|head|body)\b/i.test(text)) return false;
  return true;
}

function resolveAiResultPath({ dataRoot, kind, nodeId }) {
  return join(resolve(dataRoot), aiResultDirName, safePathSegment(kind), `${createNodeFileName(nodeId)}.json`);
}

function resolveAiResultDocumentPath({ dataRoot, nodeId, signature }) {
  const signatureHash = createHash("sha256").update(signature).digest("hex").slice(0, 10);
  return join(resolve(dataRoot), aiResultDirName, "documents", `${createNodeFileName(nodeId)}-${signatureHash}.html`);
}

function createNodeFileName(nodeId) {
  const raw = String(nodeId ?? "node");
  const safe = safePathSegment(raw).slice(0, 80) || "node";
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  return `${safe}-${hash}`;
}

function safePathSegment(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderAiResultHtml({ title, node, output, artifact, actionPlan }) {
  const points = Array.isArray(output.points) ? output.points : [];
  const brief = output.brief || points.join("；") || output.summary || node.description;
  const sourceArtifact = artifact?.title
    ? `<p class="meta">参考产物：${escapeHtml(artifact.docType ?? "Output")} · ${escapeHtml(artifact.title)}</p>`
    : "";
  const actionPlanSteps = Array.isArray(actionPlan?.steps) ? actionPlan.steps.filter(Boolean) : [];
  const actionPlanSection =
    actionPlanSteps.length > 0
      ? `<h2>实施依据</h2><p>${escapeHtml(actionPlan.summary ?? "以下步骤是本结果的实施约束。")}</p><ul>${actionPlanSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ul>`
      : "";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        color: #172026;
        background: #f7f6ef;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.7;
      }
      main {
        max-width: 820px;
        margin: 0 auto;
        padding: 56px 24px 72px;
      }
      article {
        border: 1px solid rgba(23, 32, 38, 0.1);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.82);
        padding: 36px;
        box-shadow: 0 24px 70px rgba(34, 42, 38, 0.08);
      }
      .kicker,
      .meta {
        margin: 0 0 10px;
        color: #317f74;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0;
      }
      h1 {
        margin: 0 0 18px;
        font-size: 34px;
        line-height: 1.18;
        letter-spacing: 0;
      }
      h2 {
        margin: 32px 0 12px;
        font-size: 18px;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: rgba(23, 32, 38, 0.72);
      }
      ul {
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      li {
        border: 1px solid rgba(49, 127, 116, 0.13);
        border-radius: 8px;
        background: #ffffff;
        padding: 14px 16px;
        color: rgba(23, 32, 38, 0.76);
      }
    </style>
  </head>
  <body>
    <main>
      <article>
        <p class="kicker">Polaris AI Result</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(output.summary || node.description)}</p>
        ${sourceArtifact}
        ${actionPlanSection}
        <h2>结果 brief</h2>
        <p>${escapeHtml(brief)}</p>
        ${points.length > 0 ? `<h2>关键内容</h2><ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}
      </article>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
