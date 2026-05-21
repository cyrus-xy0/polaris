# Northstar

Northstar is a local demo for exploring an AI-native task-node workflow. It separates the task tree, reusable knowledge, skills, and output artifacts into a small data layer while keeping the browser UI lightweight.

## Run locally

Requires Node.js 22.5 or newer.

If you use `nvm`, this repo includes an `.nvmrc`:

```bash
nvm use
node --version
```

```bash
npm start
```

The demo starts on `http://127.0.0.1:4173/`. If the port is already in use, the server automatically tries the next available port.

## Connect a local data plane

Northstar is meant to run against a local data directory. That directory owns the SQLite runtime state, project source configuration, and editable markdown-backed knowledge and skills.

Start with an empty directory:

```bash
NORTHSTAR_DATA_DIR=/path/to/northstar-data npm start
```

You can also pass it as a CLI flag:

```bash
npm start -- --data-dir /path/to/northstar-data
```

On first run, Northstar creates this shape:

```text
northstar-data/
  northstar.project.json
  northstar.db
  knowledge/
    *.md
  skills/
    *.md
```

`northstar.project.json` owns the data sources:

```json
{
  "name": "Northstar",
  "sources": [
    {
      "id": "default-knowledge",
      "kind": "knowledge",
      "label": "Knowledge",
      "path": "knowledge",
      "defaultType": "本地知识"
    },
    {
      "id": "default-skills",
      "kind": "skills",
      "label": "Skill",
      "path": "skills",
      "defaultType": "本地能力"
    }
  ]
}
```

To connect your own folder, stop the server, add another source entry, and restart. `path` may be relative to the data directory or an absolute local path:

```json
{
  "id": "my-local-notes",
  "kind": "knowledge",
  "label": "My Local Notes",
  "path": "/Users/me/Notes/northstar",
  "defaultType": "个人知识"
}
```

Markdown files from configured `knowledge` and `skills` sources are imported on server start. Files may use optional front matter:

```markdown
---
type: 行业判断
title: 自定义市场信号
description: 来自本地知识库的判断摘要。
relatedNodeIds: find-scenario, define-solution
---

# 自定义市场信号

正文内容。
```

Front matter fields:

- `title`: display title. Falls back to the first `# Heading`, then the file name.
- `description`: card summary. Falls back to the first paragraph.
- `type`: grouping label. Falls back to the nearest folder name, then the source `defaultType`.
- `relatedNodeIds`: comma-separated task node ids that should use this item.
- `usage`: optional note about when to apply this knowledge or skill.

Verify the data plane after restart:

```bash
curl http://127.0.0.1:4173/api/project
curl http://127.0.0.1:4173/api/library
```

Use the actual port printed by `npm start` if it is not `4173`. A connected external markdown file appears in `/api/library` with a path like `/sources/my-local-notes/file-name.md`, and it is visible in the Knowledge or Skill view. Editing a markdown-backed source item in the browser writes back to the source `.md` file and refreshes its title, description, type, usage, and related node ids from front matter.

Data handoff checklist:

- `npm start` launches the browser UI with no extra packages to install.
- `NORTHSTAR_DATA_DIR` or `--data-dir` points the app at a deployer's own local state.
- `northstar.project.json` lists every local data source that should be imported.
- New or renamed markdown files require a server restart so the source scan can rebuild the library index.
- Existing markdown content can be edited from the browser and persists to disk.
- Task-node state persists in `<data-dir>/northstar.db`.
- Markdown-backed `knowledge` and `skills` are configurable through project sources; seeded output artifact links live in SQLite from `data/seed/library.js`.

## Test

```bash
npm test
```

## Data model

- Task-node seed data lives in `data/seed/task-nodes.js`.
- Knowledge, skill, and artifact seed data lives in `data/seed/library.js`.
- Bundled markdown knowledge and skills live in `data/knowledge/` and `data/skills/`.
- Project source configuration lives at `<data-dir>/northstar.project.json`.
- Runtime state is persisted to local SQLite at `<data-dir>/northstar.db`; this file is intentionally ignored by git when the default `data/` directory is used. Existing `<data-dir>/polaris.db` data is copied forward on first run.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
