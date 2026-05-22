import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { libraryItems } from "../../data/seed/library.js";
import { sampleNodes } from "../../data/seed/task-nodes.js";
import { createNode, indexNodes } from "../task-nodes.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultSources = [
  { id: "default-knowledge", kind: "knowledge", label: "Knowledge", path: "knowledge", defaultType: "本地知识" },
  { id: "default-skills", kind: "skills", label: "Skill", path: "skills", defaultType: "本地能力" },
];
const projectFileName = "polaris.project.json";
const taskNodesFileName = "task-nodes.json";
const markdownMetadataColumns = {
  brief: "TEXT",
  date: "TEXT",
  source_description: "TEXT",
};

export const defaultDataRoot = join(repoRoot, "data");
export const defaultDbPath = join(defaultDataRoot, "polaris.db");

export function createRepository(options = {}) {
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot);
  const seedDataRoot = resolve(options.seedDataRoot ?? defaultDataRoot);
  const seedTaskNodes = options.seedTaskNodes === true;
  mkdirSync(dataRoot, { recursive: true });
  ensureDataFiles(dataRoot, seedDataRoot);
  const project = loadProject(dataRoot);
  const dbPath = resolve(options.dbPath ?? join(dataRoot, "polaris.db"));
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  syncTaskNodesWithPortableFile(db, dataRoot);

  const repository = {
    close() {
      db.close();
    },

    getBootstrap() {
      return {
        project: this.getProject(),
        nodes: this.listTaskNodes(),
        library: this.getLibrary(),
      };
    },

    getProject() {
      return serializeProject(project);
    },

    listTaskNodes() {
      return readTaskNodesFromDb(db);
    },

    saveTaskNodes(nodes) {
      const normalizedNodes = normalizeTaskNodes(nodes);
      writeTaskNodesFile(dataRoot, normalizedNodes);
      replaceTaskNodes(db, normalizedNodes);
      return this.listTaskNodes();
    },

    getLibrary() {
      const rows = db
        .prepare(
          `SELECT id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage, brief, date, source_description
           FROM library_items
           ORDER BY position ASC, rowid ASC`,
        )
        .all();
      const library = { knowledge: [], skills: [], artifacts: [] };

      for (const row of rows) {
        const item = {
          id: row.id,
          kind: row.kind,
          source: row.source,
          path: row.path,
          relatedNodeIds: parseJson(row.related_node_ids, []),
          type: row.type,
          title: row.title,
          description: row.description,
          usage: row.usage,
        };

        if (row.brief) item.brief = row.brief;
        if (row.date) item.date = row.date;
        if (row.source_description) item.sourceDescription = row.source_description;
        if (row.doc_type) item.docType = row.doc_type;
        if (row.url) item.url = row.url;
        if (row.source === "md" && row.path) {
          item.markdown = readMarkdownFile(dataRoot, project, row.path);
        }

        library[row.kind].push(item);
      }

      return library;
    },

    updateMarkdown(kind, id, markdown) {
      if (!["knowledge", "skills"].includes(kind)) {
        throw createHttpError(400, `Unsupported markdown kind: ${kind}`);
      }
      if (typeof markdown !== "string") {
        throw createHttpError(400, "markdown must be a string");
      }

      const row = db
        .prepare("SELECT id, kind, source, path FROM library_items WHERE kind = ? AND id = ?")
        .get(kind, id);
      if (!row) throw createHttpError(404, `Library item not found: ${kind}/${id}`);
      if (row.source !== "md" || !row.path) {
        throw createHttpError(400, `Library item is not markdown-backed: ${kind}/${id}`);
      }

      const markdownPath = resolveLibraryItemPath(dataRoot, project, row.path);
      mkdirSync(dirname(markdownPath), { recursive: true });
      writeFileSync(markdownPath, markdown, "utf8");
      syncSingleMarkdownFile(db, dataRoot, project, row.kind, row.path, markdownPath);
      const refreshedItems = this.getLibrary()[kind];
      return refreshedItems.find((item) => item.id === id) ?? refreshedItems.find((item) => item.path === row.path);
    },
  };

  seedIfEmpty(repository, db, { seedTaskNodes });
  syncProjectSources(db, dataRoot, project);
  return repository;
}

export function normalizeTaskNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw createHttpError(400, "nodes must be a non-empty array");
  }

  const normalizedNodes = nodes.map((node) => createNode(node));
  indexNodes(normalizedNodes);
  if (!normalizedNodes.some((node) => !node.parentId)) {
    throw createHttpError(400, "task tree must include at least one root node");
  }
  return normalizedNodes;
}

function syncTaskNodesWithPortableFile(db, dataRoot) {
  const filePath = join(dataRoot, taskNodesFileName);
  if (existsSync(filePath)) {
    replaceTaskNodes(db, readTaskNodesFile(filePath));
    return;
  }

  const nodes = readTaskNodesFromDb(db);
  if (nodes.length > 0) {
    writeTaskNodesFile(dataRoot, nodes);
  }
}

function readTaskNodesFile(filePath) {
  const payload = parseJson(readFileSync(filePath, "utf8"), null);
  const nodes = Array.isArray(payload) ? payload : payload?.nodes;

  try {
    return normalizeTaskNodes(nodes);
  } catch (error) {
    throw new Error(`Invalid ${taskNodesFileName}: ${error.message}`);
  }
}

function writeTaskNodesFile(dataRoot, nodes) {
  const filePath = join(dataRoot, taskNodesFileName);
  const record = {
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: serializeTaskNodes(nodes),
  };
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function readTaskNodesFromDb(db) {
  const rows = db
    .prepare(
      `SELECT id, parent_id, title, tag, description, ai_actions, dependencies, state, conclusion, result, created_from
       FROM task_nodes
       ORDER BY position ASC, rowid ASC`,
    )
    .all();

  return rows.map((row) =>
    createNode({
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      tag: row.tag,
      description: row.description,
      aiActions: parseJson(row.ai_actions, []),
      dependencies: parseJson(row.dependencies, []),
      state: row.state,
      conclusion: parseJson(row.conclusion, null),
      result: parseJson(row.result, null),
      createdFrom: row.created_from,
    }),
  );
}

function serializeTaskNodes(nodes) {
  return nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId ?? null,
    title: node.title,
    tag: node.tag,
    description: node.description,
    aiActions: node.aiActions,
    dependencies: node.dependencies,
    state: node.state,
    conclusion: node.conclusion ?? null,
    result: node.result ?? null,
    createdFrom: node.createdFrom,
  }));
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      ai_actions TEXT NOT NULL,
      dependencies TEXT NOT NULL,
      state TEXT NOT NULL,
      conclusion TEXT,
      result TEXT,
      created_from TEXT NOT NULL,
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'skills', 'artifacts')),
      source TEXT NOT NULL,
      path TEXT,
      doc_type TEXT,
      url TEXT,
      related_node_ids TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      usage TEXT,
      brief TEXT,
      date TEXT,
      source_description TEXT,
      position INTEGER NOT NULL
    );
  `);
  ensureLibraryItemColumns(db);
}

function ensureLibraryItemColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(library_items)").all().map((column) => column.name));
  for (const [columnName, columnType] of Object.entries(markdownMetadataColumns)) {
    if (!columns.has(columnName)) {
      db.exec(`ALTER TABLE library_items ADD COLUMN ${columnName} ${columnType}`);
    }
  }
}

function seedIfEmpty(repository, db, { seedTaskNodes = false } = {}) {
  const nodeCount = db.prepare("SELECT COUNT(*) AS count FROM task_nodes").get().count;
  if (seedTaskNodes && nodeCount === 0) {
    repository.saveTaskNodes(sampleNodes);
  }

  const libraryCount = db.prepare("SELECT COUNT(*) AS count FROM library_items").get().count;
  const systemLibraryItems = { artifacts: libraryItems.artifacts ?? [] };
  if (libraryCount === 0) {
    replaceLibraryItems(db, systemLibraryItems);
  } else {
    insertMissingLibraryItems(db, systemLibraryItems);
  }
}

function ensureDataFiles(dataRoot, seedDataRoot) {
  for (const { path } of defaultSources) {
    copyMissingMarkdownFiles(join(seedDataRoot, path), join(dataRoot, path));
  }
}

function loadProject(dataRoot) {
  const projectPath = join(dataRoot, projectFileName);
  let rawProject = {};
  if (existsSync(projectPath)) {
    rawProject = parseJson(readFileSync(projectPath, "utf8"), {});
  } else {
    rawProject = createDefaultProject();
    writeFileSync(projectPath, `${JSON.stringify(rawProject, null, 2)}\n`, "utf8");
  }

  return {
    name: normalizeProjectName(rawProject.name),
    sources: normalizeProjectSources(rawProject.sources, dataRoot),
  };
}

function createDefaultProject() {
  return {
    name: "Polaris",
    sources: defaultSources,
  };
}

function normalizeProjectName(name) {
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return "Polaris";
}

function normalizeProjectSources(sources, dataRoot) {
  const normalizedSources = [];
  const sourceInputs = Array.isArray(sources) && sources.length > 0 ? sources : defaultSources;

  for (const [position, source] of sourceInputs.entries()) {
    if (!["knowledge", "skills"].includes(source.kind)) continue;
    const sourcePath = typeof source.path === "string" && source.path.trim() ? source.path.trim() : source.kind;
    const rootPath = resolve(dataRoot, sourcePath);
    normalizedSources.push({
      id: source.id || createSourceId(source.kind, sourcePath),
      kind: source.kind,
      label: source.label || source.kind,
      path: sourcePath,
      rootPath,
      defaultType: source.defaultType || (source.kind === "knowledge" ? "本地知识" : "本地能力"),
      position,
    });
  }

  return normalizedSources;
}

function createSourceId(kind, sourcePath) {
  const slug = sourcePath
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const hash = createHash("sha1").update(`${kind}:${sourcePath}`).digest("hex").slice(0, 8);
  return `${kind}-${slug || "source"}-${hash}`;
}

function serializeProject(project) {
  return {
    name: project.name,
    sources: project.sources.map(({ id, kind, label, path, defaultType }) => ({
      id,
      kind,
      label,
      path,
      defaultType,
    })),
  };
}

function copyMissingMarkdownFiles(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) return;

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyMissingMarkdownFiles(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || extname(entry.name) !== ".md" || existsSync(targetPath)) continue;

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function syncProjectSources(db, dataRoot, project) {
  for (const source of project.sources) {
    const rootDir = source.rootPath;
    if (!existsSync(rootDir)) continue;

    const seenPaths = new Set();
    let nextPosition = source.position * 100000;

    for (const filePath of listMarkdownFiles(rootDir)) {
      const path = toLibraryPath(dataRoot, source, filePath);
      seenPaths.add(path);
      nextPosition += syncMarkdownFile(db, source, path, filePath, nextPosition);
    }

    cleanupMissingMarkdownItems(db, dataRoot, project, source, seenPaths);
  }
}

function syncSingleMarkdownFile(db, dataRoot, project, kind, libraryPath, markdownPath) {
  const source = findMarkdownSource(project, kind, libraryPath, markdownPath);
  if (!source) return 0;

  const existingPosition = db
    .prepare("SELECT MIN(position) AS position FROM library_items WHERE kind = ? AND source = 'md' AND path = ?")
    .get(kind, libraryPath).position;
  const nextPosition =
    existingPosition ??
    db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM library_items WHERE kind = ?").get(kind)
      .position;

  return syncMarkdownFile(db, source, libraryPath, markdownPath, nextPosition);
}

function syncMarkdownFile(db, source, libraryPath, filePath, startPosition) {
  const items = readMarkdownItems(filePath, source, source.rootPath).map((metadata, index) => ({
    id: createLocalLibraryId(source.kind, libraryPath, metadata.entryIndex ?? index),
    kind: source.kind,
    path: libraryPath,
    position: startPosition + index,
    ...metadata,
  }));

  replaceMarkdownItemsForPath(db, source.kind, libraryPath, items);
  return items.length;
}

function cleanupMissingMarkdownItems(db, dataRoot, project, source, seenPaths) {
  const rows = db.prepare("SELECT id, path FROM library_items WHERE kind = ? AND source = 'md'").all(source.kind);
  const deleteItem = db.prepare("DELETE FROM library_items WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      if (seenPaths.has(row.path)) continue;
      if (doesLibraryPathBelongToSource(dataRoot, project, source, row.path)) {
        deleteItem.run(row.id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function doesLibraryPathBelongToSource(dataRoot, project, source, libraryPath) {
  try {
    const absolutePath = resolveLibraryItemPath(dataRoot, project, libraryPath);
    return isPathInside(source.rootPath, absolutePath);
  } catch {
    return false;
  }
}

function listMarkdownFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const filePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(filePath));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(filePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function toLibraryPath(dataRoot, source, filePath) {
  if (isPathInside(dataRoot, filePath)) {
    return `/${relative(dataRoot, filePath).split(sep).join("/")}`;
  }
  return `/sources/${source.id}/${relative(source.rootPath, filePath).split(sep).join("/")}`;
}

function readMarkdownItems(filePath, source, rootDir) {
  const markdown = readFileSync(filePath, "utf8");
  const { attributes, content } = splitFrontmatter(markdown);

  if (source.kind === "knowledge") {
    return readKnowledgeMarkdownItems(filePath, source, rootDir, attributes, content);
  }

  if (source.kind === "skills") {
    return [readSkillMarkdownItem(filePath, source, rootDir, attributes, content)];
  }

  return [readLegacyMarkdownItem(filePath, source, rootDir, attributes, content)];
}

function readKnowledgeMarkdownItems(filePath, source, rootDir, attributes, content) {
  const tag = findKnowledgeTag(content) ?? attributes.tag ?? attributes.type;
  const entries = tag ? parseKnowledgeEntries(content) : [];

  if (tag && entries.length > 0) {
    const sourceDescription = findKnowledgeTypeDescription(content);
    return entries.map((entry, entryIndex) => {
      const description = stripMarkdownForDescription(entry.description);
      const brief = entry.brief || findFirstSentence(description) || humanizeFileName(filePath);
      return {
        entryIndex,
        relatedNodeIds: parseFrontmatterList(attributes.relatedNodeIds ?? attributes.relatedNodes ?? ""),
        type: truncateText(tag, 64),
        title: truncateText(brief, 96),
        brief: truncateText(brief, 140),
        description: truncateText(description, 320),
        usage: entry.date || null,
        date: entry.date || null,
        sourceDescription: sourceDescription ? truncateText(sourceDescription, 240) : null,
      };
    });
  }

  return [readLegacyMarkdownItem(filePath, source, rootDir, attributes, content)];
}

function readSkillMarkdownItem(filePath, source, rootDir, attributes, content) {
  const relativeFolder = relative(rootDir, dirname(filePath));
  const title = humanizeFileName(filePath);
  const description =
    attributes.description ??
    attributes.describition ??
    findMarkdownSection(content, ["description", "describition", "描述"]) ??
    findFirstParagraph(content) ??
    "";

  return {
    entryIndex: 0,
    relatedNodeIds: parseFrontmatterList(attributes.relatedNodeIds ?? attributes.relatedNodes ?? ""),
    type: attributes.type ?? (relativeFolder && relativeFolder !== "." ? relativeFolder.split(sep).at(-1) : source.defaultType),
    title: truncateText(title, 64),
    brief: truncateText(stripMarkdownForDescription(description), 140),
    description: truncateText(stripMarkdownForDescription(description), 220),
    usage: attributes.usage ?? null,
    date: null,
    sourceDescription: null,
  };
}

function readLegacyMarkdownItem(filePath, source, rootDir, attributes, content) {
  const relativeFolder = relative(rootDir, dirname(filePath));
  const title = attributes.title ?? findFirstHeading(content) ?? humanizeFileName(filePath);
  const description = attributes.description ?? findFirstParagraph(content) ?? "";

  return {
    entryIndex: 0,
    relatedNodeIds: parseFrontmatterList(attributes.relatedNodeIds ?? attributes.relatedNodes ?? ""),
    type: attributes.type ?? (relativeFolder && relativeFolder !== "." ? relativeFolder.split(sep).at(-1) : source.defaultType),
    title: truncateText(title, 64),
    brief: truncateText(title, 96),
    description: truncateText(stripMarkdownForDescription(description), 220),
    usage: attributes.usage ?? null,
    date: null,
    sourceDescription: null,
  };
}

function splitFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return { attributes: {}, content: markdown };
  }

  const endIndex = markdown.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { attributes: {}, content: markdown };
  }

  const rawAttributes = markdown.slice(4, endIndex);
  const content = markdown.slice(endIndex + 4).replace(/^\s+/, "");
  const attributes = {};

  for (const line of rawAttributes.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    attributes[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }

  return { attributes, content };
}

function findKnowledgeTag(markdown) {
  const match = markdown.match(/^#\s*TAG:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}

function findKnowledgeTypeDescription(markdown) {
  const tagMatch = /^#\s*TAG:\s*.+$/im.exec(markdown);
  if (!tagMatch) return null;

  const afterTag = markdown.slice(tagMatch.index + tagMatch[0].length);
  const lines = [];
  for (const line of afterTag.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (lines.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("---") || trimmed.startsWith("## ")) break;
    if (trimmed.startsWith(">")) {
      lines.push(trimmed.replace(/^>\s?/, ""));
    } else if (lines.length > 0) {
      break;
    }
  }

  return lines.join(" ").replace(/\s+/g, " ").trim() || null;
}

function parseKnowledgeEntries(markdown) {
  const headings = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  return headings
    .map((match, index) => {
      const start = match.index + match[0].length;
      const end = headings[index + 1]?.index ?? markdown.length;
      const body = markdown.slice(start, end).trim();
      const briefMatch = body.match(/^\*\*Brief\*\*\s*[：:]\s*(.+)$/im);
      const description = body
        .replace(/^\*\*Brief\*\*\s*[：:]\s*.+$/im, "")
        .replace(/^---+$/gm, "")
        .trim();

      return {
        date: match[1].trim(),
        brief: briefMatch?.[1]?.trim() ?? "",
        description,
      };
    })
    .filter((entry) => entry.brief || entry.description);
}

function findFirstHeading(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function findFirstParagraph(markdown) {
  const paragraph = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !block.startsWith("```"));
  return paragraph ? paragraph.replace(/\s+/g, " ") : null;
}

function findMarkdownSection(markdown, names) {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const sectionHeading = headings.find((match) => normalizedNames.has(match[2].trim().toLowerCase()));
  if (!sectionHeading) return null;

  const level = sectionHeading[1].length;
  const start = sectionHeading.index + sectionHeading[0].length;
  const nextHeading = headings.find((match) => match.index > sectionHeading.index && match[1].length <= level);
  return markdown.slice(start, nextHeading?.index ?? markdown.length).trim() || null;
}

function stripMarkdownForDescription(markdown) {
  return String(markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstSentence(text) {
  const match = String(text ?? "").match(/^(.{1,80}?[。.!？?]|.{1,80})(\s|$)/);
  return match?.[1]?.trim() ?? "";
}

function humanizeFileName(filePath) {
  return basename(filePath, extname(filePath)).replace(/[-_]+/g, " ");
}

function truncateText(text, maxLength) {
  text = String(text ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function parseFrontmatterList(value) {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function createLocalLibraryId(kind, path, entryIndex = 0) {
  const slug = path
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const hash = createHash("sha1").update(`${kind}:${path}:${entryIndex}`).digest("hex").slice(0, 8);
  return `local-${kind}-${slug || "markdown"}-${entryIndex + 1}-${hash}`;
}

function replaceMarkdownItemsForPath(db, kind, path, items) {
  const desiredIds = new Set(items.map((item) => item.id));
  const existing = db
    .prepare("SELECT id FROM library_items WHERE kind = ? AND source = 'md' AND path = ?")
    .all(kind, path);
  const deleteItem = db.prepare("DELETE FROM library_items WHERE id = ?");

  db.exec("BEGIN");
  try {
    for (const row of existing) {
      if (!desiredIds.has(row.id)) deleteItem.run(row.id);
    }

    for (const item of items) {
      upsertMarkdownItem(db, item);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function upsertMarkdownItem(db, item) {
  db.prepare(
    `INSERT INTO library_items (
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage,
      brief, date, source_description, position
    ) VALUES (?, ?, 'md', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      source = excluded.source,
      path = excluded.path,
      doc_type = excluded.doc_type,
      url = excluded.url,
      related_node_ids = excluded.related_node_ids,
      type = excluded.type,
      title = excluded.title,
      description = excluded.description,
      usage = excluded.usage,
      brief = excluded.brief,
      date = excluded.date,
      source_description = excluded.source_description,
      position = excluded.position`,
  ).run(
    item.id,
    item.kind,
    item.path,
    JSON.stringify(item.relatedNodeIds ?? []),
    item.type,
    item.title,
    item.description,
    item.usage ?? null,
    item.brief ?? null,
    item.date ?? null,
    item.sourceDescription ?? null,
    item.position,
  );
}

function findMarkdownSource(project, kind, libraryPath, markdownPath) {
  const sourceMatch = libraryPath.match(/^\/sources\/([^/]+)\//);
  if (sourceMatch) {
    return project.sources.find((source) => source.kind === kind && source.id === sourceMatch[1]) ?? null;
  }

  return project.sources.find((source) => source.kind === kind && isPathInside(source.rootPath, markdownPath)) ?? null;
}

function replaceTaskNodes(db, nodes) {
  const insert = db.prepare(`
    INSERT INTO task_nodes (
      id, parent_id, title, tag, description, ai_actions, dependencies, state, conclusion, result, created_from, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM task_nodes").run();
    nodes.forEach((node, position) => {
      insert.run(
        node.id,
        node.parentId,
        node.title,
        node.tag,
        node.description,
        JSON.stringify(node.aiActions),
        JSON.stringify(node.dependencies),
        node.state,
        JSON.stringify(node.conclusion),
        JSON.stringify(node.result),
        node.createdFrom,
        position,
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceLibraryItems(db, itemsByKind) {
  const insert = db.prepare(`
    INSERT INTO library_items (
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage,
      brief, date, source_description, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM library_items").run();
    for (const [kind, items] of Object.entries(itemsByKind)) {
      items.forEach((item, position) => {
        insert.run(
          item.id,
          kind,
          item.source,
          item.path ?? null,
          item.docType ?? null,
          item.url ?? null,
          JSON.stringify(item.relatedNodeIds ?? []),
          item.type,
          item.title,
          item.description,
          item.usage ?? null,
          item.brief ?? null,
          item.date ?? null,
          item.sourceDescription ?? null,
          position,
        );
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function insertMissingLibraryItems(db, itemsByKind) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO library_items (
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage,
      brief, date, source_description, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (const [kind, items] of Object.entries(itemsByKind)) {
      items.forEach((item, position) => {
        insert.run(
          item.id,
          kind,
          item.source,
          item.path ?? null,
          item.docType ?? null,
          item.url ?? null,
          JSON.stringify(item.relatedNodeIds ?? []),
          item.type,
          item.title,
          item.description,
          item.usage ?? null,
          item.brief ?? null,
          item.date ?? null,
          item.sourceDescription ?? null,
          position,
        );
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function readMarkdownFile(dataRoot, project, markdownPath) {
  let absolutePath;
  try {
    absolutePath = resolveLibraryItemPath(dataRoot, project, markdownPath);
  } catch {
    return "";
  }
  if (!existsSync(absolutePath)) return "";
  return readFileSync(absolutePath, "utf8");
}

function resolveLibraryItemPath(dataRoot, project, requestPath) {
  const sourceMatch = requestPath.match(/^\/sources\/([^/]+)\/(.+)$/);
  if (sourceMatch) {
    const source = project.sources.find((item) => item.id === sourceMatch[1]);
    if (!source) {
      throw createHttpError(400, `Unknown project source: ${sourceMatch[1]}`);
    }
    return resolveBoundedPath(source.rootPath, sourceMatch[2], requestPath);
  }

  return resolveDataPath(dataRoot, requestPath);
}

function resolveDataPath(dataRoot, requestPath) {
  return resolveBoundedPath(dataRoot, requestPath, requestPath);
}

function resolveBoundedPath(rootPath, requestPath, displayPath) {
  const normalizedPath = normalize(requestPath).replace(/^[/\\]+/, "");
  const absolutePath = resolve(rootPath, normalizedPath);
  if (!isPathInside(rootPath, absolutePath)) {
    throw createHttpError(400, `Invalid data path: ${displayPath}`);
  }
  return absolutePath;
}

function isPathInside(rootPath, filePath) {
  const relativePath = relative(rootPath, filePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    return false;
  }
  return true;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
