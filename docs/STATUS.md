# 实现状态与验收对照（双 Agent 核心）

核心已从“确定性路由 + plan/execute Runs”重写为 **Main Session / Executor Session 双 Agent**。旧的 `runs` / `run_events` 表和代码已删除（迁移 0004）。服务壳（项目、成员、邀请、IM、GitHub、控制台、Outbox、审计）复用。

测试：`pnpm test`，当前 **45 tests / 9 files**。

## 1. 功能需求

| 编号 | 需求 | 状态 | 实现 / 测试 |
| --- | --- | --- | --- |
| FR-01 | 项目 CRUD、暂停、归档、绑定仓库 | ✅ | `services/projects.ts`；`service.test.ts`；**无硬删除**，归档只读 |
| FR-02 | GitHub App 绑定、installation、选仓库 | ✅ | `github/client.ts`、`routes/repo.ts`；Mock 模式服务测试；真实 App 需凭据联调 |
| FR-03 | 成员、角色、邀请、移除 | ✅ 基本完成 | `services/projects.ts`、`invites.ts`；**无所有权转移** |
| FR-04 | 邀请二维码、签名 token、过期/次数 | ✅ | `services/invites.ts`；`service.test.ts`、`group-join.test.ts` |
| FR-05 | IM 群绑定、群内 `/bind`、扫码入群 | ✅ | `bindChannel`、dual intake、`services/group-join.ts`；飞书/企微自建群自动拉群，已有群二维码兜底 |
| FR-06 | @bot 接单、命令、线程回复 | ✅ | `services/intake.ts` → `dual/engine.receiveTrigger`；只处理成员 @bot；线程 Input 绕过 Eval |
| FR-07 | 工单生命周期 | ✅ | `tickets.stage`：queued/working/plan_review/idle/review/blocked/failed/answer/done/cancelled；`dual-core.test.ts`、`service.test.ts` |
| FR-08 | 队列、Worker、超时、重试、取消、日志 | ✅ | `session_turns`、`claimNextTurn`、`executeTurn`、`reapStaleTurns`、`turn_events`；测试覆盖失败重试与取消 |
| FR-09 | 分支、commit、PR、评论、CI | ✅（真实 API 待联调） | `dual/worker.ts` 交付 PR；`services/github-webhooks.ts`；Mock PR + merge/comment 路径 |
| FR-10 | 计划审批、人工合并 | ✅ 基本完成 | 计划是 Executor Turn 的门：`plan_review` → approval Input → 下一 Turn；不自动合并 |
| FR-11 | 接单/进度/PR/需人工/完成通知 | ✅ | `services/notifications.ts`、Outbox；服务测试校验 PR/done 通知 |
| FR-12 | 全链路审计 | ✅ | `audit_logs` + trigger/evaluation/mandate/turn/report；`service.test.ts` |
| FR-13 | 并发、每日 token、超时 | ✅ 基本完成 | Executor Turn 受 `maxConcurrentRuns`；入队检查每日预算；Turn 超时；无告警 |
| FR-14 | `/status` `/cancel` `/retry` `/approve` `/bind` `/help` | ✅ | `dual/engine.handleCommand`；权限/暂停规则；命令测试 |

## 2. 非功能需求

| 类别 | 要求 | 状态 | 说明 |
| --- | --- | --- | --- |
| 隔离 | project_id；每工单目录；不跨项目 | ✅ / 部分 | 应用层强制 + 测试；Worker 容器隔离；未实现“每 Turn 一个容器” |
| 安全 | 短期 GitHub token、密钥、不可信输入 | ✅ | installation token 只留在 Worker；Agent 进程不注入；验签/限流/CSRF；日志脱敏 |
| 性能 | 回执 <5s；30 分钟出 PR；队列可观测 | ✅ 设计满足 | Webhook 只入库+入队；Outbox 1s；Executor 速度取决于 Runtime；`/metrics` |
| 可用性 | Webhook/队列重试、备份 | ✅ / 部分 | 投递幂等、Turn 重试/回收、Outbox 退避；备份为文档操作 |
| 成本 | 预算、超时、全局并发 | ✅ | 预算入队检查、Turn 超时、Worker 并发 |
| 可观测 | trace、日志、指标、审计分离 | ✅ 基本完成 | pino + turn/project/ticket 绑定；`/metrics`；未接 OpenTelemetry |
| 合规 | 保留期、删除项目 | ⚠️ 部分 | 级联删除；**消息/审计定时清理未实现** |

## 3. 验收标准

| # | 标准 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 创建项目、绑定仓库/群、生成二维码 | ✅ | `service.test.ts` 认证/邀请流程 |
| 2 | 扫码登录加入项目，看到项目入口 | ✅ | 邀请接受 + 群入口响应；`group-join.test.ts` |
| 3 | @bot 5 秒内回执并生成 Ticket | ✅ | Webhook 只做确定性入库；Main Turn 异步执行；Outbox 1s |
| 4 | Executor 完成修改并开 PR，群里收到链接 | ✅ | `service.test.ts` console ticket → review；Feishu 测试 → review |
| 5 | 非成员/非 @/其他群不建单 | ✅ | dual-core、service Feishu 测试 |
| 6 | webhook 重放不重复建单 | ✅ | Feishu/WeCom/GitHub 三重去重测试 |
| 7 | 线程追问追加同一 Ticket | ✅ | dual-core、service Feishu 线程测试；无新 Eval |
| 8 | Maintainer 暂停、取消、重试、批准 | ✅ | service 审批/停止/失败重试测试 |
| 9 | PR 合并后 Ticket 关闭并通知 | ✅ | service GitHub merge webhook |
| 10 | 审计还原触发→决策→执行→PR→审批 | ✅ 基本完成 | audit + trigger/evaluation/mandate/report/turn |
| 11 | 项目 A 不能读项目 B | ✅ | service 项目隔离测试 |
| 12 | 容器不能读宿主密钥/未授权网络 | ⚠️ 部署约束 | Dockerfile 非 root、无宿主挂载/Docker socket；网络白名单需宿主策略 |

## 4. 测试清单

| 文件 | 覆盖 |
| --- | --- |
| `tests/dual-core.test.ts` | Main eval → Decision → Ticket/Mandate → Executor report；计划门；线程 Input/恢复；去重；停止/关闭 |
| `tests/service.test.ts` | API 认证/隔离/角色/邀请；工单 → Executor → PR → merge；审批/取消/失败重试；Feishu Eval/线程/命令；会话/报告 DTO |
| `tests/wecom-service.test.ts` | 企业微信加密回调 → Eval → Ticket；重放去重；`/status` |
| `tests/wecom.test.ts` | 企微加解密、验签、echostr、OAuth、群机器人/appchat 发送与拉人 |
| `tests/group-join.test.ts` | 项目群二维码/链接；飞书/企微自建群自动拉群；默认关闭与失败回落 |
| `tests/feishu.test.ts` | 飞书加解密、验签、URL 验证、发送、OAuth |
| `tests/intake.test.ts` | 命令解析与 Mention Router 纯函数 |
| `tests/github.test.ts` | GitHub webhook 签名、Mock App |
| `tests/db.test.ts` | 迁移与 schema |

## 5. 与原型 / 方案的差异

| 原型或方案 | 当前实现 | 原因 |
| --- | --- | --- |
| Main Session 有 14 个工具 | Main 每 Turn 返回 `decisions` JSON；命令是服务层确定性动作 | 收窄 MVP，协议可扩展成工具调用 |
| Executor 自己 push/PR | 平台 commit/push/PR | 仓库保护、最小权限、可审计 |
| 推断候选 / bot 名单 / admission | 只处理成员 @bot | `DEVELOPMENT_PLAN.md` 的 @ 版 |
| 多 PR、上下文订阅、subagent、后台 job | 未实现 | 后续里程碑 |
| DSH 原生 Session | `TurnRuntime` + transcript + `result.json`；DSH 由命令包装器接入 | 服务可替换 Runtime、便于多项目 |
| 每 Run 一个容器 | 每工单持久目录 + Worker 容器 | 单机 Compose 简化 |

## 6. 已知限制

1. **真实 DSH/GitHub/IM 未在本机联调**：使用 Fake Runtime、Mock GitHub 与合成加密报文验证协议；真实凭据需按部署文档配置。
2. **企业微信无原生线程**：每条消息独立，追问不会自动追加；用 `/status` 等命令或控制台。@bot 依赖文本 `@WECOM_BOT_NAME`。
3. **企业微信自动拉群仅 `appchat` 自建群**；已有群只能二维码/链接。
4. **无自动建群**：邀请是项目邀请；群由团队创建后绑定。
5. **单 PR、无上下文订阅**：PR 评论会作为 Input 续跑，但未跟踪多 PR 或 context follow。
6. **数据保留清理、RLS、MinIO、OTel 告警未实现**。
7. **所有权转移缺失**。
8. **内联 Worker 仅开发环境**：生产必须独立 Worker；`INLINE_WORKER` 在 production 会拒绝启动。
9. **Docker 未在本机执行**：Compose/Dockerfile 提供但需首次部署验证。
10. **控制台轮询**：工单活跃时 5 秒拉取，无 WebSocket。

## 7. 后续里程碑

- **M0 真实联调**：飞书/企微回调、GitHub App、DSH headless；
- **M1 补齐内核**：拒绝审批、多 PR 跟踪、context 订阅、Policy 重校验、prompt 版本；
- **M2 产品化**：所有权转移、保留期清理、RLS、MinIO、OTel、告警；
- **M3 扩展**：智能机器人、推断候选/LLM Router、每 Turn 容器化。
