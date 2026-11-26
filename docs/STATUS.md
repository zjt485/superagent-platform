# 实现状态与验收对照（Grok Bot 多 Bot 产研平台）

系统已完成从旧版双栈（`dual/` + `core/`）到**统一 Core 引擎 + 多角色产研数字员工平台**的全面升级（Phase 0 ~ Phase 4 全部完成）。

## 1. 阶段完成总览

| 阶段 | 核心交付 | 状态 | 关键实现与测试 |
| --- | --- | --- | --- |
| **Phase 0：内核收敛与生产护栏** | 删除 `server/src/dual/`，统一收敛到 `server/src/core/`；修复 Router ID 解析、LLM 路由记账、动态无仓/本地仓工作区、企微无线程命令回落；补齐并发上限、每日预算、心跳/取消监控、Stale Turn Reaper 与零门槛激活 | ✅ 已完成 | `core/worker/dispatcher.ts`、`reaper.ts`、`workspace-provider.ts`；`tests/core/phase0-guards.test.ts` |
| **Phase 1：Bot Roster + Rooms + Handoff + SSE** | `bots`/`rooms`/`room_bots`/`room_messages` 表与迁移（0007）；4 角色产研模板（`@researcher/@pm/@engineer/@qa`）；Web 协作房间三栏界面与 SSE 实时围观；显式 `handoff` 工具（`maxHops` + 防自交接）；IM 双向同步与 `[Bot名 · 角色]` 签名 | ✅ 已完成 | `services/bots.ts`、`services/rooms.ts`、`services/events.ts`、`web/src/pages/project/RoomsTab.tsx`、`RosterTab.tsx`；`tests/core/phase1-bots-rooms-handoff.test.ts` |
| **Phase 2：工具级审批 + Checkpoint 续跑 + 飞书卡片** | `action_approvals` 表与 `waiting_approval` 阶段（0008）；`evaluateToolPolicy` 三级策略门控；命中 `confirm` 持久化 `checkpoint` 释放 Worker，审批后 `kind='resume'` 续跑；Web 审批收件箱与飞书交互卡片（`/webhooks/feishu/card`） | ✅ 已完成 | `core/agent/gate.ts`、`services/approvals.ts`、`im/feishu.ts`、`web/src/pages/project/InboxTab.tsx`；`tests/core/phase2-approvals.test.ts` |
| **Phase 3：持久沙箱 + 浏览器截图 + MCP 连接器** | `mcp_servers`/`artifacts` 表（0009）；`LocalProcessSandboxProvider` & `DockerSandboxProvider`（`deploy/bot-sandbox.Dockerfile`）+ `terminal_chunk` 流式事件；`BrowserToolRunner` 与鉴权产物下载接口；`McpClient`（Streamable HTTP/SSE/Stdio）与工具发现；Web Connectors 面板 | ✅ 已完成 | `core/sandbox/*`、`core/mcp/client.ts`、`services/connectors.ts`、`web/src/pages/project/ConnectorsTab.tsx`；`tests/core/phase3-sandbox-browser-mcp.test.ts` |
| **Phase 4：7×24 Routines + Demo 与部署升级** | `routines` 表（0010）；零依赖 5 段 Cron 解析与时区调度；`tickRoutines`（`FOR UPDATE SKIP LOCKED`）与 `repo_event` Webhook 触发；「无事不扰」静默归档策略；Web Routines 管理与立即试跑；Demo / Compose / 文档全量升级 | ✅ 已完成 | `core/routines/cron.ts`、`scheduler.ts`、`services/routines.ts`、`web/src/pages/project/RoutinesTab.tsx`；`tests/core/phase4-routines.test.ts` |

## 2. 安全边界与治理

- **多租户隔离**：所有 API、Room、审批单、MCP 服务器、Artifacts 与 Routines 均按 `project_id` 强制鉴权隔离。
- **Suggest, don't send**：高风险内置工具与外部 MCP 写入/外发工具默认进入人工审批队列（Web 审批收件箱 + 飞书交互卡片），只读工具自动放行。
- **代码仓库保护**：Executor 禁止执行 `git push`、`gh pr` 或修改 remote；分支推送与 PR 创建全部由平台交付层统一完成，永不自动合并。
- **沙箱隔离**：Docker 模式为每个 Bot 分配独立持久容器与 `/home/bot` 卷，默认启用 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 与内存/CPU 限额。

## 3. V2 预留扩展点

- **noVNC 桌面实时接管**：`SandboxProvider.getVncSession()` 接口已在 V1 预留。
- **跨会话长期 Memory 与 Skills 技能市场**：将在 V2 结合向量检索与可复用 Skill 包实现。
- **每 Bot 独立 IM 凭据**：`bots.im_binding` JSONB 字段已落库，支持平滑从单机器人签名模式升级到独立应用机器人。
