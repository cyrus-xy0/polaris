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

The repo's `data/` directory is only bundled seed/template data. On first run, Polaris creates empty user-owned knowledge and skill directories; it does not copy bundled demo markdown unless demo seeding is explicitly enabled. Normal startup never overwrites `polaris.project.json`, only normalizes `polaris.local.json` when it contains legacy task-node directory paths or unsupported source kinds, and never deletes existing `knowledge/` or `skills/` markdown. If an older checkout already has runtime data in `data/`, the default startup path migrates those files once into the user data directory.

First deployment starts with no goal tree, knowledge, skills, or demo output artifacts. Create the root Polaris goal and add reusable material in the UI; from that point on, task nodes, card state, conclusions, completion links, knowledge, skills, and output artifacts are user data. To load the bundled demo goal tree, demo markdown, and demo artifacts deliberately, start with:

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

Polaris keeps this runtime shape outside the checkout. The task-node card file is created once the task tree is first saved, at the file path configured by `paths.taskNodes` in `polaris.local.json`:

```text
polaris-data/
  polaris.project.json
  polaris.local.json
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

`polaris.project.json` owns stable project identity only:

```json
{
  "name": "Polaris"
}
```

`polaris.local.json` owns every local landing path, so upgrades can change code without rewriting user-maintained directories:

```json
{
  "version": 1,
  "paths": {
    "taskNodes": "task-nodes.json",
    "database": "polaris.db",
    "aiResults": "ai-results"
  },
  "ai": {
    "timeoutMs": 120000,
    "splitTimeoutMs": 60000
  },
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

`paths.taskNodes` is a JSON file path relative to the data directory, or an absolute local file path. For example, `"taskNodes": "/Users/me/PolarisTasks/cards.json"` keeps task state in `/Users/me/PolarisTasks/cards.json`. Legacy directory-style values are still accepted for upgrade compatibility: `"taskNodes": "tasks"` is normalized to `"tasks/task-nodes.json"` and the old root `task-nodes.json` is copied once if needed.

`paths.database` controls the SQLite runtime mirror, and `paths.aiResults` controls generated action-plan/result JSON plus fallback HTML output. Both may also be relative to the data directory or absolute local paths.

`ai.timeoutMs` controls action-plan, draft-output, and executed AI-result generation. `ai.splitTimeoutMs` controls manual AI child-node generation. These values live in the user-owned data directory and are preserved across project code updates; environment variables can still override them for a single process.

The Focus screen also exposes the same AI timeout values in seconds and saves changes back to `polaris.local.json` in the active data directory. Changes apply to new AI jobs immediately; restart is only needed when editing the JSON file by hand.

To connect your own knowledge or skill folder, stop the server, add another `sources` entry in `polaris.local.json`, and restart. `path` may be relative to the data directory or an absolute local path:

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

Current Output stays user-owned. Generated action plans, draft output cards, executed AI result payloads, and local fallback HTML documents live under `paths.aiResults`. Task completion links are also mirrored in the configured task-node file through each node's `result` field.

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
- Project upgrades only change code and bundled seed templates; they do not rewrite existing project config, task nodes, knowledge, skills, or AI timeout values in the data directory. Local config is only normalized for legacy task-node directory paths, missing AI timeout defaults, and unsupported source kinds.
- First deployment does not import the bundled demo goal tree, knowledge, skills, or output artifacts unless `--seed-demo` or `POLARIS_SEED_DEMO=1` is set.
- `polaris.project.json` keeps only stable project identity.
- `polaris.local.json` lists local storage paths and every existing knowledge or skill source that should be imported; unsupported source kinds are dropped during normalization.
- New or renamed markdown files require a server restart so the source scan can rebuild the library index.
- Existing markdown content can be edited from the browser and persists to disk.
- Task-node state persists at `paths.taskNodes`; SQLite mirrors it for the running app.
- Markdown-backed `knowledge` and `skills` are user-maintained through project sources.
- AI output remains readable after the app is gone because result JSON and fallback HTML are plain files under `paths.aiResults`.

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

If neither `openclaw` nor `hermes` exists locally, or if the provider times out, Polaris now generates a deterministic local fallback so the task flow still returns JSON and remains usable.

Generated Suggest Action Plan, Draft Output, and executed AI Result payloads are persisted to `paths.aiResults` before the browser updates the panel. Draft Output remains the preview card, while the `查看 AI 结果` flow runs a separate execution prompt that produces the actual result body, such as an analysis table, findings, and follow-up actions. Polaris then creates a Feishu document with `lark-cli docs +create --api-version v2 --as user`, persists the returned URL, and fills the completion link input after analysis finishes. If Feishu creation fails locally, Polaris writes a local HTML result page under `<paths.aiResults>/documents/` so the result link still resolves. While generation is in progress, the UI shows `AI 正在分析`.

The browser does not run those AI jobs automatically on page load. Use the small generate/refresh button on the current task card to create or regenerate the action plan, draft, and final result. If the task already has a generated result document, regeneration updates that original document instead of creating a new one.

AI prompts are built from the current task plus its upstream task chain, dependency results, related and global knowhow, skills, artifacts, and prior task results. The persisted cache key includes this context digest, so changed knowledge or accumulated results trigger regeneration.

Draft Output and Feishu result generation are constrained by the saved Suggest Action Plan. The plan is generated or read first, injected into the draft prompt as an implementation checklist, and its digest is included in downstream cache keys.

When a newly added task node is saved, Polaris does not automatically create child nodes. The node editor shows an `AI 生成子节点` action for leaf nodes; choosing it saves the current title and description, then asks the same local AI provider to generate child task nodes. If no provider returns a usable split, Polaris falls back to a minimal local three-step split so the node can still start with executable children.

Polaris reads AI timeout defaults from the user-owned `polaris.local.json`, so each deployment can tune slow local providers without carrying those edits in the git checkout:

- `ai.timeoutMs` defaults to `120000` for action plans, draft output, and AI result generation. `POLARIS_AI_TIMEOUT_MS` can override it for a single server process.
- `ai.splitTimeoutMs` defaults to `60000` for manual AI child-node generation. `POLARIS_AI_SPLIT_TIMEOUT_MS` can override it for a single server process.
- `POLARIS_FEISHU_TIMEOUT_MS` defaults to `8000` per `lark-cli` operation before falling back to local HTML.
- The browser writes Focus-screen AI timeout edits to the active data directory's `polaris.local.json`, not to files tracked by the repo.

Deployment servers can run with `openclaw` only. Polaris discovers `openclaw` before `hermes`, invokes it as `openclaw agent --agent "${POLARIS_OPENCLAW_AGENT:-main}" --message "<prompt>" --thinking "${POLARIS_OPENCLAW_THINKING:-low}" --json`, and accepts JSON or plain text from the response. `hermes` is only a fallback provider and is not required when `openclaw` is executable in the service root, `bin/`, `<data-dir>/bin`, or `PATH`.

## Test

```bash
npm test
```

## Data model

- Optional demo task-node seed data lives in `data/seed/task-nodes.js`; it is only imported when demo seeding is explicitly enabled.
- Optional demo output artifact seed data lives in `data/seed/library.js`; it is only imported when demo seeding is explicitly enabled.
- The repo's `data/knowledge/` and `data/skills/` are bundled demo markdown; they are only copied when demo seeding is explicitly enabled.
- User-maintained markdown knowledge and skills live in the configured data directory or external local sources.
- Project identity lives at `<data-dir>/polaris.project.json`.
- Local storage paths and knowledge/skill source configuration live at `<data-dir>/polaris.local.json`.
- Task tree structure, card state, conclusions, and completion result links live at `paths.taskNodes`.
- Normal startup only creates missing runtime directories/files and rebuilds SQLite indexes from configured sources; it does not delete or reset existing user-maintained markdown or project/local config.
- Local SQLite at `paths.database` is a runtime mirror/index, not the only copy of user state.
- Generated AI output lives in `paths.aiResults` as JSON plus local HTML documents when Feishu publishing is unavailable.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
