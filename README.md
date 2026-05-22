# Polaris

Polaris is a local demo for exploring an AI-native task-node workflow. It separates the task tree, reusable knowledge, skills, and output artifacts into a small data layer while keeping the browser UI lightweight.

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

Polaris is meant to run against a local data directory. That directory owns the SQLite runtime state, project source configuration, and editable markdown-backed knowledge and skills.

Start with an empty directory:

```bash
POLARIS_DATA_DIR=/path/to/polaris-data npm start
```

You can also pass it as a CLI flag:

```bash
npm start -- --data-dir /path/to/polaris-data
```

On first run, Polaris creates this shape:

```text
polaris-data/
  polaris.project.json
  polaris.db
  knowledge/
    *.md
  skills/
    *.md
```

`polaris.project.json` owns the data sources:

```json
{
  "name": "Polaris",
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
  "path": "/Users/me/Notes/polaris",
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
- `POLARIS_DATA_DIR` or `--data-dir` points the app at a deployer's own local state.
- `polaris.project.json` lists every local data source that should be imported.
- New or renamed markdown files require a server restart so the source scan can rebuild the library index.
- Existing markdown content can be edited from the browser and persists to disk.
- Task-node state persists in `<data-dir>/polaris.db`.
- Markdown-backed `knowledge` and `skills` are configurable through project sources; seeded output artifact links live in SQLite from `data/seed/library.js`.

## Local action-plan generation

The Suggest Action Plan panel is generated through a service-local AI executable when one is available. Polaris looks for `openclaw` first, then `hermes`, in these local locations:

- the service root
- `<service-root>/bin`
- `<service-root>/node_modules/.bin`
- the configured data directory
- `<data-dir>/bin`

OpenClaw is invoked through the non-interactive agent command:

```bash
openclaw agent --agent "${POLARIS_OPENCLAW_AGENT:-main}" --message "<prompt>" --thinking "${POLARIS_OPENCLAW_THINKING:-low}" --json
```

Hermes is invoked in quiet query mode:

```bash
hermes chat --quiet --query "<prompt>"
```

OpenClaw's `--json` wrapper is unwrapped from its response text before parsing. Both providers should ultimately return either JSON or a plain text list. Preferred JSON shape:

If the deployment server uses a non-default OpenClaw agent, set `POLARIS_OPENCLAW_AGENT` before starting Polaris. For example:

```bash
POLARIS_OPENCLAW_AGENT=qa npm start
```

```json
{
  "summary": "一句话说明推荐逻辑",
  "steps": ["具体步骤 1", "具体步骤 2", "具体步骤 3"]
}
```

If neither `openclaw` nor `hermes` exists locally, the panel reports that local AI generation is unavailable.

Generated Suggest Action Plan and Draft Output payloads are persisted to `<data-dir>/ai-results/` before the browser updates the panel. The `查看 AI 结果` flow creates a Feishu document with `lark-cli docs +create --api-version v2 --as user`, persists the returned URL, and fills the completion link input after analysis finishes. If Feishu creation fails locally, Polaris writes a local HTML result page under `<data-dir>/ai-results/documents/` so the result link still resolves. While generation is in progress, the UI shows `AI 正在分析`.

AI prompts are built from the current task plus its upstream task chain, dependency results, related and global knowhow, skills, artifacts, and prior task results. The persisted cache key includes this context digest, so changed knowledge or accumulated results trigger regeneration.

Draft Output and Feishu result generation are constrained by the saved Suggest Action Plan. The plan is generated or read first, injected into the draft prompt as an implementation checklist, and its digest is included in downstream cache keys.

When a newly added task node is saved for the first time, Polaris asks the same local AI provider to pre-split it into child task nodes from the saved title and description. If no provider returns a usable split, Polaris falls back to a minimal local three-step split so the new node still starts with executable children.

Deployment servers can run with `openclaw` only. Polaris discovers `openclaw` before `hermes`, invokes it as `openclaw agent --agent "${POLARIS_OPENCLAW_AGENT:-main}" --message "<prompt>" --thinking "${POLARIS_OPENCLAW_THINKING:-low}" --json`, and accepts JSON or plain text from the response. `hermes` is only a fallback provider and is not required when `openclaw` is executable in the service root, `bin/`, `<data-dir>/bin`, or `PATH`.

## Test

```bash
npm test
```

## Data model

- Task-node seed data lives in `data/seed/task-nodes.js`.
- Knowledge, skill, and artifact seed data lives in `data/seed/library.js`.
- Bundled markdown knowledge and skills live in `data/knowledge/` and `data/skills/`.
- Project source configuration lives at `<data-dir>/polaris.project.json`.
- Runtime state is persisted to local SQLite at `<data-dir>/polaris.db`; this file is intentionally ignored by git when the default `data/` directory is used. Previous local database files are migrated automatically on first run.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
