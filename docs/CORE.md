# Core Router / Worker

The platform can now run the agentd-style Router/Worker core instead of the
legacy Main/Executor sessions. The core is additive: `dual/` stays until the
migration is finished.

## Enable

```bash
CORE_ENABLED=true
# rule (default) or llm
CORE_ROUTER=rule
CORE_POLL_INTERVAL_MS=1000
```

With `CORE_ENABLED=true`, Feishu/WeCom messages on a bound project chat are
written to `triggers` and processed by the core loop. Commands are handled by
`core/commands.ts` (`/status`, `/approve`, `/cancel`, `/retry`, `/help`).

For `CORE_ROUTER=llm`, the Router uses the OpenAI-compatible settings
`LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`.

## Processes

- `pnpm core:worker` runs the standalone Router + Dispatcher worker.
- The API process runs the same loop when `CORE_ENABLED=true` and
  `INLINE_WORKER` is not required. Do not run the legacy worker against the
  same database in core mode; both consume `session_turns`.
- `pnpm dev:api` plus `pnpm core:worker` is the recommended local split.

## Local repositories

A project can bind a local git directory instead of GitHub:

```bash
POST /v1/projects/:id/local-repo
{ "path": "D:/code/my-project", "defaultBranch": "main" }
```

The path must be absolute and a git work tree. Core mirrors it under
`WORKSPACES_DIR/projects/<projectId>/repo.git`, creates one worktree per ticket,
and commits the `agent/*` branch without pushing or opening a PR. The GitHub
repo binding and PR delivery remain available for GitHub-backed projects.

## API

- `POST /internal/core/triggers` — feed a trigger manually (Bearer
  `INTERNAL_TOKEN`).
- `POST /internal/core/tick` — run one Router sweep manually.
- `GET /v1/projects/:id/router-runs` — Router runs + per-trigger decisions.

## Tests

```bash
pnpm --filter @superagent/server exec vitest run tests/core
pnpm check
```

The core suite covers the stage machine, Router board/output/apply/flush,
intake, dispatch, worktree/mirror, PR delivery, local repositories, commands,
multi-project isolation and the LLM Router.

## Not migrated yet

- Per-turn fork of the agentd tool loop (the worker currently uses the
  platform `TurnRuntime`; `command` mode already spawns a child).
- Per-project `CORE_ENABLED` (the switch is global).
- Project-level concurrency/token budget in the core Dispatcher.
- Console UI for Router runs / turn details.
- Data migration from `dual/` and removal of the legacy tables.
