import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { bundledSeedDataRoot, createRepository, defaultDataRoot } from "../src/data/repository.js";
import { createNode } from "../src/task-nodes.js";

describe("local data repository", () => {
  it("keeps bundled seed data separate from the runtime default data root", () => {
    assert.notEqual(defaultDataRoot, bundledSeedDataRoot);
  });

  it("starts with an empty task tree unless demo seed is enabled", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));

    try {
      const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

      assert.deepEqual(repository.listTaskNodes(), []);
      assert.deepEqual(repository.getLibrary().knowledge, []);
      assert.deepEqual(repository.getLibrary().skills, []);
      assert.deepEqual(repository.getLibrary().artifacts, []);
      assert.equal(existsSync(join(dataRoot, "task-nodes.json")), false);
      assert.equal(existsSync(join(dataRoot, "knowledge/agent-application.md")), false);
      assert.equal(existsSync(join(dataRoot, "skills/抓主要矛盾.md")), false);
      repository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("seeds demo task nodes only when requested and persists them", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const nodes = repository.listTaskNodes();
      assert.ok(nodes.some((node) => node.id === "polaris"));

      repository.saveTaskNodes(
        nodes.map((node) =>
          node.id === "polaris"
            ? {
                ...node,
                title: "已持久化的 Polaris 目标",
              }
            : node,
        ),
      );
      const snapshot = JSON.parse(readFileSync(join(dataRoot, "task-nodes.json"), "utf8"));
      assert.equal(snapshot.nodes[0].title, "已持久化的 Polaris 目标");
      repository.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      assert.equal(reopenedRepository.listTaskNodes()[0].title, "已持久化的 Polaris 目标");
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("refreshes node priorities on task-tree save and preserves them on restart", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const savedNodes = repository.saveTaskNodes(repository.listTaskNodes());
      const snapshotPath = join(dataRoot, "task-nodes.json");
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

      assert.equal(savedNodes.some((node) => node.priority === "P0"), true);
      assert.equal(snapshot.nodes.some((node) => node.priority === "P0"), true);

      snapshot.nodes = snapshot.nodes.map((node) => ({ ...node, priority: "P2" }));
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      repository.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      assert.equal(reopenedRepository.listTaskNodes().every((node) => node.priority === "P2"), true);
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("initializes missing portable priority data once", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const snapshotPath = join(dataRoot, "task-nodes.json");
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      snapshot.nodes = snapshot.nodes.map(({ priority, ...node }) => node);
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      repository.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      const reopenedNodes = reopenedRepository.listTaskNodes();
      const rewrittenSnapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

      assert.equal(reopenedNodes.some((node) => node.priority === "P0"), true);
      assert.equal(rewrittenSnapshot.nodes.every((node) => typeof node.priority === "string"), true);
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("persists manual task priority overrides across restarts", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const nodes = repository.listTaskNodes();
      repository.saveTaskNodes(
        nodes.map((node) =>
          node.id === "try-demo"
            ? {
                ...node,
                priority: "P0",
                priorityOverride: true,
              }
            : node,
        ),
      );
      repository.close();

      const snapshot = JSON.parse(readFileSync(join(dataRoot, "task-nodes.json"), "utf8"));
      const snapshotNode = snapshot.nodes.find((node) => node.id === "try-demo");
      const reopenedRepository = createRepository({ dataRoot, dbPath });
      const reopenedNode = reopenedRepository.listTaskNodes().find((node) => node.id === "try-demo");
      reopenedRepository.close();

      assert.equal(snapshotNode.priority, "P0");
      assert.equal(snapshotNode.priorityOverride, true);
      assert.equal(reopenedNode.priority, "P0");
      assert.equal(reopenedNode.priorityOverride, true);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("rejects dependency cycles as a bad task-node payload", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath });

      assert.throws(
        () =>
          repository.saveTaskNodes([
            createNode({ id: "root", title: "Root" }),
            createNode({ id: "a", parentId: "root", title: "A", dependencies: ["b"] }),
            createNode({ id: "b", parentId: "root", title: "B", dependencies: ["a"] }),
          ]),
        (error) => error.statusCode === 400 && /Cycle detected in dependencies/.test(error.message),
      );

      repository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("uses task-nodes.json as the portable task tree source on restart", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const snapshotPath = join(dataRoot, "task-nodes.json");
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      repository.close();

      snapshot.nodes[0] = {
        ...snapshot.nodes[0],
        title: "用户文件里改过的目标",
        state: "完成",
        result: {
          source: "manual",
          url: "https://example.feishu.cn/docx/saved-result",
        },
      };
      writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      const rootNode = reopenedRepository.listTaskNodes()[0];

      assert.equal(rootNode.title, "用户文件里改过的目标");
      assert.equal(rootNode.state, "完成");
      assert.equal(rootNode.result.url, "https://example.feishu.cn/docx/saved-result");
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("stores task nodes in the configured local task-node file", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const taskNodeRoot = mkdtempSync(join(tmpdir(), "polaris-task-nodes-"));
    const taskNodeFile = join(taskNodeRoot, "custom-task-cards.json");
    const dbPath = join(dataRoot, "polaris.db");
    writeFileSync(join(dataRoot, "polaris.project.json"), JSON.stringify({ name: "Custom Task Project" }, null, 2));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: taskNodeFile,
            database: "polaris.db",
            aiResults: "ai-results",
          },
        },
        null,
        2,
      ),
    );

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const nodes = repository.listTaskNodes();
      const project = repository.getProject();
      repository.saveTaskNodes(
        nodes.map((node) =>
          node.id === "polaris"
            ? {
                ...node,
                title: "外部目录里的任务节点",
              }
            : node,
        ),
      );
      repository.close();

      assert.equal(project.localConfig.fileName, "polaris.local.json");
      assert.equal(project.localConfig.paths.taskNodes, taskNodeFile);
      assert.equal(existsSync(join(dataRoot, "task-nodes.json")), false);
      assert.equal(existsSync(taskNodeFile), true);

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      assert.equal(reopenedRepository.listTaskNodes()[0].title, "外部目录里的任务节点");
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(taskNodeRoot, { recursive: true, force: true });
    }
  });

  it("copies legacy root task nodes into a newly configured task-node directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");
    const legacySnapshotPath = join(dataRoot, "task-nodes.json");
    const configuredSnapshotPath = join(dataRoot, "tasks/task-nodes.json");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      repository.close();

      const localConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));
      localConfig.paths.taskNodes = "tasks";
      writeFileSync(join(dataRoot, "polaris.local.json"), `${JSON.stringify(localConfig, null, 2)}\n`, "utf8");

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      const rewrittenLocalConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));
      reopenedRepository.close();

      assert.equal(existsSync(legacySnapshotPath), true);
      assert.equal(existsSync(configuredSnapshotPath), true);
      assert.equal(rewrittenLocalConfig.paths.taskNodes, "tasks/task-nodes.json");
      assert.deepEqual(
        JSON.parse(readFileSync(configuredSnapshotPath, "utf8")).nodes.map((node) => node.id),
        JSON.parse(readFileSync(legacySnapshotPath, "utf8")).nodes.map((node) => node.id),
      );
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("exports existing sqlite task nodes to task-nodes.json for legacy data directories", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");
    const snapshotPath = join(dataRoot, "task-nodes.json");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      repository.saveTaskNodes(
        repository.listTaskNodes().map((node) =>
          node.id === "polaris"
            ? {
                ...node,
                title: "旧 SQLite 里的目标",
              }
            : node,
        ),
      );
      repository.close();
      rmSync(snapshotPath, { force: true });

      const reopenedRepository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      reopenedRepository.close();

      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      assert.equal(snapshot.nodes[0].title, "旧 SQLite 里的目标");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("migrates legacy sqlite task-node tag columns out of the runtime schema", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE task_nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          title TEXT NOT NULL,
          tag TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          ai_actions TEXT NOT NULL,
          dependencies TEXT NOT NULL,
          state TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'P2',
          conclusion TEXT,
          result TEXT,
          created_from TEXT NOT NULL,
          position INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO task_nodes (
          id, parent_id, title, tag, description, ai_actions, dependencies, state, priority, conclusion, result, created_from, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "legacy-node",
        null,
        "旧节点",
        "思考",
        "旧库仍然带 tag。",
        JSON.stringify(["确认输入"]),
        JSON.stringify([]),
        "待做",
        "P2",
        null,
        null,
        "user",
        0,
      );
      db.close();

      const repository = createRepository({ dataRoot, dbPath });
      const [node] = repository.listTaskNodes();
      repository.close();

      const migratedDb = new DatabaseSync(dbPath);
      const columns = migratedDb.prepare("PRAGMA table_info(task_nodes)").all().map((column) => column.name);
      migratedDb.close();
      const snapshot = JSON.parse(readFileSync(join(dataRoot, "task-nodes.json"), "utf8"));

      assert.equal(node.title, "旧节点");
      assert.equal(Object.hasOwn(node, "tag"), false);
      assert.equal(columns.includes("tag"), false);
      assert.equal(columns.includes("priority_override"), true);
      assert.equal(Object.hasOwn(snapshot.nodes[0], "tag"), false);
      assert.equal(snapshot.nodes[0].priorityOverride, false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("writes markdown-backed library items to local files", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const skillDir = join(dataRoot, "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "自定义能力.md"),
      ["---", "description: Initial Skill", "---", "", "## 具体内容", "", "旧内容。", ""].join("\n"),
    );
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const skill = repository.getLibrary().skills.find((entry) => entry.title === "自定义能力");
      const item = repository.updateMarkdown(
        "skills",
        skill.id,
        ["---", "description: Custom Skill", "---", "", "## 具体内容", "", "新内容。", ""].join("\n"),
      );

      assert.equal(item.title, "自定义能力");
      assert.equal(item.description, "Custom Skill");
      assert.match(readFileSync(join(dataRoot, "skills/自定义能力.md"), "utf8"), /新内容/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("seeds bundled library files only when demo seed is requested", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db"), seedTaskNodes: true });

    try {
      const library = repository.getLibrary();
      const item = library.knowledge.find((entry) => entry.brief === "现阶段用 workflow，不要用 agentic");

      assert.ok(existsSync(join(dataRoot, "knowledge/agent-application.md")));
      assert.equal(item.type, "agent-application");
      assert.equal(item.date, "2025-08-27");
      assert.match(item.markdown, /# TAG: agent-application/);
      assert.ok(library.artifacts.some((entry) => entry.id === "scenario-filter"));
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing markdown sources when demo seed is disabled", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");
    const knowledgeDir = join(dataRoot, "knowledge");
    const skillDir = join(dataRoot, "skills");

    const seededRepository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
    seededRepository.close();
    writeFileSync(join(skillDir, "用户自己的能力.md"), "---\ndescription: Mine\n---\n\n自己的内容。\n");

    const repository = createRepository({ dataRoot, dbPath });

    try {
      const library = repository.getLibrary();

      assert.equal(existsSync(join(knowledgeDir, "agent-application.md")), true);
      assert.equal(existsSync(join(skillDir, "抓主要矛盾.md")), true);
      assert.equal(existsSync(join(skillDir, "用户自己的能力.md")), true);
      assert.equal(library.knowledge.some((entry) => entry.type === "agent-application"), true);
      assert.ok(library.skills.some((entry) => entry.title === "用户自己的能力"));
      assert.deepEqual(library.artifacts, []);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("creates and exposes project sources", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const project = repository.getBootstrap().project;

      assert.equal(project.name, "Polaris");
      assert.deepEqual(project.localConfig, {
        fileName: "polaris.local.json",
        paths: {
          taskNodes: "task-nodes.json",
          database: "polaris.db",
          aiResults: "ai-results",
        },
        ai: {
          timeoutMs: 120_000,
          splitTimeoutMs: 60_000,
        },
      });
      assert.ok(existsSync(join(dataRoot, "polaris.project.json")));
      assert.ok(existsSync(join(dataRoot, "polaris.local.json")));
      assert.deepEqual(
        project.sources.map((source) => [source.id, source.kind, source.path]),
        [
          ["default-knowledge", "knowledge", "knowledge"],
          ["default-skills", "skills", "skills"],
        ],
      );
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("persists user-owned AI timeout configuration in local config", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: "task-nodes.json",
            database: "polaris.db",
            aiResults: "ai-results",
          },
          ai: {
            timeoutMs: 180_000,
            splitTimeoutMs: 90_000,
          },
          sources: [],
        },
        null,
        2,
      ),
    );

    try {
      const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });
      const project = repository.getProject();
      repository.close();
      const localConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));

      assert.deepEqual(project.localConfig.ai, {
        timeoutMs: 180_000,
        splitTimeoutMs: 90_000,
      });
      assert.deepEqual(localConfig.ai, {
        timeoutMs: 180_000,
        splitTimeoutMs: 90_000,
      });
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("updates AI timeout configuration in the user-owned local config", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));

    try {
      const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });
      const project = repository.updateAiConfig({
        timeoutMs: 240_000,
        splitTimeoutMs: 45_000,
      });
      repository.close();
      const localConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));

      assert.deepEqual(project.localConfig.ai, {
        timeoutMs: 240_000,
        splitTimeoutMs: 45_000,
      });
      assert.deepEqual(localConfig.ai, {
        timeoutMs: 240_000,
        splitTimeoutMs: 45_000,
      });
      assert.equal(localConfig.paths.taskNodes, "task-nodes.json");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("adds missing AI timeout defaults to legacy local config without using project files", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: "task-nodes.json",
            database: "polaris.db",
            aiResults: "ai-results",
          },
          sources: [],
        },
        null,
        2,
      ),
    );

    try {
      const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });
      const project = repository.getProject();
      repository.close();
      const localConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));

      assert.deepEqual(project.localConfig.ai, {
        timeoutMs: 120_000,
        splitTimeoutMs: 60_000,
      });
      assert.deepEqual(localConfig.ai, {
        timeoutMs: 120_000,
        splitTimeoutMs: 60_000,
      });
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("drops unsupported local sources from generated config", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: "task-nodes.json",
            database: "polaris.db",
            aiResults: "ai-results",
          },
          sources: [
            {
              id: "default-knowledge",
              kind: "knowledge",
              label: "Knowledge",
              path: "knowledge",
              defaultType: "本地知识",
            },
            {
              id: "unsupported-source",
              kind: "unsupported",
              label: "Unsupported Source",
              path: "unsupported",
              defaultType: "Unsupported",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });
      const project = repository.getProject();
      repository.close();
      const localConfig = JSON.parse(readFileSync(join(dataRoot, "polaris.local.json"), "utf8"));

      assert.deepEqual(
        project.sources.map((source) => source.kind),
        ["knowledge"],
      );
      assert.equal(localConfig.sources.some((source) => source.id === "unsupported-source"), false);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("imports knowledge tag files from project sources outside the data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "polaris-source-"));
    writeFileSync(join(dataRoot, "polaris.project.json"), JSON.stringify({ name: "Client Project" }, null, 2));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: ".",
            database: "polaris.db",
            aiResults: "ai-results",
          },
          sources: [
            {
              id: "client-knowledge",
              kind: "knowledge",
              label: "Client Knowledge",
              path: sourceRoot,
              defaultType: "客户知识",
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(sourceRoot, "client-note.md"),
      [
        "# TAG: client-signal",
        "",
        "> 来自外部 source 的知识。",
        "",
        "---",
        "",
        "## 2026-05-22",
        "",
        "**Brief**：外部客户知识",
        "",
        "这条知识不在 Polaris data dir 内。",
      ].join("\n"),
    );

    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const bootstrap = repository.getBootstrap();
      const item = bootstrap.library.knowledge.find((entry) => entry.brief === "外部客户知识");

      assert.equal(bootstrap.project.name, "Client Project");
      assert.equal(bootstrap.project.sources[0].id, "client-knowledge");
      assert.equal(item.path, "/sources/client-knowledge/client-note.md");
      assert.equal(item.type, "client-signal");
      assert.equal(item.sourceDescription, "来自外部 source 的知识。");
      assert.match(item.markdown, /不在 Polaris data dir 内/);

      const updated = repository.updateMarkdown(
        "knowledge",
        item.id,
        [
          "# TAG: client-signal",
          "",
          "> 已通过编辑器写回外部 source。",
          "",
          "## 2026-05-22",
          "",
          "**Brief**：外部客户知识 v2",
          "",
          "这条知识已经写回部署者自己的目录。",
        ].join("\n"),
      );

      assert.equal(updated.brief, "外部客户知识 v2");
      assert.equal(updated.sourceDescription, "已通过编辑器写回外部 source。");
      assert.match(readFileSync(join(sourceRoot, "client-note.md"), "utf8"), /写回部署者自己的目录/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("imports local markdown knowledge from the configured data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const knowledgeDir = join(dataRoot, "knowledge");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, "market-signal.md"),
      [
        "relatedNodeIds: find-scenario, define-solution",
        "",
        "# TAG: market-signal",
        "",
        "> 来自本地知识库的判断摘要。",
        "",
        "## 2026-05-22",
        "",
        "**Brief**：自定义市场信号",
        "",
        "这是一条部署者自己的本地知识。",
      ].join("\n"),
    );

    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const item = repository.getLibrary().knowledge.find((entry) => entry.brief === "自定义市场信号");

      assert.equal(item.type, "market-signal");
      assert.equal(item.sourceDescription, "来自本地知识库的判断摘要。");
      assert.match(item.markdown, /部署者自己的本地知识/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("rebuilds markdown library items for existing sqlite data", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      repository.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("DELETE FROM library_items WHERE kind = ? AND source = ?").run("knowledge", "md");
      db.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath, seedTaskNodes: true });
      const agentKnowledge = reopenedRepository
        .getLibrary()
        .knowledge.filter((item) => item.type === "agent-application")
        .map((item) => item.title);
      const skills = reopenedRepository
        .getLibrary()
        .skills
        .map((item) => item.title);

      assert.ok(agentKnowledge.includes("预算归属从个人工具迁移到流程 owner"));
      assert.equal(agentKnowledge.length, 6);
      assert.ok(skills.includes("反证优先"));
      assert.equal(skills.length, 6);
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("creates the default Polaris sqlite database path", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));

    try {
      const repository = createRepository({ dataRoot });
      repository.close();

      assert.ok(existsSync(join(dataRoot, "polaris.db")));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("uses local config paths for sqlite and AI result storage", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    writeFileSync(
      join(dataRoot, "polaris.local.json"),
      JSON.stringify(
        {
          version: 1,
          paths: {
            taskNodes: "tasks/custom-task-cards.json",
            database: "storage/polaris.db",
            aiResults: "storage/ai-results",
          },
        },
        null,
        2,
      ),
    );

    try {
      const repository = createRepository({ dataRoot });
      const storage = repository.getStorage();
      repository.close();

      assert.ok(existsSync(join(dataRoot, "storage/polaris.db")));
      assert.equal(storage.taskNodesFilePath, join(dataRoot, "tasks/custom-task-cards.json"));
      assert.equal(storage.aiResultsRoot, join(dataRoot, "storage/ai-results"));
      assert.ok(existsSync(join(dataRoot, "storage/ai-results")));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
