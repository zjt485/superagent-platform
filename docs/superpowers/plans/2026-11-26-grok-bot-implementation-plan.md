# Superagent Platform → Grok Bot 分阶段实施计划

- 日期：2026-11-26
- 对应设计文档：[2026-11-26-grok-bot-architecture-design.md](../specs/2026-11-26-grok-bot-architecture-design.md)
- 执行原则：每个 Phase 独立可运行、有自动化测试门禁（`pnpm check` 全绿），不出现长时间不可用的大爆炸重构。

---

## 阶段总览

| 阶段 | 主题 | 核心交付物 | 预计体量 |
| --- | --- | --- | --- |
| **Phase 0** | **内核收口与清障** | 修复 `core/` 4 个实操隐患、补齐并发/预算/Turn 回收、下线 `dual/` | 1 周 |
| **Phase 1** | **Bot Roster + Rooms + 多 Bot Handoff** | `bots`/`rooms`/`room_messages` 表、产研模板、Router 选 Bot、`handoff` 防循环、Web Rooms + Roster + SSE 实时流 | 1.5–2 周 |
| **Phase 2** | **工具级审批（Suggest, don't send）+ IM 交互卡片** | `action_approvals` + Turn Checkpoint 断点续跑、Web 审批收件箱、飞书交互卡片 & 回调、企微卡片适配 | 1–1.5 周 |
| **Phase 3** | **持久化云电脑沙箱 + Playwright + MCP** | `SandboxProvider`（Docker 持久化容器 + 本地降级）、Playwright 截图流、MCP Client、`mcp_servers` 管理、右侧围观抽屉 | 2 周 |
| **Phase 4** | **7×24 Routines 定时与事件巡检** | `routines` 表与 `RoutineScheduler`、静默降噪汇报、Web Routines 看板、端到端联调与压测 | 1 周 |
| **V2（后续）** | **复利与完整桌面接管** | Bot 跨任务长期记忆（Memory）、轨迹一键沉淀 Skills、noVNC 人工接管桌面、单 Bot 独立 IM 凭据启用 | 后续规划 |

---

## Phase 0：内核收口与清障（消除双轨负担）

**目标**：让 `core/` 成为唯一且健壮的运行内核，修完已发现的 4 个代码接缝，安全移除 `dual/`。

### 任务清单
1. **修复 `core/` 现有 4 个隐患**
   - [server/src/core/router/board.ts](../../../server/src/core/router/board.ts) & [apply.ts](../../../server/src/core/router/apply.ts)：状态板同时渲染工单 `shortName` 与 `id`，`applyRouterOutput` 解析 `ticketId` 时兼容 UUID 与 `shortName`（按 `projectId` 作用域查库）。
   - [server/src/index.ts](../../../server/src/index.ts)：内嵌 `startCoreLoop` 正确注入 `workspace` provider，避免单进程模式退回临时目录。
   - [server/src/core-worker-main.ts](../../../server/src/core-worker-main.ts)：按需动态查询 `repos` 表（取消启动时一次性全量缓存），并支持 `provider === 'local'` 仓库路径。
   - [server/src/core/router/llm-model.ts](../../../server/src/core/router/llm-model.ts) & [flush.ts](../../../server/src/core/router/flush.ts)：解析 OpenAI `usage`，回写 `evaluations.prompt_tokens` / `output_tokens` 并记入 `usage` 日表。
2. **补齐 Core Dispatcher 生产守护**
   - 在 [server/src/core/worker/dispatcher.ts](../../../server/src/core/worker/dispatcher.ts) 加入项目级 `maxConcurrentRuns` 并发控制、每日 `dailyTokenBudget` 校验、心跳定时更新与失联 Turn 回收器（`reapStaleCoreTurns`）。
3. **收敛并移除 `dual/`**
   - 迁移 API 路由（`/v1/projects/:id/tickets`、`/v1/projects/:id/overview`、`/v1/runs/:id`）全部直读 `core` 仓储；
   - 解除项目激活必须绑定 Git 仓库和 IM 群的硬限制（`projects` 创建即可 `active`，仓库与 IM 变为可选能力）；
   - 将原 `service.test.ts` / `dual-core.test.ts` 的核心回归用例适配到 `core/`，删除 `server/src/dual/` 与 `CORE_ENABLED` 双轨分支。

### 验收标准
- `pnpm check` 全绿；无 `server/src/dual/` 引用；不绑定 Git 仓库的项目也能创建并运行任务。

---

## Phase 1：Bot Roster + 统一 Rooms + 多 Bot 群聊 Handoff + SSE

**目标**：完成产品形态从“单机器人后台”到“多 Bot 协作群聊工作台”的核心跃迁。

### 任务清单
1. **数据库迁移 `0007_bots_and_rooms.sql`**
   - 新增 `bots`、`rooms`、`room_bots`、`room_messages` 表；
   - 扩展 `tickets`（`bot_id`, `room_id`, `handoff_chain_id`, `handoff_hop`, `parent_ticket_id`）、`triggers`（`room_id`, `target_bot_id`, `source_bot_id`, `handoff_chain_id`, `handoff_hop`，`kind` 加 `handoff`）、`session_turns`（`bot_id`）。
2. **Bot Roster 服务与产研默认模板**
   - 新增 `server/src/services/bots.ts` 与 `/v1/projects/:id/bots` CRUD API；
   - 提供「产研团队预设模板」（产品经理、需求研究员、全栈工程师、QA 巡检），每个 Bot 独立配置人设 Prompt、模型配置和默认工具策略；
   - 支持每个 Bot 预留 `im_binding` 字段（V1 默认走项目单 IM 机器人 + `[Bot名 · 角色]` 署名）。
3. **Rooms 服务与 IM 双向同步**
   - 新增 `server/src/services/rooms.ts` 与 `/v1/projects/:id/rooms`（群聊 Room、与指定 Bot 单聊 DM）、`/v1/rooms/:id/messages`；
   - 飞书/企微群消息与单聊消息自动映射到对应 Room 的 `room_messages`；Web Room 发消息时如房间绑定了 IM Channel 则通过 Outbox 同步到飞书/企微群。
4. **多 Bot 路由与 `handoff` 接力引擎**
   - 升级 `core/router/`：状态板注入房间内在线 `bots` 列表；支持显式 `@bot-slug` 点名直达 + 泛说/ambient 消息由 LLM 选择最合适的 Bot；
   - 在自研 OpenAI 工具循环（新目录 `server/src/core/agent/`）中新增 `handoff` 工具，实现跨 Bot 接力、写入可视化交接消息，并强制校验 `maxHops` 与预算熔断。
5. **SSE 实时事件流与 Web 新工作台（首版）**
   - 新增 `server/src/services/events.ts`（PubSub，支持内存/Redis）与 `GET /v1/projects/:id/events/stream`；
   - 重构 `web/src/` 主界面：新增 **Rooms 协作群聊页**（支持 `@Bot` 补全、多 Bot 头像流、实时工具进度条、右侧工单/日志抽屉）与 **Roster 团队页**，替换原 5 秒轮询。

### 验收标准
- 可在一个 Web Room 里拉入「调研 Bot + 研发 Bot」，发一条需求后调研 Bot 自动完成分析并 `handoff` `@研发 Bot` 接力干活，全程通过 SSE 实时可见，且触发 `maxHops` 上限时自动熔断转人工。
- 飞书/企微群发消息与 Web Room 实时双向同步，回复带对应 Bot 署名。

---

## Phase 2：工具级「Suggest, don't send」审批 + 审批收件箱 + IM 交互卡片

**目标**：把粗糙的文本 `/approve` 升级为 Grok Bot 风格的工具级风险拦截与一键批复体验。

### 任务清单
1. **数据库迁移 `0008_action_approvals.sql`**
   - 新增 `action_approvals` 表；
   - 扩展 `session_turns`（`checkpoint`, `paused_approval_id`），`tickets.stage` 增加 `waiting_approval`。
2. **工具策略网关与 Checkpoint 断点续跑**
   - 在 `server/src/core/agent/gate.ts` 实现 `allow` / `confirm` / `deny` 工具拦截；
   - 命中 `confirm` 时：序列化当前 `messages[]` + `pendingToolCall` 存入 `session_turns.checkpoint`，创建 `action_approvals(pending)`（含人类可读预览），释放 Worker 槽位；
   - 新增 `/v1/projects/:id/approvals`（列表、批准、拒绝、带意见打回）：
     - 批准：排入 `resume` Turn，直接执行原工具并继续模型循环；
     - 拒绝/修改意见：排入 `resume` Turn，将拒绝理由/修改建议作为 `tool_result` 返回模型重新决策。
3. **Web「审批收件箱（Inbox）」与内联审批卡片**
   - 新增项目级「审批收件箱」页面，聚合所有 Bot 待确认动作，支持预览 Diff/命令/草稿，一键批准/拒绝/批注；
   - 在 Rooms 消息流中内联渲染审批卡片，审批后卡片状态通过 SSE 实时变更。
4. **飞书交互卡片 & 企微卡片升级**
   - 升级 [server/src/im/feishu.ts](../../../server/src/im/feishu.ts)：支持真正的 `interactive` 卡片发送、卡片原地更新（`PATCH`）与卡片按钮回调路由 `/webhooks/feishu/card`（验签 + 成员权限校验 + 触发审批）；
   - 升级 [server/src/im/wecom-bot.ts](../../../server/src/im/wecom-bot.ts)：发送带预览与一键跳转审批链接/卡片的 Markdown 通知，审批完成后回写结果。

### 验收标准
- 研发 Bot 准备推送分支开 PR（或调用外部写类工具）前自动暂停，不占并发槽位；人在 Web Inbox 或飞书卡片点「批准」后从断点继续完成执行，点「修改意见」后 Bot 按意见调整重做。

---

## Phase 3：持久化云电脑沙箱 + Playwright 浏览器 + MCP 连接器

**目标**：让每个 Bot 拥有自己的持久化 Linux 环境、真实浏览器操作能力和通用 MCP 工具生态，并在 Web 端可实时围观。

### 任务清单
1. **数据库迁移 `0009_mcp_and_sandbox.sql`**
   - 新增 `mcp_servers` 表；补充 `bots` 沙箱运行态与 artifact 存储索引字段。
2. **`SandboxProvider` 双实现**
   - 定义 `server/src/core/sandbox/provider.ts` 接口（`ensureRunning` / `execStream` / `readFile` / `writeFile` / `browser` / `sleep`）；
   - 实现 `LocalProcessSandboxProvider`（供本地开发、Demo 和 Vitest 使用）；
   - 实现 `DockerSandboxProvider` + 专用基础镜像 `deploy/bot-sandbox.Dockerfile`（非 root Debian + Node 22 + Python 3 + Git + Chromium/Playwright），挂载每 Bot 独立持久化卷 `sa-bot-home-<botId>`，支持闲置自动休眠与资源限额。
3. **Playwright 浏览器工具与实时围观流**
   - 为 Agent Loop 接入 `browser_open` / `browser_click` / `browser_type` / `browser_extract` / `browser_screenshot`（复用持久化 Browser Profile）；
   - 终端 stdout/stderr 与浏览器每次操作截图实时写入 `turn_events` / artifact 路由并通过 SSE 推送到前端；
   - Web 右侧「围观抽屉」展示实时终端输出流 + 最新浏览器画面帧时间轴。
4. **MCP Client 集成与连接器管理**
   - 实现 `server/src/core/mcp/client.ts`（支持 `stdio` 与 `streamable_http` / `sse` MCP server），自动发现工具并按 `bot.tool_policy` 挂载到 Agent Loop，所有写类 MCP 工具默认接入 Phase 2 审批网关；
   - Web 新增「连接器」配置页（统一管理可选的 GitHub/本地仓库 + MCP Servers）。
   - 可选保留外部 DSH / Coding CLI 作为研发 Bot 的一个受控子工具（`run_coding_agent`）。

### 验收标准
- QA 巡检 Bot 能在自己的持久化 Docker 容器里打开测试环境网页、截图定位页面报错并在 Room 发出图文报告；重启容器后 Bot 的持久化目录与浏览器状态依然保留；MCP 工具接入后可受工具级审批管控。

---

## Phase 4：7×24 Routines 定时与事件巡检 + 联调收尾

**目标**：打通“合上电脑后 Bot 依然自动工作、遇异常再找人”的 7×24 体验闭环。

### 任务清单
1. **数据库迁移 `0010_routines.sql`**
   - 新增 `routines` 表与 `routine_runs` 执行历史视图/索引。
2. **`RoutineScheduler` 实现**
   - 在 `server/src/core/routines/scheduler.ts` 实现 Cron 解析与 `FOR UPDATE SKIP LOCKED` 分布式防重触发器，集成进 `core-worker-main.ts`；
   - 触发后统一写入 `triggers(kind='routine')`，支持单次预算上限与「仅异常时通知 IM 群」静默策略；
   - 支持 Webhook / GitHub 仓库事件触发 Routine（如夜间主干提交后自动触发 QA 回归巡检）。
3. **Web Routines 看板**
   - 新增项目内 **Routines** 一级页面：创建/编辑 Cron 定时任务、绑定执行 Bot 与汇报 Room、一键「立即试跑」、开关启停、查看历史运行报告与耗时/Token。
4. **端到端演示与文档更新**
   - 升级 `pnpm demo`：一键启动包含 3 个预设产研 Bot（调研/研发/QA）、1 个协作 Room、1 条演示 Routine 和 1 条待审批卡片的完整 Grok Bot 体验演示；
   - 更新 `README.md`、`docs/ARCHITECTURE.md`、`docs/DEPLOYMENT.md`、`docker-compose.yml`（默认起 `core-worker` + 沙箱网络隔离配置）。

### 验收标准
- 定时 Routine 到点自动唤醒指定 Bot 在后台执行巡检，无异常时静默归档，发现异常或需对外动作时向 Web Inbox 与飞书/企微发审批卡片；全量 `pnpm check` 通过。
