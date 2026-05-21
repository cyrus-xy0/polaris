import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { libraryItems } from "../../data/seed/library.js";
import { sampleNodes } from "../../data/seed/task-nodes.js";
import { createNode, indexNodes } from "../task-nodes.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const defaultDataRoot = join(repoRoot, "data");
export const defaultDbPath = join(defaultDataRoot, "northstar.db");

export function createRepository(options = {}) {
  const dataRoot = resolve(options.dataRoot ?? defaultDataRoot);
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = resolve(options.dbPath ?? join(dataRoot, "northstar.db"));
  mkdirSync(dirname(dbPath), { recursive: true });
  if (!options.dbPath) copyLegacyDatabase(dataRoot, dbPath);

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);

  const repository = {
    close() {
      db.close();
    },

    getBootstrap() {
      return {
        nodes: this.listTaskNodes(),
        library: this.getLibrary(),
      };
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
          item.markdown = readMarkdownFile(dataRoot, row.path);
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

      const markdownPath = resolveDataPath(dataRoot, row.path);
      mkdirSync(dirname(markdownPath), { recursive: true });
      writeFileSync(markdownPath, markdown, "utf8");
      return this.getLibrary()[kind].find((item) => item.id === id);
    },
  };

  seedIfEmpty(repository, db);
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

function copyLegacyDatabase(dataRoot, dbPath) {
  const legacyDbPath = resolve(dataRoot, "polaris.db");
  if (legacyDbPath !== dbPath && existsSync(legacyDbPath) && !existsSync(dbPath)) {
    copyFileSync(legacyDbPath, dbPath);
  }
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

function readMarkdownFile(dataRoot, markdownPath) {
  const absolutePath = resolveDataPath(dataRoot, markdownPath);
  if (!existsSync(absolutePath)) return "";
  return readFileSync(absolutePath, "utf8");
}

function resolveDataPath(dataRoot, requestPath) {
  const normalizedPath = normalize(requestPath).replace(/^[/\\]+/, "");
  const absolutePath = resolve(dataRoot, normalizedPath);
  const relativePath = relative(dataRoot, absolutePath);
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw createHttpError(400, `Invalid data path: ${requestPath}`);
  }
  return absolutePath;
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
