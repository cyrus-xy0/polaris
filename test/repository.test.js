import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createRepository } from "../src/data/repository.js";

describe("local data repository", () => {
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

  it("removes unmodified bundled library data that older versions copied into user data", () => {
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

      assert.equal(existsSync(join(knowledgeDir, "agent-application.md")), false);
      assert.equal(existsSync(join(skillDir, "抓主要矛盾.md")), false);
      assert.equal(existsSync(join(skillDir, "用户自己的能力.md")), true);
      assert.equal(library.knowledge.some((entry) => entry.type === "agent-application"), false);
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
      assert.ok(existsSync(join(dataRoot, "polaris.project.json")));
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

  it("imports knowledge tag files from project sources outside the data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "polaris-source-"));
    writeFileSync(
      join(dataRoot, "polaris.project.json"),
      JSON.stringify(
        {
          name: "Client Project",
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
});
