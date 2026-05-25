import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { renderMarkdownToHtml } from "./markdown-renderer.js";

const aiResultDirName = "ai-results";

const legacyAiContextVersion = "rich-context-v3-openclaw-content";
const aiAnalysisCacheVersion = "task-card-v1";
const aiResultVersion = "executed-ai-result-v2";

export function createAiContextDigest(aiContext = null) {
  return createHash("sha256").update(JSON.stringify(aiContext ?? null)).digest("hex").slice(0, 16);
}

export function createSuggestedActionPlanSignature({ node, reason = "", contextDigest = "" }) {
  return JSON.stringify({
    version: aiAnalysisCacheVersion,
    ...serializeTaskCardSignature(node),
  });
}

export function createDraftOutputSignature({ node, artifact = null, contextDigest = "", actionPlanDigest = "" }) {
  return JSON.stringify({
    version: aiAnalysisCacheVersion,
    ...serializeTaskCardSignature(node),
    artifactTitle: artifact?.title ?? "",
    artifactType: artifact?.docType ?? "",
  });
}

export function createAiResultSignature({ node, artifact = null, contextDigest = "", actionPlanDigest = "" }) {
  return JSON.stringify({
    version: aiAnalysisCacheVersion,
    resultVersion: aiResultVersion,
    ...serializeTaskCardSignature(node),
    artifactTitle: artifact?.title ?? "",
    artifactType: artifact?.docType ?? "",
  });
}

export function readAiResult({ dataRoot, aiResultsRoot = null, kind, nodeId, signature = null }) {
  const filePath = resolveAiResultPath({ dataRoot, aiResultsRoot, kind, nodeId });
  if (!existsSync(filePath)) return null;

  const record = JSON.parse(readFileSync(filePath, "utf8"));
  if (record.kind !== kind || record.nodeId !== nodeId) return null;
  if (signature !== null && !signaturesMatchForCache(kind, record.signature, signature)) return null;
  return {
    ...record,
    filePath,
  };
}

export function writeAiResult({ dataRoot, aiResultsRoot = null, kind, nodeId, signature, payload }) {
  const filePath = resolveAiResultPath({ dataRoot, aiResultsRoot, kind, nodeId });
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
  return readAiResult({ dataRoot, aiResultsRoot, kind, nodeId, signature });
}

export function writeAiResultDocument({
  dataRoot,
  aiResultsRoot = null,
  node,
  signature,
  output,
  artifact = null,
  actionPlan = null,
  existingResult = null,
}) {
  const title = output.title || `${node.title} AI 结果`;
  const filePath =
    resolveExistingAiResultDocumentPath({ dataRoot, aiResultsRoot, existingResult }) ??
    resolveAiResultDocumentPath({ dataRoot, aiResultsRoot, nodeId: node.id, signature });
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderAiResultHtml({ title, node, output, artifact, actionPlan }), "utf8");

  const relativePath = relative(resolveAiResultRoot({ dataRoot, aiResultsRoot }), filePath);
  return {
    title,
    docType: "本地 HTML",
    url: `/ai-results/${relativePath.split(/[\\/]/).join("/")}`,
    path: filePath,
  };
}

function resolveExistingAiResultDocumentPath({ dataRoot, aiResultsRoot = null, existingResult = null }) {
  if (existingResult?.docType !== "本地 HTML") return null;
  if (typeof existingResult.path !== "string" || !existingResult.path.trim()) return null;
  const root = resolveAiResultRoot({ dataRoot, aiResultsRoot });
  const filePath = resolve(existingResult.path);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;
  if (!filePath.endsWith(".html")) return null;
  return filePath;
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

export function hasAiResultOutputContent(output = {}) {
  return (
    hasMeaningfulAiText(output.markdown) ||
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

function resolveAiResultRoot({ dataRoot, aiResultsRoot = null }) {
  if (typeof aiResultsRoot === "string" && aiResultsRoot.trim()) {
    return resolve(aiResultsRoot);
  }
  return join(resolve(dataRoot), aiResultDirName);
}

function resolveAiResultPath({ dataRoot, aiResultsRoot = null, kind, nodeId }) {
  return join(resolveAiResultRoot({ dataRoot, aiResultsRoot }), safePathSegment(kind), `${createNodeFileName(nodeId)}.json`);
}

function serializeTaskCardSignature(node) {
  return {
    id: node.id,
    title: node.title,
    description: node.description,
    dependencies: normalizeSignatureArray(node.dependencies),
    state: node.state,
    priority: node.priority ?? "P2",
  };
}

function signaturesMatchForCache(kind, savedSignature, requestedSignature) {
  if (savedSignature === requestedSignature) return true;

  const saved = parseSignature(savedSignature);
  const requested = parseSignature(requestedSignature);
  if (!saved || !requested) return false;
  if (!isCompatibleSignatureVersion(saved.version, requested.version)) return false;
  if (!sameSignatureValue(saved.id, requested.id)) return false;
  if (!sameSignatureValue(saved.title, requested.title)) return false;
  if (!sameSignatureValue(saved.description, requested.description)) return false;
  if (!sameSignatureValue(saved.state, requested.state)) return false;
  if (!sameSignatureValue(saved.priority ?? "P2", requested.priority ?? "P2")) return false;
  if (!sameSignatureArray(saved.dependencies, requested.dependencies)) return false;

  if (kind === "draft-output" || kind === "ai-result" || kind === "ai-result-output") {
    if (!sameSignatureValue(saved.artifactTitle, requested.artifactTitle)) return false;
    if (!sameSignatureValue(saved.artifactType, requested.artifactType)) return false;
  }

  if (kind === "ai-result" || kind === "ai-result-output") {
    if (!sameSignatureValue(saved.resultVersion, requested.resultVersion)) return false;
  }

  return true;
}

function parseSignature(signature) {
  try {
    return JSON.parse(signature);
  } catch {
    return null;
  }
}

function isCompatibleSignatureVersion(savedVersion, requestedVersion) {
  if (savedVersion === requestedVersion) return true;
  return requestedVersion === aiAnalysisCacheVersion && savedVersion === legacyAiContextVersion;
}

function sameSignatureValue(left, right) {
  return (left ?? "") === (right ?? "");
}

function sameSignatureArray(left, right) {
  return JSON.stringify(normalizeSignatureArray(left)) === JSON.stringify(normalizeSignatureArray(right));
}

function normalizeSignatureArray(value) {
  return Array.isArray(value) ? [...value].map((item) => String(item)).sort() : [];
}

function resolveAiResultDocumentPath({ dataRoot, aiResultsRoot = null, nodeId, signature }) {
  const signatureHash = createHash("sha256").update(signature).digest("hex").slice(0, 10);
  return join(resolveAiResultRoot({ dataRoot, aiResultsRoot }), "documents", `${createNodeFileName(nodeId)}-${signatureHash}.html`);
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
  const nextActions = Array.isArray(output.nextActions) ? output.nextActions.filter(Boolean) : [];
  const body = output.markdown ? renderMarkdownToHtml(output.markdown) : "";
  const brief = output.brief || points.join("；") || output.summary || node.description;
  const sourceArtifact = artifact?.title
    ? `<p class="meta">参考产物：${renderArtifactHtml(artifact)}</p>`
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
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 14px 0 22px;
        font-size: 14px;
      }
      th,
      td {
        border: 1px solid rgba(23, 32, 38, 0.12);
        padding: 10px 12px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #eef3f1;
        color: rgba(23, 32, 38, 0.82);
      }
      .result-body {
        display: grid;
        gap: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <article>
        <p class="kicker">Polaris AI Result</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(output.summary || brief || node.description)}</p>
        ${sourceArtifact}
        ${actionPlanSection}
        ${body ? `<h2>实际结果</h2><section class="result-body">${body}</section>` : `<h2>实际结果</h2><p>${escapeHtml(brief)}</p>`}
        ${points.length > 0 ? `<h2>关键结论</h2><ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}
        ${nextActions.length > 0 ? `<h2>后续动作</h2><ul>${nextActions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>` : ""}
      </article>
    </main>
  </body>
</html>
`;
}

function renderArtifactHtml(artifact) {
  const label = `${artifact.docType ?? "Output"} · ${artifact.title}`;
  if (!artifact.url) return escapeHtml(label);
  return `<a href="${escapeHtml(artifact.url)}">${escapeHtml(label)}</a>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
