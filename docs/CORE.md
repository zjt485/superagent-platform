# Core Router / Worker

The platform runs on the unified Router / Dispatcher core (`server/src/core/`).
The legacy `dual/` Main/Executor session engine has been removed.

## Configuration

```bash
# rule (default) or llm
CORE_ROUTER=rule
CORE_POLL_INTERVAL_MS=1000
# fake | command | openai
AGENT_RUNTIME=openai
```

Feishu/WeCom messages on a bound project chat are written to `triggers` and
processed by the core Router loop. Commands are handled deterministically by
`core/commands.ts` (`/status`, `/approve`, `/cancel`, `/retry`, `/help`).

For `CORE_ROUTER=llm`, the Router uses `LLM_BASE_URL`, `LLM_API_KEY`, and
`LLM_MODEL`, and records prompt/output token usage into `evaluations` and the
daily `usage` table.

## Processes

- `pnpm dev:worker` / `pnpm core:worker` runs the standalone Router + Dispatcher
  worker (including dynamic workspace provisioning, concurrency/budget checks,
  heartbeat updates, and stale turn reaping).
- For local single-process development, set `INLINE_WORKER=true` on `pnpm dev:api`.
  (`INLINE_WORKER=true` is rejected when `NODE_ENV=production`.)
- `pnpm dev:api` plus `pnpm dev:worker` is the recommended local split.

## Optional & Local Repositories

Projects activate immediately on creation without requiring a bound GitHub
repository or IM channel:

- **No bound repo**: each ticket runs in an isolated scratch workspace under
  `WORKSPACES_DIR/tickets/<ticketId>`.
- **Local git repo**: bind an absolute local git directory via:

```bash
POST /v1/projects/:id/local-repo
{ "path": "D:/code/my-project", "defaultBranch": "main" }
```

Core mirrors it under `WORKSPACES_DIR/projects/<projectId>/repo.git`, creates
one worktree per ticket, and commits the `agent/*` branch without pushing or
opening a PR.
- **GitHub repo**: uses GitHub App installation tokens, mirrors the repo,
  pushes `agent/*`, and opens a PR.

## API

- `POST /internal/core/triggers` — feed a trigger manually (Bearer `INTERNAL_TOKEN`).
- `POST /internal/core/tick` — run one Router sweep manually.
- `GET /v1/projects/:id/router-runs` — Router runs + per-trigger decisions.

## Tests

```bash
pnpm --filter @superagent/server exec vitest run tests/core
pnpm check
```
