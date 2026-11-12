# Superagent Platform（MVP）

服务端多项目 Agent 平台的 MVP 实现，按仓库根目录的 [`DEVELOPMENT_PLAN.md`](../DEVELOPMENT_PLAN.md) 开发。

> **项目组 = 一个 GitHub 仓库 + 一组成员 + 一套策略 + 一个绑定的 IM 群。**
> 成员在群里 @bot 提需求；Agent 在隔离工作区改代码、跑测试、开 PR；人在群里或 PR 里评审；平台记录全链路审计。

![项目概览](docs/screenshots/03-project-overview.png)

## 当前状态

- **可运行**：控制面 API、Web 控制台、Worker、飞书 / 企业微信适配、GitHub App 适配、PGlite/Postgres、DB/Redis 队列、Outbox 通知、Docker Compose 部署文件与文档均已实现。
- **开箱即用的是演示链路**：`pnpm demo` 使用 Mock GitHub + Fake Agent Runtime，在没有外部凭据的机器上跑通「工单 → 计划 → 执行 → PR → 合并关闭」。
- **接真实环境需要配置**：飞书应用、GitHub App、Postgres/Redis，以及实现了 DSH headless 调用约定的 `AGENT_COMMAND`（见 [部署文档](docs/DEPLOYMENT.md)）。
- 已知限制与和原方案的差异见 [STATUS.md](docs/STATUS.md)。

## 快速开始（无需外部凭据）

要求：Node.js ≥ 22.19，pnpm ≥ 10。

```bash
cd platform
pnpm install
pnpm build          # 构建 Web 控制台与服务端
pnpm demo           # 初始化演示数据、跑通一次工单，并在 :3100 启动
```

打开 <http://127.0.0.1:3100>，用**开发登录**输入昵称 `Alice`（Owner）或 `Bob`（Member）。

演示会：

1. 创建项目「演示项目」，绑定 Mock 仓库 `demo-org/hello-world` 和飞书群 `oc_demo_project`；
2. 生成一条邀请链接；
3. 创建一张工单，由 Worker 依次执行 **plan → execute**，在工作区产生真实文件改动，提交到 `agent/*` 分支并创建 Mock PR；
4. 把「计划已生成」「开始执行」「PR 已创建」推送到模拟飞书群（终端输出）。

> 想重新开始：停止 demo，删除 `platform/server/data` 后再次执行 `pnpm demo`。

开发模式（API 与 Vite 热更新分开跑）：

```bash
pnpm dev:api     # http://127.0.0.1:3000，PGlite 落盘到 server/data/pglite
pnpm dev:web     # http://127.0.0.1:5173，代理 /v1 与 /webhooks
pnpm dev:worker  # 可选：独立 Worker 进程
```

常用校验：

```bash
pnpm typecheck
pnpm test
pnpm check      # typecheck + test + build
```

## 能力总览

| 能力 | 实现 |
| --- | --- |
| 多项目 / 单仓库 | 项目绑定一个 GitHub 仓库；项目间数据按 `project_id` 隔离 |
| 成员与角色 | Owner / Maintainer / Member / Viewer；邀请二维码、角色变更、移除 |
| IM 接入 | 飞书（默认，含加密回调、验签、@bot 判定、线程回复）；企业微信 Adapter（验签/解密/发送，能力差异见文档） |
| @bot 接单 | 确定性 Mention Router：只处理 @bot、命令、已有工单线程回复；非 @ 普通消息忽略 |
| 命令 | `/status` `/cancel` `/retry` `/approve` `/bind` `/help` |
| 工单生命周期 | new → triaged → planned → running → waiting_review → done，失败/取消分支 |
| Agent 执行 | plan / execute 两阶段 Run，独立工作目录，超时、取消、失败重试一次 |
| GitHub | GitHub App installation token、分支推送、PR 创建、PR 合并/关闭、评论续跑、CI 状态回传 |
| 审批 | 计划审批（可配置强制）、PR 不自动合并、审批记录 |
| 通知 | Outbox 事务表 + 幂等发送 + 指数退避重试；无 IM 凭据时演示为模拟发送 |
| 审计 | 项目、成员、仓库、群、邀请、消息、工单、Run、审批、通知全链路 |
| 配额 | 每项目并发 Run 数、每日 Token 预算、单次运行超时、全局 Worker 并发 |
| 控制台 | 项目、工单详情、运行日志、成员、仓库、群、邀请二维码、策略、审计、用量 |
| 部署 | Dockerfile + Compose（api / worker / postgres / redis / caddy），HTTPS，健康检查 |

## 架构

```text
飞书 / 企业微信 ── webhook ──► Channel Gateway ─┐
GitHub ───────── webhook ──► GitHub Adapter ────┤
Web 控制台 ───── HTTPS ────► Console / API ─────┤
                                                ├─ Postgres（项目、工单、运行、审计）
                                                ├─ Redis / BullMQ（可选）或 DB 队列表
                                                └─ Worker 调度
                                                       │
                                                独立工作目录 + Agent Runtime（DSH headless）
                                                       │
                                                agent/* 分支 → PR
```

- **控制面不执行 shell**：API 只做鉴权、状态与调度。
- **每次 Run 独立工作目录**：按 `project_id/run_id` 创建，Run 结束清理；不跨项目复用。
- **DSH 只做 Agent Runtime**：通过 `AgentRuntime` 接口接入；演示环境使用 FakeRuntime。
- **GitHub 用 App 短期 token**：按任务下发 installation token，任务结束失效。
- **IM Adapter 统一接口**：`verifyAndParse` / `send`，飞书与企业微信各自封装协议差异。

```text
platform/
├── server/                     # Node.js 22 + TypeScript + Fastify + Drizzle
│   ├── src/
│   │   ├── app/                # Fastify 组装、路由
│   │   ├── services/           # 项目、邀请、工单、运行、编排、审计、Outbox、接入
│   │   ├── domain/             # 状态机、Mention Router、命令、端口接口
│   │   ├── db/                 # Drizzle schema 与迁移
│   │   ├── im/                 # 飞书 / 企业微信适配（验签、加解密、发送、OAuth）
│   │   ├── github/             # GitHub App 客户端与 webhook 验签
│   │   ├── runtime/            # Fake / 外部命令 Agent Runtime
│   │   ├── worker/             # 领取任务、克隆、执行、提交、开 PR
│   │   └── queue/              # DB 队列 / BullMQ
│   ├── drizzle/                # SQL 迁移
│   ├── public/                 # 构建后的 Web 控制台
│   └── tests/                  # Vitest：领域、适配器、API、端到端
├── web/                        # React 18 + Vite + TypeScript 控制台
├── docs/                       # 架构、API、部署、状态、UI 说明
├── deploy/                     # Agent Runtime wrapper 模板
├── Dockerfile / docker-compose.yml / Caddyfile / .env.example
└── scripts/ui-screenshots.mjs  # 视觉回归截图工具（Chrome CDP）
```

## 界面

| 登录 | 工单详情 |
| --- | --- |
| ![登录](docs/screenshots/01-login.png) | ![工单](docs/screenshots/05-ticket.png) |

| 邀请二维码 | 深色主题 |
| --- | --- |
| ![邀请](docs/screenshots/06b-invite-qr.png) | ![深色](docs/screenshots/08-project-dark.png) |

更多页面与设计说明见 [UI.md](docs/UI.md)。

## 文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：模块职责、数据模型、请求链路、状态机、Queue/Outbox、安全设计
- [API.md](docs/API.md)：REST API、Webhook、内部接口、鉴权与错误码
- [DEPLOYMENT.md](docs/DEPLOYMENT.md)：Docker Compose、飞书/GitHub App 配置、Agent Runtime 接入、备份与运维
- [STATUS.md](docs/STATUS.md)：FR / 验收标准逐条对照、测试映射、与方案的差异和已知限制
- [UI.md](docs/UI.md)：信息架构、设计令牌、页面状态与截图

## 安全边界

- 所有业务查询按 `project_id` 强制隔离；跨项目访问返回 404。
- 会话使用 HttpOnly Cookie；写请求校验 CSRF；Webhook 验签 + 事件 ID 幂等。
- GitHub 只允许推送 `agent/*` 分支，不自动合并，建议开启 branch protection。
- Agent 工作目录隔离；容器部署时 Worker 不挂载宿主目录、不暴露 Docker socket。
- 群消息、Issue、PR 评论全部按不可信输入处理；授权与成员校验在模型之外执行。

## License

与仓库根目录一致：[MIT](../LICENSE)。
