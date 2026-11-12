# Core rewrite: Main Session / Executor Session

> Status: implemented. The engine now runs Main/Executor sessions; the legacy
> `runs` / `run_events` tables and code were removed in migration 0004. This
> document remains the frozen target and protocol reference.

This document freezes the target core before code is replaced. The existing
service shell (auth, projects, members, invites, IM/GitHub adapters, outbox,
audit, console) stays; the **workflow core** moves from
`trigger → deterministic intake → plan/execute runs` to
`trigger → eval → Main Session decision → ticket/mandate → Executor Session reports`.

## 1. Target concepts

| Concept | Persistence | Owner |
| --- | --- | --- |
| **Main Session** | one per project, persistent transcript | Main Session agent |
| **Executor Session** | one per ticket, persistent transcript + directory | Executor agent |
| **Trigger** | `triggers` row, deduped per provider | IM/GitHub intake |
| **Thread** | `(project, provider, chat, thread_key)` | subscription key |
| **Eval** | `evaluations` batch per thread, one active | Engine |
| **Decision** | `evaluations.decision` + audit | Main Session |
| **Mandate** | `mandates` row, policy version + scope + strength | Engine |
| **Ticket** | existing `tickets` row + `stage` | Engine |
| **Subscription** | `ticket_subscriptions` | Engine |
| **Assignment** | `assignments`, one per executor turn | Engine |
| **Report** | `reports` | Executor Session |
| **Input** | `inputs`, trigger/note/policy/approval | Engine |
| **Session turn** | `session_turns`, one model call | Worker |

A turn is the unit of execution and queueing. Main Session turns (`kind=eval`)
and Executor Session turns (`kind=execute`) share the queue and worker pool.

## 2. Flows

### New request

```text
IM @bot message
  → trigger (dedupe)
  → evaluations(queued) for thread + session_turn(eval)
  → Main Session turn: decisions = accept / ignore / stop / attach
  → accept: ticket + mandate + subscription + assignment + executor turn
  → Executor Session turn: plan or implementation
  → report: progress | waiting | ready | blocked | failed | dropped
  → ticket stage; ready → branch/commit/PR → review
  → human merge webhook → ticket done
```

### Follow-up

```text
message on subscribed thread
  → input for each subscribed ticket (no Eval)
  → resume ended ticket only if mandate still holds and nobody stopped it
  → queue executor turn if idle/blocked/failed/ready, otherwise wait for current turn
```

### Policy

Policy JSON is versioned by hash. Every Mandate records the version. A policy
change does not cancel live tickets; it writes a `policy` input to affected
tickets. Revalidation happens before resuming an ended ticket.

### Plan approval

Plan approval is a gate **inside the Executor Session**, not a second agent:
`planApproval=required` → first executor turn returns `progress` with a plan and
no persistence changes; ticket stage `plan_review`; a maintainer approve writes
an `approval` input and queues the next executor turn. `auto` lets the executor
implement in the same turn.

## 3. Protocols

Both agents return JSON (or `.superagent/result.json` from the command runtime).

Main Session output:

```json
{
  "decisions": [
    {
      "triggerId": "uuid",
      "action": "accept",
      "reason": "explicit request from project member",
      "ticket": {
        "title": "登录页文案改成中文",
        "body": "原始需求",
        "scope": "只修改前端文案",
        "strength": "explicit",
        "planApproval": "required"
      },
      "reply": "已接单，正在分析仓库。"
    }
  ]
}
```

Executor Session output:

```json
{
  "status": "progress",
  "summary": "已生成计划",
  "plan": "1. ... 2. ...",
  "attention": { "question": "需要确认是否兼容旧版本？" },
  "branch": "agent/abc123",
  "tokens": 1234,
  "cost": 0.01
}
```

`status=ready` means the work is reviewable. The platform commits, pushes and
opens the PR (the agent does not push), keeping the service's repository
safeguards.

## 4. Stage model

Derived per ticket from the latest assignment/report/input:

| Stage | Meaning |
| --- | --- |
| `queued` | waiting for a worker turn |
| `working` | executor turn running / progress |
| `plan_review` | plan awaits a human |
| `idle` | executor waiting for a trigger |
| `review` | ready, PR awaits a human |
| `blocked` / `failed` | needs a person or a retry |
| `answer` | attention question pending |
| `done` / `cancelled` | ended |

The old `tickets.status` stays as a projection for the existing API/UI during
the migration; `tickets.stage` is the source of truth.

## 5. Session directories

- Main Session: scratch directory only; no repository checkout.
- Executor Session: `${WORKSPACES_DIR}/${projectId}/tickets/${ticketId}`, cloned
  once and reused across turns so follow-ups see prior work. Cleaned when the
  ticket ends or by retention.
- One active turn per Session enforced by a partial unique index.

## 6. Service wrapper mapping

| Existing piece | Reused as |
| --- | --- |
| IM webhooks/adapters | normalize messages → `receiveTrigger` |
| GitHub App | branch/PR delivery + PR webhook → input/report |
| Worker process | `session_turns` queue consumer |
| Postgres/PGlite | additions in migration 0002 |
| Console | main session transcript, ticket stage, executor session, reports |
| Outbox/audit/usage | unchanged, plus session events |

## 7. Non-goals for the first rewrite pass

- Inferred candidates, bot admission tables, full proactive rules (explicit @bot only).
- Subagent/background-job lifecycle inside DSH.
- Thread context-only follows (own threads only).
- Multiple pull requests per ticket (first PR is followed).
- Prompt override versioning; prompts are code.
