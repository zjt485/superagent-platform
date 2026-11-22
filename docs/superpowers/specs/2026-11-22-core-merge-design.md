# Superagent Platform × agentd 内核融合设计

- 日期：2026-11-22
- 状态：已确认，进入实施
- 目标仓库：`zjt485/superagent-platform`
- 参考实现：`D:\agents\agentd`（Router + 每回合 fork Worker）
- 保留资产：现有平台壳、Feishu/WeCom 适配器、GitHub App、Web 控制台、部署文件

## 1. 目标与非目标

### 1.1 目标

把平台现有的 Main Session / Executor Session 内核替换为 agentd 的 Router / Dispatcher / fork Worker 内核，同时保留平台的产品能力：

- 多项目、成员/角色、邀请、项目群绑定；
- 飞书 / 企业微信回调、企业微信智能机器人、扫码入群；
- GitHub App、分支、PR、PR 评论与合并 webhook；
- Web 控制台、审计、用量、Outbox、Docker Compose 部署；
- 功能等价：平台现有 59 个测试、企微验证测试、控制台主要流程不退化。

### 1.2 非目标

- 不重写 IM / GitHub 适配器协议；
- 不把平台改成单机 SQLite daemon；
- 不在本期实现多 PR、context 订阅、每 Turn 容器化、OTel 等 M3 能力；
- 不删除旧表，直到切换完成且回滚窗口关闭。

## 2. 关键决策

| 决策 | 选择 |
| --- | --- |
| 运行形态 | 服务端平台 + agentd 内核，一套部署 |
| 数据库/队列 | Postgres/PGlite + Redis/BullMQ；DB 是事实源，Redis 只做唤醒 |
| 内核替换方式 | 原地换芯：新增 `server/src/core/`，与 `dual/` 并行，测试全绿后删 `dual/` |
| 状态事实源 | `tickets.stage`；`tickets.status` 仅作旧控制台投影 |
| Router run 表 | 复用 `evaluations`，扩展 token/模型字段 |
| Executor session | 保留每工单一个 `agent_sessions(role=executor)` 存 transcript |
| 工作区 | 每个项目一个镜像 clone，每张工单一个 `git worktree` |
| 消息路由 | 所有普通消息都过 Router，包括线程追问；命令走确定性快路径 |
| 交付 | Worker 只改 worktree，平台负责 commit/push/PR |
| 计划审批 | `reports.plan` + `stage=plan_review` + `/approve` input，不引入第二个 Agent |

## 3. 架构与进程

```
api 进程
  Fastify: /webhooks、/v1、控制台
  intake：验签/去重/项目/群/成员校验 → triggers + threads.routerPending
  notify worker（Redis/BullMQ；DB 轮询兜底）

worker 进程（INLINE_WORKER=1 时跑在 api）
  tick:
    1. flushRouters()   按 thread 批量跑 Router → evaluations/decisions/tickets/turns/outbox
    2. dispatchTurns()  claim queued turn → fork child → report → stage/PR/outbox
    3. flushOutbox()    发回执/通知
```

### 3.1 模块边界

```
server/src/core/
├── domain/       纯类型、状态机、ID（零 IO）
├── store/        Drizzle 仓储：triggers/threads/tickets/turns/decisions/outbox
├── router/       board/output/model/llm-model/apply/flush
├── worker/       dispatcher/fork-executor/child/workspace
├── agent/        prompt/messages/tools/transcript/loop
├── llm/          OpenAI-compatible client
└── trace/        事件 ingest
```

平台壳保持不变：

- `server/src/app/`、`server/src/services/`、`server/src/im/`、`server/src/github/`、`server/src/domain/`；
- `server/src/dual/` 在并行期保留，切换完成后删除；
- `web/` 继续消费现有 API，新增 Router run / turn 视图。

## 4. 数据模型

### 4.1 复用与扩展

| 表 | 变更 |
| --- | --- |
| `triggers` | 加 `disposition`、`address` |
| `evaluations` | 作为 Router run：加 `model`、`prompt_tokens`、`output_tokens`、`summary` |
| `tickets` | 加 `short_name`、`worktree_path`、`base_ref`；`stage` 为事实源 |
| `session_turns` | 只保留 `kind=execute`；加 `seq`、`pid`、`exit_code`；`input` 存 inputIds |
| `ticket_inputs` | 加 `kind`、`delivered_turn_id` |
| `reports` / `assignments` / `mandates` | 保留，由新内核写入 |
| `outbox_events` / `turn_events` / `audit_logs` / `usage` | 不变 |

### 4.2 新增表

`threads`：

- `(project_id, channel_id, thread_key)` 唯一；
- `summary`、`router_pending`、`router_lease_until`、`last_trigger_at`。

`decisions`：

- 一行一个 Trigger 的 `action / ticket_id / title / reason / confidence`；
- `unique(trigger_id)`，保证重放不重复建单。

### 4.3 状态映射

| agentd | 平台 stage |
| --- | --- |
| open | queued |
| running | working |
| waiting + plan | plan_review |
| waiting | idle |
| ready | review / answer |
| blocked | blocked |
| failed | failed |
| ended（合并） | done |
| ended（停止） | cancelled |

`nextStage(current, event)` 直接返回平台 stage；不再保留 agentd 5 状态双写。`reports.status` 使用平台 6 种：progress / waiting / ready / blocked / failed / dropped。

## 5. 运行流程

### 5.1 Intake

1. 适配器验签、去重、项目/群/成员校验（沿用平台逻辑）。
2. 命令（`/status` `/cancel` `/retry` `/approve` `/bind` `/help`）同步处理，写 `intake_events`/audit，回执进 Outbox，不进 Router。
3. 普通消息写 `triggers`，`threads.router_pending=true`，notify worker。
4. 所有普通消息都过 Router；线程追问由 Router 产出 `attach`。

### 5.2 Router flush

1. `FOR UPDATE SKIP LOCKED` 认领 pending thread，拿租约。
2. 取最多 5 条 pending Trigger，组装状态板（项目/Policy、线程摘要、开放工单、最近消息、本批消息）。
3. 调 RouterModel（JSON schema）；失败重试一次，再失败标 `pending_review`。
4. 单事务落库：
   - 写 `evaluations`（Router run）与 `decisions`；
   - `ignore`：改 disposition；
   - `new`：ticket + mandate + subscription + 首个 queued turn + 回执；
   - `attach`：写 `ticket_inputs`，idle/review/blocked/failed 时排下一回合；
   - `stop`：ticket → cancelled，取消 queued turns；
   - 更新 thread summary，清 pending。

### 5.3 Dispatcher

1. 认领 queued turn，置 running、写 heartbeat，ticket stage → working。
2. 取未投递 input，标记 `delivered_turn_id`。
3. 确保项目镜像；给工单开/复用 worktree；建 `agent/<shortName>` 分支。
4. 写 `ChildInput`，fork 子进程，等待/超时/取消 kill，记录 `pid`。
5. 读 `report.json`，写 `reports`/`turn_events`，ingest transcript。
6. `ready` → 平台 commit/push/PR，stage → review；`waiting+plan` → plan_review；`blocked` → blocked；`failed` → failed；写 Outbox。

### 5.4 Outbox / GitHub

- 回执、提问、PR 通知走 `outbox_events`，保留幂等、顺序、指数退避。
- PR 评论 → `ticket_inputs` 续跑；merge → done；close → cancelled。

### 5.5 恢复

- Router 租约过期可重领；
- running turn 心跳过期 → 按 pid kill，置 failed/requeue；
- `decisions.unique(trigger_id)` 保证重放不重复建单。

## 6. 控制台兼容

| 旧视图 | 新数据 |
| --- | --- |
| Main Session | Router run：`evaluations` + `decisions` |
| Executor Session | 工单回合：`session_turns` + `reports` + `turn_events` + transcript |
| 工单/审批/命令/PR/审计/用量 | 保持不变 |

旧 `/v1/sessions` 等 API 保留 DTO 兼容；新增 `/v1/router-runs`。无法映射的 Main Session 字段用 Router run 字段展示，不丢数据。

## 7. 分阶段实施

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P0 | 加表/列 + core domain/repos + 测试 | 不改行为，`pnpm check` 绿 |
| P1 | Router 路径，按项目 flag；旧 dual 服务旧项目 | 新项目能建单/回执；WeCom 测试绿 |
| P2 | Dispatcher + fork worker + 镜像/worktree + 平台 PR | 新项目跑完一单到 PR |
| P3 | 控制台/API 映射、命令、审批、审计 | 功能等价测试全绿 |
| P4 | 迁移存量项目、删 dual/main session、文档与 CI | 全量回归绿，关闭回滚窗口 |

回滚：per-project feature flag；旧表保留；P4 前不做破坏性迁移。

## 8. 测试

- 移植 agentd 302 个测试：domain/状态机、store（PGlite）、router、dispatcher/fork、workspace/worktree、outbox、trace、e2e。
- 保留平台 59 个测试：auth/项目/邀请/IM/GitHub/service；service 测试按新内核改，WeCom/Feishu 适配器测试不动。
- 新增集成：WeCom/Feishu → trigger → Router（假模型）→ 工单 → fork worker（假执行器）→ report → outbox；计划审批；重启恢复；PR merge。
- CI 跑 `pnpm check`；默认 PGlite，不依赖外部 Postgres；Redis 集成测试可选。

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 状态映射错 | 单一 `nextStage` + 穷举测试 |
| worktree 并发/磁盘 | 项目级 advisory lock、清理任务、配额 |
| Router 每条消息调模型 | 批量窗口、token 记账；后续加单工单线程快路径 |
| fork 子进程安全 | 容器内跑、不挂宿主 `.env`、限制命令与资源 |
| 企微回归 | 适配器契约测试不动，加 golden 用例 |
| 数据迁移 | 先加列、双轨、回填脚本 dry-run、保留旧表 |

## 10. 开放项

- GitHub 推送权限：当前只有网页只读会话；落地时需要 repo 写权限的 token，或一次 GitHub CLI 授权。
- `DEVELOPMENT_PLAN.md` 不在仓库内；本设计以现有 `docs/` 与 `docs/STATUS.md` 为准。
