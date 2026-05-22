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

Polaris is meant to run against a local data directory. That directory owns the portable task-node JSON, SQLite runtime mirror, project source configuration, generated output, and editable markdown-backed knowledge and skills.

By default, the demo keeps that data outside the git checkout:

- macOS: `~/Library/Application Support/Polaris`
- Windows: `%APPDATA%\Polaris`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/polaris`

The repo's `data/` directory is only the bundled seed/template data. On first run, Polaris copies missing seed knowledge and skills into the user data directory. If an older checkout already has runtime data in `data/`, the default startup path migrates those files once into the user data directory.

First deployment starts with no goal tree. Create the root Polaris goal in the UI; from that point on, task nodes, card state, conclusions, and completion links are user data. To load the bundled demo goal tree deliberately, start with:

```bash
npm start -- --seed-demo
```

or:

```bash
POLARIS_SEED_DEMO=1 npm start
```

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
  task-nodes.json
  polaris.db
  ai-results/
    *.json
    documents/
      *.html
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

Markdown files from configured `knowledge` and `skills` sources are imported on server start. The three library areas now follow these ownership rules:

### Current Output

Current Output stays user-owned. Generated action plans, draft output cards, executed AI result payloads, and local fallback HTML documents live under `<data-dir>/ai-results/`. Task completion links are also mirrored in `<data-dir>/task-nodes.json` through each node's `result` field.

### Skills

Each skill is one `.md` file. The file name is the displayed title, and the file should include a `description` plus the concrete content:

```markdown
---
description: 判断当前节点最关键的阻塞点，避免平均用力。
relatedNodeIds: analyze-gtm-ops, write-judgement
---

## 具体内容

生成 action plan 前，先收敛这个任务真正要解决的问题。
```

The web UI shows the skill title and description. Editing the card writes back to that `.md` file.

### Knowledge

Each knowledge `.md` file represents one type/tag and can contain multiple knowledge entries. The web UI groups entries by `TAG` and shows each entry's `Brief`.

```markdown
# TAG: agent-application

> Agent 落地产品、场景设计、ToB 应用认知。

---

## 2025-08-27

**Brief**：现阶段用 workflow，不要用 agentic

自主行动（Act）效果普遍差，RAG 还行。类 workflow 的有限次推理比完全自主的 Agent 更可控、效果更稳。
```

Knowledge parser fields:

- `# TAG: ...`: grouping tag shown in the web UI.
- First blockquote after the tag: type description shown on the group card.
- `## YYYY-MM-DD`: entry date.
- `**Brief**：...`: entry brief shown in the index.
- Body below the brief: entry description and AI context content.
- Optional front matter `relatedNodeIds`: comma-separated task node ids that should use every entry in the file.

Verify the data plane after restart:

```bash
curl http://127.0.0.1:4173/api/project
curl http://127.0.0.1:4173/api/library
```

Use the actual port printed by `npm start` if it is not `4173`. A connected external markdown file appears in `/api/library` with a path like `/sources/my-local-notes/file-name.md`, and it is visible in the Knowledge or Skill view. Editing a markdown-backed source item in the browser writes back to the source `.md` file and rebuilds its library index.

Data handoff checklist:

- `npm start` launches the browser UI with no extra packages to install.
- `POLARIS_DATA_DIR` or `--data-dir` points the app at a deployer's own local state.
- Without an override, Polaris uses the OS user data directory, not the git checkout.
- First deployment does not import the bundled demo goal tree unless `--seed-demo` or `POLARIS_SEED_DEMO=1` is set.
- `polaris.project.json` lists every local data source that should be imported.
- New or renamed markdown files require a server restart so the source scan can rebuild the library index.
- Existing markdown content can be edited from the browser and persists to disk.
- Task-node state persists in `<data-dir>/task-nodes.json`; SQLite mirrors it for the running app.
- Markdown-backed `knowledge` and `skills` are user-maintained through project sources.
- AI output remains readable after the app is gone because result JSON and fallback HTML are plain files under `<data-dir>/ai-results/`.

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

Generated Suggest Action Plan, Draft Output, and executed AI Result payloads are persisted to `<data-dir>/ai-results/` before the browser updates the panel. Draft Output remains the preview card, while the `查看 AI 结果` flow runs a separate execution prompt that produces the actual result body, such as an analysis table, findings, and follow-up actions. Polaris then creates a Feishu document with `lark-cli docs +create --api-version v2 --as user`, persists the returned URL, and fills the completion link input after analysis finishes. If Feishu creation fails locally, Polaris writes a local HTML result page under `<data-dir>/ai-results/documents/` so the result link still resolves. While generation is in progress, the UI shows `AI 正在分析`.

AI prompts are built from the current task plus its upstream task chain, dependency results, related and global knowhow, skills, artifacts, and prior task results. The persisted cache key includes this context digest, so changed knowledge or accumulated results trigger regeneration.

Draft Output and Feishu result generation are constrained by the saved Suggest Action Plan. The plan is generated or read first, injected into the draft prompt as an implementation checklist, and its digest is included in downstream cache keys.

When a newly added task node is saved for the first time, Polaris asks the same local AI provider to pre-split it into child task nodes from the saved title and description. If no provider returns a usable split, Polaris falls back to a minimal local three-step split so the new node still starts with executable children.

Deployment servers can run with `openclaw` only. Polaris discovers `openclaw` before `hermes`, invokes it as `openclaw agent --agent "${POLARIS_OPENCLAW_AGENT:-main}" --message "<prompt>" --thinking "${POLARIS_OPENCLAW_THINKING:-low}" --json`, and accepts JSON or plain text from the response. `hermes` is only a fallback provider and is not required when `openclaw` is executable in the service root, `bin/`, `<data-dir>/bin`, or `PATH`.

## Test

```bash
npm test
```

## Data model

- Optional demo task-node seed data lives in `data/seed/task-nodes.js`; it is only imported when demo seeding is explicitly enabled.
- System-maintained output artifact seed data lives in `data/seed/library.js`.
- The repo's `data/knowledge/` and `data/skills/` are bundled seeds; user-maintained markdown knowledge and skills live in the configured data directory or external project sources.
- Project source configuration lives at `<data-dir>/polaris.project.json`.
- Task tree structure, card state, conclusions, and completion result links live in `<data-dir>/task-nodes.json`.
- Local SQLite at `<data-dir>/polaris.db` is a runtime mirror/index, not the only copy of user state.
- Generated AI output lives in `<data-dir>/ai-results/` as JSON plus local HTML documents when Feishu publishing is unavailable.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
