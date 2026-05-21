# Northstar

Northstar is a local demo for exploring an AI-native task-node workflow. It separates the task tree, reusable knowledge, skills, and output artifacts into a small data layer while keeping the browser UI lightweight.

## Run locally

Requires Node.js 22.5 or newer.

```bash
npm start
```

The demo starts on `http://127.0.0.1:4173/`. If the port is already in use, the server automatically tries the next available port.

## Use a local knowledge directory

All writable local filesystem state can live under one configured directory:

```bash
NORTHSTAR_DATA_DIR=/path/to/northstar-data npm start
```

You can also pass it as a CLI flag:

```bash
npm start -- --data-dir /path/to/northstar-data
```

Northstar expects this shape:

```text
northstar-data/
  northstar.db
  knowledge/
    *.md
  skills/
    *.md
```

Markdown files under `knowledge/` and `skills/` are imported automatically. Files may use optional front matter:

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

## Test

```bash
npm test
```

## Data model

- Task-node seed data lives in `data/seed/task-nodes.js`.
- Knowledge, skill, and artifact seed data lives in `data/seed/library.js`.
- Bundled markdown knowledge and skills live in `data/knowledge/` and `data/skills/`.
- Runtime state is persisted to local SQLite at `<data-dir>/northstar.db`; this file is intentionally ignored by git when the default `data/` directory is used. Existing `<data-dir>/polaris.db` data is copied forward on first run.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
