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
      const item = repository.updateMarkdown("skills", "find-main-contradiction", "# Custom Skill\n");

      assert.equal(item.markdown, "# Custom Skill\n");
      assert.equal(readFileSync(join(dataRoot, "skills/find-main-contradiction.md"), "utf8"), "# Custom Skill\n");
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("copies bundled markdown files into a configured data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const item = repository.getLibrary().knowledge.find((entry) => entry.id === "tob-agent-trends");

      assert.ok(existsSync(join(dataRoot, "knowledge/tob-agent-trends.md")));
      assert.match(item.markdown, /ToB Agent 落地趋势/);
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

  it("imports markdown from project sources outside the data directory", () => {
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
        "---",
        "title: 外部客户知识",
        "description: 来自外部 source 的知识。",
        "---",
        "# 外部客户知识",
        "",
        "这条知识不在 Polaris data dir 内。",
      ].join("\n"),
    );

    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const bootstrap = repository.getBootstrap();
      const item = bootstrap.library.knowledge.find((entry) => entry.title === "外部客户知识");

      assert.equal(bootstrap.project.name, "Client Project");
      assert.equal(bootstrap.project.sources[0].id, "client-knowledge");
      assert.equal(item.path, "/sources/client-knowledge/client-note.md");
      assert.equal(item.type, "客户知识");
      assert.match(item.markdown, /不在 Polaris data dir 内/);

      const updated = repository.updateMarkdown(
        "knowledge",
        item.id,
        [
          "---",
          "title: 外部客户知识 v2",
          "description: 已通过编辑器写回外部 source。",
          "relatedNodeIds: scope-mvp",
          "---",
          "# 外部客户知识 v2",
          "",
          "这条知识已经写回部署者自己的目录。",
        ].join("\n"),
      );

      assert.equal(updated.title, "外部客户知识 v2");
      assert.equal(updated.description, "已通过编辑器写回外部 source。");
      assert.deepEqual(updated.relatedNodeIds, ["scope-mvp"]);
      assert.match(readFileSync(join(sourceRoot, "client-note.md"), "utf8"), /写回部署者自己的目录/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("imports local markdown knowledge from the configured data directory", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const knowledgeDir = join(dataRoot, "knowledge/行业判断");
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(
      join(knowledgeDir, "custom-market-signal.md"),
      [
        "---",
        "title: 自定义市场信号",
        "description: 来自本地知识库的判断摘要。",
        "relatedNodeIds: find-scenario, define-solution",
        "---",
        "# 自定义市场信号",
        "",
        "这是一条部署者自己的本地知识。",
      ].join("\n"),
    );

    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "polaris.db") });

    try {
      const item = repository.getLibrary().knowledge.find((entry) => entry.title === "自定义市场信号");

      assert.equal(item.type, "行业判断");
      assert.equal(item.description, "来自本地知识库的判断摘要。");
      assert.deepEqual(item.relatedNodeIds, ["find-scenario", "define-solution"]);
      assert.match(item.markdown, /部署者自己的本地知识/);
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("fills in missing seed library items for existing sqlite data", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "polaris-data-"));
    const dbPath = join(dataRoot, "polaris.db");

    try {
      const repository = createRepository({ dataRoot, dbPath });
      repository.close();

      const db = new DatabaseSync(dbPath);
      db.prepare("DELETE FROM library_items WHERE id = ?").run("tob-agent-budget-owner");
      db.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      const industryJudgements = reopenedRepository
        .getLibrary()
        .knowledge.filter((item) => item.type === "行业判断")
        .map((item) => item.title);
      const thinkingSkills = reopenedRepository
        .getLibrary()
        .skills.filter((item) => item.type === "思考方式")
        .map((item) => item.title);

      assert.ok(industryJudgements.includes("预算归属正在迁移"));
      assert.equal(industryJudgements.length, 3);
      assert.ok(thinkingSkills.includes("反证优先"));
      assert.equal(thinkingSkills.length, 3);
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
