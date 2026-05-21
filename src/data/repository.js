import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export const defaultDataRoot = join(repoRoot, "data");
export const defaultDbPath = join(defaultDataRoot, "polaris.db");

export function createRepository(options = {}) {
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot);
  const seedDataRoot = resolve(options.seedDataRoot ?? defaultDataRoot);
  mkdirSync(dataRoot, { recursive: true });
  ensureDataFiles(dataRoot, seedDataRoot);
  const project = loadProject(dataRoot);
  const dbPath = resolve(options.dbPath ?? join(dataRoot, "polaris.db"));
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);

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
    },

    saveTaskNodes(nodes) {
      const normalizedNodes = normalizeTaskNodes(nodes);
      replaceTaskNodes(db, normalizedNodes);
      return this.listTaskNodes();
    },

    getLibrary() {
      const rows = db
        .prepare(
          `SELECT id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage
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
      refreshLocalMarkdownMetadata(db, project, row, markdownPath);
      return this.getLibrary()[kind].find((item) => item.id === id);
    },
  };

  seedIfEmpty(repository, db);
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
      position INTEGER NOT NULL
    );
  `);
}

function seedIfEmpty(repository, db) {
  const nodeCount = db.prepare("SELECT COUNT(*) AS count FROM task_nodes").get().count;
  if (nodeCount === 0) {
    repository.saveTaskNodes(sampleNodes);
  }

  const libraryCount = db.prepare("SELECT COUNT(*) AS count FROM library_items").get().count;
  if (libraryCount === 0) {
    replaceLibraryItems(db, libraryItems);
  } else {
    insertMissingLibraryItems(db, libraryItems);
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

    let nextPosition = db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM library_items WHERE kind = ?")
      .get(source.kind).position;

    for (const filePath of listMarkdownFiles(rootDir)) {
      const path = toLibraryPath(dataRoot, source, filePath);
      const metadata = readMarkdownMetadata(filePath, source, rootDir);
      const existing = db
        .prepare("SELECT id FROM library_items WHERE kind = ? AND source = 'md' AND path = ?")
        .get(source.kind, path);

      if (existing) {
        if (existing.id.startsWith(`local-${source.kind}-`)) {
          updateLocalMarkdownItem(db, existing.id, metadata);
        }
        continue;
      }

      insertLocalMarkdownItem(db, {
        id: createUniqueLibraryId(db, createLocalLibraryId(source.kind, path)),
        kind: source.kind,
        path,
        position: nextPosition,
        ...metadata,
      });
      nextPosition += 1;
    }
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

function readMarkdownMetadata(filePath, library, rootDir) {
  const markdown = readFileSync(filePath, "utf8");
  const { attributes, content } = splitFrontmatter(markdown);
  const relativeFolder = relative(rootDir, dirname(filePath));
  const title = attributes.title ?? findFirstHeading(content) ?? humanizeFileName(filePath);
  const description = attributes.description ?? findFirstParagraph(content) ?? "";

  return {
    relatedNodeIds: parseFrontmatterList(attributes.relatedNodeIds ?? attributes.relatedNodes ?? ""),
    type: attributes.type ?? (relativeFolder && relativeFolder !== "." ? relativeFolder.split(sep).at(-1) : library.defaultType),
    title: truncateText(title, 64),
    description: truncateText(description, 140),
    usage: attributes.usage ?? null,
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

function humanizeFileName(filePath) {
  return basename(filePath, extname(filePath)).replace(/[-_]+/g, " ");
}

function truncateText(text, maxLength) {
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

function createLocalLibraryId(kind, path) {
  const slug = path
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const hash = createHash("sha1").update(`${kind}:${path}`).digest("hex").slice(0, 8);
  return `local-${kind}-${slug || "markdown"}-${hash}`;
}

function createUniqueLibraryId(db, preferredId) {
  let id = preferredId;
  let index = 2;
  while (db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(id)) {
    id = `${preferredId}-${index}`;
    index += 1;
  }
  return id;
}

function insertLocalMarkdownItem(db, item) {
  db.prepare(
    `INSERT INTO library_items (
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage, position
    ) VALUES (?, ?, 'md', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.kind,
    item.path,
    JSON.stringify(item.relatedNodeIds),
    item.type,
    item.title,
    item.description,
    item.usage,
    item.position,
  );
}

function updateLocalMarkdownItem(db, id, metadata) {
  db.prepare(
    `UPDATE library_items
     SET related_node_ids = ?, type = ?, title = ?, description = ?, usage = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(metadata.relatedNodeIds),
    metadata.type,
    metadata.title,
    metadata.description,
    metadata.usage,
    id,
  );
}

function refreshLocalMarkdownMetadata(db, project, row, markdownPath) {
  if (!row.id.startsWith(`local-${row.kind}-`)) return;

  const source = findMarkdownSource(project, row.kind, row.path, markdownPath);
  if (!source) return;

  updateLocalMarkdownItem(db, row.id, readMarkdownMetadata(markdownPath, source, source.rootPath));
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
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      id, kind, source, path, doc_type, url, related_node_ids, type, title, description, usage, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
