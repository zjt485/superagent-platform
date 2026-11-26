# Superagent Platform — 多角色产研数字员工平台

基于 DeepSeek Superagent 架构演进的 **Grok Bot 风格多 Bot 产研数字员工平台**：让多个可配置的 AI 数字员工（研究员、产品经理、全栈工程师、QA 测试）像真实同事一样入驻 Web 协作房间与飞书 / 企业微信群聊，在每 Bot 持久沙箱内执行任务、接力协作、受「Suggest, don't send」工具级审批保护，并支持 7×24 定时与事件巡检。

![项目概览](docs/screenshots/03-project-overview.png)

## 核心特性

- **统一内核（`server/src/core/`）**：收敛为单一的 Router → Ticket/Mandate → Executor Turn → Delivery 内核，支持 `AGENT_RUNTIME=openai` 直连任意 OpenAI-compatible 模型（DeepSeek / OpenAI / vLLM），以及外部 `command` 和本地 `fake` 运行时。
- **零门槛建项**：代码仓库（GitHub App / 本地 Git）与 IM 群均作为可选连接器；新建项目立即激活，无需先绑仓即可在 Web 房间里启动多 Bot 协作。
- **Bot 团队（Roster）与一键盘点模板**：支持每项目创建多个独立人设、模型、工具权限与沙箱配置的 Bot；一键导入 4 角色产研模板（`@researcher`、`@pm`、`@engineer`、`@qa`）。
- **协作房间（Rooms）+ 实时围观（SSE）+ 多 Bot 接力（Handoff）**：三栏协作界面（房间列表 + 聊天流 + SSE 实时围观面板），支持群聊、与单个 Bot 私聊（DM）、双向同步飞书/企微群消息，以及受 `maxHops`、防自交接和预算熔断保护的显式 `handoff` 接力。
- **工具级审批（Suggest, don't send）+ 飞书交互卡片**：支持工具级 `allow` / `confirm` / `deny` 策略；命中 `confirm` 时自动暂停 Turn 并落库 `checkpoint`，向 Web 审批收件箱与飞书交互卡片（`/webhooks/feishu/card`）推送预览，审批后从断点续跑。
- **每 Bot 持久沙箱 + 浏览器截图 + MCP 连接器**：提供 `LocalProcessSandboxProvider` 与 `DockerSandboxProvider`（`deploy/bot-sandbox.Dockerfile`），内置 `browser_open/click/type/extract/screenshot` 工具（自动归档产物并推送 SSE 截图预览），以及支持 `Streamable HTTP / SSE / Stdio` 的 MCP 客户端与工具发现。
- **7×24 定时与事件巡检（Routines）**：支持标准 5 段 Cron 定时巡检与 GitHub `push`/`pull_request` 事件触发，内置「无事不扰（quiet-when-clean）」静默归档策略与 Web「立即试跑」。

## 快速开始（无需外部凭据）

要求：Node.js ≥ 22，pnpm ≥ 10。

```bash
pnpm install
pnpm build          # 构建 Web 控制台与服务端
pnpm demo           # 初始化 4 角色产研团队、示例工单与 QA 巡检，并在 :3100 启动
```

打开 <http://127.0.0.1:3100>，使用**开发登录**输入昵称 `Alice`（Owner）或 `Bob`（Member）即可体验：

1. **协作房间**：查看 4 个数字员工入驻的项目主群、`@bot` 点名委派与右侧 SSE 实时围观面板；
2. **Bot 团队**：编辑人设、工具审批策略或发起 1v1 私聊；
3. **审批收件箱**：审批或打回高风险工具调用并从断点续跑；
4. **定时巡检**：查看默认创建的「每日 09:00 QA 回归与依赖巡检」并一键试跑；
5. **连接器**：绑定本地 Git 仓库 / GitHub App，接入外部 MCP 服务器并一键发现工具。

开发模式：

```bash
pnpm dev:api        # http://127.0.0.1:3000（PGlite 落盘到 server/data/pglite）
pnpm dev:web        # http://127.0.0.1:5173（代理 /v1 与 /webhooks）
pnpm dev:worker     # 独立核心 Worker（Router + Executor + Routines）
```

校验与测试：

```bash
pnpm typecheck
pnpm test
pnpm check          # typecheck + test + build
```

## 系统架构

```text
Web Rooms / 飞书(含交互卡片) / 企微 / GitHub / 7×24 Routines
                           │
                           ▼
             triggers (message / handoff / routine / resume)
                           │
                           ▼
            Core Router (Rule / LLM, 含 @slug 路由与成本记账)
                           │
                           ▼
          Ticket + Mandate + Executor Session Turn (带心跳/预算/并发上限)
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  Bot 持久沙箱       Browser & 产物       MCP 连接器
 (Local/Docker)     (Playwright/SVG)   (HTTP/SSE/Stdio)
        └──────────────────┼──────────────────┘
                           ▼
          Tool Gate (allow / confirm→Checkpoint / deny)
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
   Web SSE / 审批收件箱           Outbox → 飞书卡片 / 企微 / GitHub PR
```

## 目录结构

```text
superagent-platform/
├── server/
│   ├── src/
│   │   ├── app/                # Fastify 组装与路由（bots/rooms/approvals/connectors/routines/webhooks）
│   │   ├── core/               # 统一核心：agent(openai/gate)、router、worker、sandbox、mcp、routines
│   │   ├── services/           # 业务服务层（项目、成员、邀请、Bot、Room、审批、连接器、巡检、Outbox）
│   │   ├── db/                 # Drizzle schema 与 SQL 迁移（0000 ~ 0010）
│   │   ├── im/                 # 飞书（含交互卡片）与企业微信适配
│   │   └── github/             # GitHub App 客户端与 Webhook 验签
│   ├── drizzle/                # PostgreSQL / PGlite 迁移文件
│   └── tests/                  # Vitest 单元与端到端集成测试
├── web/                        # React 18 + Vite + TypeScript 工作台
├── deploy/                     # bot-sandbox.Dockerfile 与运行时包装模板
├── docs/                       # 设计文档、实施计划、架构、API 与部署指南
└── docker-compose.yml          # api + core-worker + postgres + redis + caddy
```

## 文档

- [架构设计文档](docs/superpowers/specs/2026-11-26-grok-bot-architecture-design.md)
- [分阶段实施计划](docs/superpowers/plans/2026-11-26-grok-bot-implementation-plan.md)
- [实现状态与验收对照](docs/STATUS.md)
- [API 文档](docs/API.md) · [部署文档](docs/DEPLOYMENT.md) · [内核说明](docs/CORE.md)

## License

[MIT](LICENSE)。
