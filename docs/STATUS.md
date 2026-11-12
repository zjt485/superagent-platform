# 实现状态与验收对照

对照 [`DEVELOPMENT_PLAN.md`](../../DEVELOPMENT_PLAN.md) 的 FR、非功能要求与验收标准。测试用 `pnpm test` 运行（Vitest，PGlite 内存库）。

## 1. 功能需求

| 编号 | 需求 | 状态 | 实现 / 测试 |
| --- | --- | --- | --- |
| FR-01 | 项目 CRUD、暂停、归档、绑定仓库 | ✅ 基本完成 | `services/projects.ts`；`app/routes/projects.ts`；e2e「authenticates, isolates projects…」。**未提供硬删除**，归档即只读保留 |
| FR-02 | GitHub App 绑定、选择仓库、installation | ✅ | `github/client.ts`、`routes/repo.ts`；Mock 模式 e2e 覆盖；真实 App 客户端需凭据联调 |
| FR-03 | 成员与角色、邀请、移除、改角色 | ✅ 基本完成 | `services/projects.ts`、`invites.ts`；e2e 邀请加入。**未做所有权转移接口**，Owner 不能直接授予 |
| FR-04 | 邀请二维码、签名 token、过期、次数 | ✅ | `services/invites.ts`（SHA-256 存储、原子扣减、qrcode data URL）；e2e 预览与接受 |
| FR-05 | IM 群绑定，控制台 + 群内 `/bind`；扫码入群 | ✅ | `bindChannel`、`tryBindUnboundChat`；`services/group-join.ts` 提供群二维码/邀请链接，飞书与企微自建群可自动拉群；`tests/group-join.test.ts`、`tests/wecom-intake.test.ts` |
| FR-06 | @bot 接单、命令、工单线程回复 | ✅ | `domain/intake.ts`、`services/intake.ts`；`tests/intake.test.ts`；Feishu e2e 覆盖忽略/去重/线程 |
| FR-07 | 工单生命周期 | ✅ | `services/tickets.ts` 状态机；e2e 审批/取消/重试 |
| FR-08 | Run 队列、Worker、超时、重试、取消、日志 | ✅ | `services/runs.ts`、`worker/pipeline.ts`、`orchestrator.ts`；reaper 实现心跳超时；e2e 跑通 plan/execute |
| FR-09 | 分支、commit、PR、评论、CI 回传 | ✅（真实 API 待联调） | `worker/pipeline.ts`、`github/client.ts`、`services/github-webhooks.ts`；Mock PR + 合并 webhook 测试 |
| FR-10 | 计划审批、PR 合并前人工确认、不自动合并 | ✅ 基本完成 | `approvals` 表、`approvePlanAndExecute`；合并由 GitHub 人工完成，平台只记录事件。**无独立“合并审批”按钮** |
| FR-11 | 接单/进度/PR/需人工/完成通知，失败原因 | ✅ | `services/notifications.ts`、outbox；e2e 校验 PR 通知与模拟发送 |
| FR-12 | 消息、工单、运行、审批、PR 全链路审计 | ✅ | `services/audit.ts`；e2e/审计列表可查。操作细节在 `audit_logs.metadata` |
| FR-13 | 每项目并发、每日 token、单次时长、全局并发 | ✅ 基本完成 | `claimNextRun`、`ensureBudget`、`maxRunMinutes`、`WORKER_CONCURRENCY`。**无用量告警** |
| FR-14 | `/status` `/cancel` `/retry` `/approve` `/bind` `/help` | ✅ | `domain/intake.ts`、`services/intake.ts`；命令权限单测；状态命令 e2e |

## 2. 非功能需求

| 类别 | 要求 | 状态 | 说明 |
| --- | --- | --- | --- |
| 隔离 | 项目数据按 project_id；Run 独立目录/容器；禁止跨项目挂载 | ✅ / 部分 | 应用层强制 project_id，e2e 覆盖跨项目 404；每次 Run 独立目录并清理；容器部署由 Worker 容器承担，未实现“每 Run 一个容器”的 Docker 编排 |
| 安全 | 短期 GitHub token、密钥进 Secret、聊天不可信 | ✅ | installation token 按任务获取；Webhook 验签；prompt 规则；日志脱敏。密钥由环境变量/部署 Secret 管理 |
| 性能 | 回执 P95 <5s；30 分钟出 PR；队列可观测 | ✅ 设计满足 | Webhook 只做确定性判断 + 入队，Outbox 1s 轮询；Worker 速度取决于 Runtime；`/metrics` 暴露队列/状态计数 |
| 可用性 | 单机、Webhook 重试、队列重试、Postgres 备份 | ✅ / 部分 | 事件幂等、Outbox 退避、Run 心跳回收；备份为文档化操作，未内置定时任务 |
| 成本 | 每日 token 预算、单 Run 超时、全局并发 | ✅ | 入队前预算检查；Run 超时；Worker 并发 |
| 可观测 | trace id、日志/指标/审计分离、不记密钥 | ✅ 基本完成 | pino 结构化日志 + run/ticket id；`/metrics`；审计表。**未接 OpenTelemetry** |
| 合规 | 群内说明、保留期、删除项目数据 | ⚠️ 部分 | 文档说明读取范围；级联删除实现；**保留期清理任务未实现** |

## 3. 验收标准

| # | 标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Owner 创建项目、绑定仓库和群、生成二维码 | ✅ | `tests/e2e.test.ts`「authenticates…」；UI 邀请页截图 |
| 2 | 新成员扫码登录后加入项目，能看到项目入口 | ✅ | 邀请接受 e2e；`/invite/:token` 页面；接受后展示项目群二维码/链接，或在飞书权限满足时自动拉群（`group-join` 测试） |
| 3 | 成员 @bot，5 秒内收到回执并生成 Ticket | ✅ | Feishu intake e2e；Webhook 同步建单 + Outbox 1s 发送 |
| 4 | Worker 完成修改并开 PR，群里收到链接 | ✅ | e2e「runs a console ticket…」；FakeRuntime/FakeGit/Mock GitHub 全链路 |
| 5 | 非成员、非 @、其他群消息不建单 | ✅ | `tests/intake.test.ts`；Feishu e2e 的 ignored/非成员断言 |
| 6 | 同一 webhook 重放不重复建单 | ✅ | Feishu event 重放 + 消息级去重；GitHub delivery 去重 |
| 7 | 工单线程追问追加同一 Ticket | ✅ | Feishu e2e thread reply（无 @） |
| 8 | Maintainer 暂停、取消、重试、批准 | ✅ | 审批/取消/重试 e2e；暂停/恢复对 Maintainer 开放（`updateProject`） |
| 9 | PR 合并后 Ticket 关闭并通知群 | ✅ | GitHub merge webhook e2e |
| 10 | 审计还原“谁在哪个群提了什么、Agent 做了什么、谁批准” | ✅ 基本完成 | `audit_logs` + `intake_events` + `messages` + `approvals`；审计 API 限 Maintainer+ |
| 11 | 项目 A 无法读取项目 B 数据 | ✅ | e2e 跨项目 404 + 项目列表只含本人项目 |
| 12 | 容器内不能读宿主密钥/未授权网络 | ⚠️ 部署约束 | Dockerfile 非 root、无宿主挂载、无 Docker socket；网络白名单需在宿主/网络策略实现 |

## 4. 测试清单

当前共 **43** 个用例（9 个文件）。

| 文件 | 覆盖 |
| --- | --- |
| `tests/intake.test.ts` | 命令解析、Mention Router 优先级、线程免 @、暂停、角色、@ 占位符 |
| `tests/feishu.test.ts` | AES 加解密、URL 验证、签名拒绝、加密事件归一化、发送与 token 缓存 |
| `tests/wecom.test.ts` | 32 字节 padding 加解密、签名、GET echostr、加密群消息、群机器人发送 |
| `tests/github.test.ts` | HMAC 签名校验、Mock installation/PR |
| `tests/db.test.ts` | 迁移与 Drizzle schema 往返 |
| `tests/e2e.test.ts` | 登录/CSRF/角色/邀请/项目隔离；计划→执行→PR→合并；审批/取消/重试；飞书去重、线程、忽略、暂停、`/bind` |
| `tests/lifecycle.test.ts` | 心跳超时回收、PR 评论触发新执行、每日 Token 预算拒绝入队 |
| `tests/group-join.test.ts` | 群二维码/邀请链接、飞书/企微自建群自动拉群、默认关闭与失败回落 |
| `tests/wecom-intake.test.ts` | 企微加密回调建单、消息去重、非成员/非 @ 忽略、`/status` 命令 |

运行：

```bash
cd platform && pnpm test
```

## 5. 有意简化与已知限制

1. **演示默认 FakeRuntime + Mock GitHub**：真实 Agent 与 GitHub 需要按 [DEPLOYMENT.md](DEPLOYMENT.md) 配置；接口和测试已隔离在这两个端口后面。
2. **计划审批为二值**：只能批准或取消，没有“拒绝并附意见”的独立动作；PR 合并审批在 GitHub 侧完成。
3. **企业微信无原生线程**：每条消息按独立 thread 处理，追问不会自动追加到既有工单；使用 `/status`、`/approve` 等命令，或从控制台操作。@bot 用文本匹配 `@WECOM_BOT_NAME`。
4. **企业微信自动拉群仅限 appchat 自建群**：已有群不支持 API 加人，仍走群二维码/邀请链接。飞书自动拉群需群管理员与成员权限。
5. **无自动建群**：邀请二维码是“项目邀请”，群由团队预先创建后绑定；入群优先自动拉人，否则扫码/点链接入群（方案 §4.2 的兜底路径）。
6. **数据保留清理未实现**：消息 90 天、审计 1 年的清理应作为定时任务补充；当前只提供级联删除。
7. **RLS 未启用**：租户隔离由应用层强制并测试；可选 Postgres RLS 未实现。
8. **无对象存储/MinIO**：Run 日志存 `run_events`，`logs_url` 预留但未上传。
9. **无 OpenTelemetry / 告警**：有结构化日志与 Prometheus 文本指标；告警规则未提供。
10. **所有权转移缺失**：不能把 Owner 转给他人；可添加新 Owner 需扩展接口（当前明确禁止直接授予）。
11. **Docker 镜像未在本机验证**：开发环境没有 Docker；Dockerfile/Compose 已按标准多阶段构建编写，首次部署需按第 10 节排查。
12. **Web 控制台轮询**：工单详情在活跃状态每 5 秒拉取，没有 WebSocket 推送。
13. **单 IM 平台每项目**：数据模型与 UI 都按“一个主群”设计。

## 6. 后续里程碑建议

- **M0 真实联调**：飞书回调 / 企业微信回调、GitHub App 安装、DSH headless 容器跑通；
- **M1 补强**：所有权转移、审批拒绝、保留期清理任务、RLS、MinIO 日志归档；
- **M2 可观测**：OpenTelemetry trace（message → ticket → run → PR）、Grafana 面板、告警；
- **M3 扩展**：企业微信智能机器人、无 @ LLM Router（保留 `intake_events` 作为升级基础）、每 Run 容器化。

## 7. 与方案的关键差异

| 方案 | 实现 | 原因 |
| --- | --- | --- |
| Redis + BullMQ 为唯一队列 | DB 队列表为默认，Redis/BullMQ 可选 | 单机 MVP 降低依赖；接口兼容，生产可切 |
| 每 Run 一个隔离容器 | 每次 Run 独立目录；Worker 容器隔离 | 单机 Compose 简化；`AgentRuntime` 接口可替换为容器 Runtime |
| Agent 直接开 PR | Agent 只改工作区，平台负责 commit/push/PR | 分支与 PR 策略不能交给模型 |
| 模型做 Triage/计划生成 | plan Run 由 Agent 生成计划；`planApproval` 可强制 | 与方案一致；Mock Runtime 用确定性计划 |
| 计划审批 + 合并审批 | 计划审批完整；合并审批由 GitHub 人工合并事件体现 | 不自动合并是硬约束 |
