# API 参考（双 Agent）

Base URL：`PUBLIC_BASE_URL`。控制台使用 HttpOnly `sa_session` Cookie；写请求需要 `x-superagent-csrf: 1` 或同源 Origin。Webhook 使用平台签名；内部接口使用 `Authorization: Bearer <INTERNAL_TOKEN>`。

错误：

```json
{ "error": { "code": "forbidden", "message": "…", "details": [] } }
```

`code`：`bad_request` `unauthorized` `forbidden` `not_found` `conflict` `rate_limited` `internal`。

## 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/session` | 当前用户、app 名称、OAuth/开发登录开关 |
| POST | `/v1/auth/dev-login` | `{ name, externalId? }`，仅 `AUTH_DEV_LOGIN=true` |
| POST | `/v1/auth/logout` | 删除会话 |
| GET | `/v1/auth/:provider/start?returnTo=` | 302 到飞书/企微授权页 |
| GET | `/v1/auth/:provider/callback` | OAuth 回调，建立会话 |

## 项目与成员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/v1/projects` | 列表/创建 |
| GET/PATCH | `/v1/projects/:id` | 详情/更新（policy 变更会写入 policy Input） |
| GET | `/v1/projects/:id/overview` | 工单与 Turn 统计、最近工单、活跃 Turn |
| GET | `/v1/projects/:id/main-session` | Main Session 信息、transcript、最近的 eval Turns |
| GET/POST | `/v1/projects/:id/members` | 成员列表/添加 |
| PATCH/DELETE | `/v1/projects/:id/members/:userId` | 改角色/移除 |
| GET | `/v1/users?q=` | 搜索共享项目的用户 |

`PATCH /v1/projects/:id` 的 `status`：Owner 可 `draft→active`、归档；Owner/Maintainer 可 `active↔paused`。启用前必须有仓库和 active 群。

## 仓库与 IM 群

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/DELETE | `/v1/projects/:id/repo` | 仓库绑定 |
| GET | `/v1/projects/:id/repo/candidates` | GitHub App 已授权仓库 |
| GET | `/v1/github/install/start` / `/v1/github/install/callback` | GitHub App 安装 |
| GET/POST | `/v1/projects/:id/channels` | 群绑定，`config` 支持 `joinUrl`、`qrDataUrl`、`autoJoin`、`managed`、WeCom `webhookUrl` |
| DELETE | `/v1/projects/:id/channels/:channelId` | 停用群 |

### 企业微信扫码入群（真实 appchat）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/projects/:id/wecom-group` | Owner | 要求已绑定仓库；用当前 Owner 的企业微信 userid 通过 `appchat/create` 建应用群，绑定为项目群并自动激活项目；返回 `{ project, channel, group, join }` |
| GET | `/v1/projects/:id/join-link` | Maintainer+ | 已绑定应用群时返回 `{ channel, join }`；`join` 为签名二维码（90 天），否则 `{ join: null, reason }` |
| GET | `/v1/join/:token` | 公开 | 预览入群二维码：项目、群、有效期 |
| POST | `/v1/join/:token/accept` | 登录 | 加入项目（member），并调用 `appchat/update` 把当前企业微信 userid 加入应用群；返回 `{ projectId, role, alreadyMember, group }` |

- 二维码是**平台签名链接**，不是企业微信原生群二维码；企业微信没有为普通内部群生成入群二维码的 API。
- 只有 `appchat/create` 创建的**应用群**支持 API 拉人；绑定已有群时 `join` 为 null，需解绑后创建应用群，或继续用群二维码/邀请链接。
- 扫码者必须通过企业微信 OAuth 登录，且在企业微信应用可见范围内，否则只能加入项目、无法自动进群。
- 应用群创建时会把项目内已有企业微信身份成员一并拉入；Owner 必须已有企业微信身份。
- 群内 @ 机器人需要另外配置企业微信「智能机器人」长连接（`WECOM_BOT_ID`/`WECOM_BOT_SECRET`），并由群主把机器人加入应用群一次；appchat 只能发送，不能接收群消息。智能机器人回调的 `from.userid` 可能是加密 ID，若与 OAuth 的明文 userid 不一致，需要额外的身份映射（当前未实现，见 STATUS 已知限制）。

## 邀请与入群

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/invites/:token` | 预览；返回 `group`（joinUrl/qrDataUrl/autoJoin） |
| POST | `/v1/invites/:token/accept` | 加入项目；响应含 `group`：`{ group, joined, error? }` |
| GET/POST | `/v1/projects/:id/invites` | 邀请记录/生成二维码 |
| DELETE | `/v1/projects/:id/invites/:inviteId` | 撤销 |

自动拉群只在适配器实现 `addMembers` 时执行：飞书需 `im:chat.members:write_only` 且是群管理员；企业微信仅 `appchat` 自建群。失败时 `joined=false`，客户端展示群二维码/链接。

## 工单

### `GET /v1/projects/:id/tickets?status=&stage=&q=&limit=&offset=`

返回 `{ items, total, limit, offset }`。`stage` 是双 Agent 阶段的过滤条件（`queued` `working` `plan_review` `idle` `review` `blocked` `failed` `answer` `done` `cancelled`）。

### `POST /v1/projects/:id/tickets`

```json
{ "title": "可选", "body": "需求正文", "priority": "normal", "channelId": "可选" }
```

- Member+；项目必须 `active`。
- 直接创建已授权工单（Mandate `explicit`）+ Executor Turn，不经过 Main Session Eval；群内 @bot 才走 Eval。
- 返回 `201 { ticket, turnId?, warning? }`。`warning` 表示未入队（预算等原因）。

### `GET /v1/projects/:id/tickets/:ticketId`

返回：

```json
{
  "ticket": { "stage": "review", "status": "waiting_review", "prUrl": "…" },
  "runs": [ { "id": "turn id", "kind": "execute", "turnKind": "execute", "status": "succeeded" } ],
  "turns": [ "…" ],
  "mandate": { "strength": "explicit", "policyVersion": "…", "scope": "…" },
  "session": { "id": "executor session", "status": "idle", "model": "…" },
  "transcript": [ { "role": "user", "content": "…" } ],
  "reports": [ { "status": "ready", "summary": "…", "plan": "…" } ],
  "inputs": [ { "source": "person", "text": "…", "deliveredAt": "…" } ],
  "assignments": [ "…" ],
  "subscriptions": [ "…" ],
  "approvals": [ "…" ],
  "messages": [ "…" ]
}
```

`runs` 是兼容旧控制台的 Turn 投影。

### 动作

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/v1/tickets/:id/approve` | Maintainer+ | 仅 `plan_review`；写 approval Input 并排队下一 Turn |
| POST | `/v1/tickets/:id/cancel` | Maintainer+ | 撤销 Mandate、取消 queued Turn、请求停止 running Turn |
| POST | `/v1/tickets/:id/retry` | Maintainer+ | 仅 `failed`/`blocked`；重新排队 |
| GET | `/v1/tickets/:id` | Viewer+ | 工单详情 |
| GET | `/v1/tickets?projectId=` | Viewer+ | 项目工单 |

等价的项目级路径：`/v1/projects/:id/tickets/:ticketId/{approve,cancel,retry}`。

## Turn / 运行

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/runs/:id` | 一个 Session Turn：`{ run, events }`；`run.turnKind` 为 `eval`/`execute`/`resume` |
| GET | `/v1/runs/:id/events?limit=` | `turn_events` 列表 |

`run.status`：`queued` `running` `succeeded` `failed` `cancelled` `timeout`。

## 审计与用量

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/audit` | Maintainer+ | Trigger、Decision、Ticket、Turn、Report、Approval、PR |
| GET | `/v1/projects/:id/usage?days=30` | Viewer+ | Token/成本/每日 runs；Executor Turn 计入 |

## Webhook

| 路径 | 说明 |
| --- | --- |
| `POST /webhooks/feishu` | 验签/解密；`url_verification` 返回 challenge；消息入库 Trigger + 可选的 Eval/Input |
| `GET/POST /webhooks/wecom` | 企微 URL 验证/加密消息；同样进入 Trigger |
| `POST /webhooks/github` | 校验 `X-Hub-Signature-256`；PR 合并/关闭；评论转 Ticket Input；CI 通知 |

**重要**：Webhook 返回 200 只代表 Trigger/Input 已入队，不代表 Ticket 已创建。Ticket 由 Main Session 的 Eval Turn 异步创建；调用方应通过控制台或 API 查询结果。

Feishu `url_verification` 未签名但必须 token 正确；加密事件必须签名。

GitHub 事件：

- `pull_request closed+merged` → ticket `done`；
- `pull_request closed` 未合并 → `cancelled`；
- `issue_comment` / `pull_request_review_comment` → 记录消息并创建 Input（下一条 Executor Turn）；
- `check_suite` / `check_run` → CI 通知；
- 其他忽略。

## 内部接口

```http
POST /internal/runs/:id/events
Authorization: Bearer <INTERNAL_TOKEN>
Content-Type: application/json

{ "type": "log", "message": "…", "payload": {} }
```

写入 `turn_events`；`POST /internal/runs/:id/heartbeat` 刷新 `heartbeat_at`。供外部 Worker/Runtime 包装器使用。

## 健康检查

`GET /healthz` 存活；`GET /readyz` 数据库；`GET /metrics` Prometheus 文本（Executor Turn 状态映射为 `superagent_runs_total`、工单、Outbox pending、`superagent_up`）。

## 示例

```bash
BASE=http://127.0.0.1:3100
COOKIE=$(curl -si -X POST "$BASE/v1/auth/dev-login" -H 'content-type: application/json' \
  -d '{"name":"Alice"}' | grep -i '^set-cookie:' | sed 's/^[^:]*: //; s/;.*//')

curl -s "$BASE/v1/projects" -H "cookie: $COOKIE"
curl -s -X POST "$BASE/v1/projects/<id>/tickets" \
  -H "cookie: $COOKIE" -H 'x-superagent-csrf: 1' -H 'content-type: application/json' \
  -d '{"title":"示例","body":"新增欢迎页"}'
```
