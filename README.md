# Northstar

Northstar is a local demo for exploring an AI-native task-node workflow. It separates the task tree, reusable knowledge, skills, and output artifacts into a small data layer while keeping the browser UI lightweight.

## Run locally

```bash
npm start
```

The demo starts on `http://127.0.0.1:4173/`. If the port is already in use, the server automatically tries the next available port.

## Test

```bash
npm test
```

## Data model

- Task-node seed data lives in `data/seed/task-nodes.js`.
- Knowledge, skill, and artifact seed data lives in `data/seed/library.js`.
- Markdown-backed knowledge and skills live in `data/knowledge/` and `data/skills/`.
- Runtime state is persisted to local SQLite at `data/northstar.db`; this file is intentionally ignored by git. Existing `data/polaris.db` data is copied forward on first run.

## Project layout

- `demo/`: browser UI and styles.
- `scripts/serve-demo.js`: local static/API server.
- `src/task-nodes.js`: task-tree primitives.
- `src/app-logic.js`: queue, ranking, completion, and output logic.
- `src/data/repository.js`: SQLite-backed repository.
- `test/`: Node test suite.
