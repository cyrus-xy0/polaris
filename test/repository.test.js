import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createRepository } from "../src/data/repository.js";

describe("local data repository", () => {
  it("seeds and persists task nodes in sqlite", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "northstar-data-"));
    const dbPath = join(dataRoot, "northstar.db");

    try {
      const repository = createRepository({ dataRoot, dbPath });
      const nodes = repository.listTaskNodes();
      assert.ok(nodes.some((node) => node.id === "northstar"));

      repository.saveTaskNodes(
        nodes.map((node) =>
          node.id === "northstar"
            ? {
                ...node,
                title: "已持久化的北极星目标",
              }
            : node,
        ),
      );
      repository.close();

      const reopenedRepository = createRepository({ dataRoot, dbPath });
      assert.equal(reopenedRepository.listTaskNodes()[0].title, "已持久化的北极星目标");
      reopenedRepository.close();
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("writes markdown-backed library items to local files", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "northstar-data-"));
    const repository = createRepository({ dataRoot, dbPath: join(dataRoot, "northstar.db") });

    try {
      const item = repository.updateMarkdown("skills", "find-main-contradiction", "# Custom Skill\n");

      assert.equal(item.markdown, "# Custom Skill\n");
      assert.equal(readFileSync(join(dataRoot, "skills/find-main-contradiction.md"), "utf8"), "# Custom Skill\n");
    } finally {
      repository.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it("fills in missing seed library items for existing sqlite data", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "northstar-data-"));
    const dbPath = join(dataRoot, "northstar.db");

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

  it("copies a legacy local sqlite database into the northstar path", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "northstar-data-"));

    try {
      writeFileSync(join(dataRoot, "polaris.db"), "");
      const repository = createRepository({ dataRoot });
      repository.close();

      assert.ok(existsSync(join(dataRoot, "northstar.db")));
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
