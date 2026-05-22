import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createRepository } from "../src/data/repository.js";

describe("local data repository", () => {
  it("seeds and persists task nodes in sqlite", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath });
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
      repository.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      assert.equal(reopenedRepository.listTaskNodes()[0].title, "已持久化的 Polaris 目标");
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("writes markdown-backed library items to local files", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const skill = repository.getLibrary().skills.find((entry) => entry.title === "抓主要矛盾");
      const item = repository.updateMarkdown(
        "skills",
        skill.id,
        ["---", "description: Custom Skill", "---", "", "## 具体内容", "", "新内容。", ""].join("\n"),
      );

      assert.equal(item.title, "抓主要矛盾");
      assert.equal(item.description, "Custom Skill");
      assert.match(readFileSync(join(dataRoot, "skills/抓主要矛盾.md"), "utf8"), /新内容/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("copies bundled markdown files into a configured data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const item = repository.getLibrary().knowledge.find((entry) => entry.brief === "现阶段用 workflow，不要用 agentic");

      assert.ok(existsSync(join(dataRoot, "knowledge/agent-application.md")));
      assert.equal(item.type, "agent-application");
      assert.equal(item.date, "2025-08-27");
      assert.match(item.markdown, /# TAG: agent-application/);
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
      const repository = createRepository({ dataRoot, dbPath });
      repository.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("DELETE FROM library_items WHERE kind = ? AND source = ?").run("knowledge", "md");
      db.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
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
