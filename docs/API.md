# API 参考

Base URL：`PUBLIC_BASE_URL`（本地默认 `http://localhost:3000`；`pnpm demo` 为 `http://127.0.0.1:3100`）。

所有响应为 JSON，除特殊标注外均以 `{ ... }` 直接返回数据。错误统一为：

```json
{ "error": { "code": "forbidden", "message": "没有权限执行该操作", "details": [] } }
```

错误码：`bad_request` `unauthorized` `forbidden` `not_found` `conflict` `rate_limited` `internal`。

## 鉴权

- 控制台使用 **HttpOnly session cookie** `sa_session`，由开发登录或飞书/企业微信 OAuth 创建。
- 写请求（POST/PATCH/DELETE）在携带 session 时必须同时满足其一：
  - 请求头 `x-superagent-csrf: 1`（控制台 always 携带）；
  - 或 `Origin` 与请求 Host 同源。
- Webhook 与 `/internal/*` 不使用 session：分别使用平台签名与服务 token。
- 限流：全局 600 次/分钟/IP；Webhook 默认 120 次/分钟/IP（`RATE_LIMIT_WEBHOOK_MAX`）。

### `GET /v1/session`

返回当前会话、平台名称与可用登录方式。

```json
{
  "user": { "id": "…", "name": "Alice", "avatar": null, "email": null, "isAdmin": false },
  "appName": "Superagent",
  "publicBaseUrl": "http://localhost:3000",
  "auth": { "devLogin": true, "oauth": { "feishu": false, "wecom": false } }
}
```

未登录时 `user` 为 `null`。

### `POST /v1/auth/dev-login`

仅当 `AUTH_DEV_LOGIN=true`。Body：`{ "name": "Alice", "externalId": "可选" }`。设置会话 Cookie，返回 `{ user }`。

### `POST /v1/auth/logout`

删除会话并清除 Cookie，返回 `{ ok: true }`。

### OAuth

- `GET /v1/auth/feishu/start?returnTo=/projects/…`（或 `wecom`）：302 到平台授权页，同时设置 10 分钟有效的签名 state Cookie。
- `GET /v1/auth/:provider/callback?code=…&state=…`：校验 state、换取用户身份、创建会话并 302 回 `returnTo`。
- 未配置对应凭据时返回 404。

## 项目

### `GET /v1/projects`

返回当前用户可见的项目摘要（管理员可见全部）。

```json
{
  "items": [
    {
      "id": "uuid",
      "name": "演示项目",
      "slug": "demo",
      "status": "active",
      "role": "owner",
      "repo": { "owner": "demo-org", "name": "hello-world", "fullName": "demo-org/hello-world", "defaultBranch": "main", "installationId": "1" },
      "channel": { "id": "uuid", "provider": "feishu", "name": "演示项目群", "externalChatId": "oc_demo" },
      "openTickets": 1,
      "runningRuns": 0,
      "memberCount": 2,
      "createdAt": "…",
      "updatedAt": "…"
    }
  ]
}
```

### `POST /v1/projects`

Body：

```json
{ "name": "增长实验", "slug": "growth", "description": "…", "policy": {}, "modelConfig": {} }
```

- 创建者为 Owner，初始状态 `draft`。
- `policy` / `modelConfig` 会按 schema 补默认值。
- 返回 `201 { project }`。

### `GET /v1/projects/:id`

返回项目详情：项目字段 + `role`、`repo`、`channel`、`memberCount`、`readiness`。

### `PATCH /v1/projects/:id`

可更新 `name`、`description`、`policy`、`modelConfig`、`status`。

- 名称/策略/模型/描述：仅 Owner。
- `active` / `paused`：Owner 或 Maintainer（可暂停/恢复）；`draft → active` 与 `archived` 仅 Owner。
- 启用前必须有仓库和 active 群，否则 `409`。

### `GET /v1/projects/:id/overview`

返回统计卡所需数据：按状态的工单/运行计数、最近工单、活跃运行、今日 Token、策略、项目详情。

## 成员

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/members` | Viewer+ | 成员列表（含 IM 身份） |
| POST | `/v1/projects/:id/members` | Owner | Body：`{ "userId": "…", "role": "member" }` 或 `{ "provider": "feishu", "externalId": "ou_…", "role": "member" }` |
| PATCH | `/v1/projects/:id/members/:userId` | Owner | `{ "role": "maintainer" }`；不能直接授予 Owner |
| DELETE | `/v1/projects/:id/members/:userId` | Owner | 至少保留一个 Owner |

`GET /v1/users?q=昵称或邮箱`：供 Owner 搜索已登录过平台的用户。

## 邀请

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/invites/:token` | 公开 | 预览：项目、角色、有效期、剩余次数、项目群入口 |
| POST | `/v1/invites/:token/accept` | 登录 | 加入项目；已是成员则幂等返回；尝试自动拉群并返回群入口 |
| GET | `/v1/projects/:id/invites` | Maintainer+ | 邀请记录（不含明文 token） |
| POST | `/v1/projects/:id/invites` | Owner | Body：`{ "role": "member", "maxUses": 50, "expiresInHours": 72 }` |
| DELETE | `/v1/projects/:id/invites/:inviteId` | Owner | 撤销邀请 |

`POST /v1/projects/:id/invites` 返回：

```json
{
  "invite": {
    "id": "uuid",
    "role": "member",
    "expiresAt": "…",
    "maxUses": 50,
    "usedCount": 0,
    "url": "https://host/invite/inv_…",
    "qrDataUrl": "data:image/png;base64,…"
  },
  "token": "inv_…"
}
```

### 扫码入项目与入群

`GET /v1/invites/:token` 的响应包含：

```json
{
  "invite": {
    "valid": true,
    "project": { "id": "…", "name": "演示项目", "slug": "demo", "status": "active" },
    "role": "member",
    "group": {
      "provider": "feishu",
      "name": "演示项目群",
      "chatId": "oc_…",
      "joinUrl": "https://applink.feishu.cn/client/chat/open?openChatId=oc_…",
      "qrDataUrl": "data:image/png;base64,…",
      "autoJoin": true
    }
  }
}
```

`POST /v1/invites/:token/accept` 在加入项目后还会尝试自动拉群：

```json
{
  "project": { "…": "项目详情" },
  "role": "member",
  "alreadyMember": false,
  "group": {
    "group": { "provider": "feishu", "chatId": "oc_…", "joinUrl": "…", "qrDataUrl": "…", "autoJoin": true, "name": "演示项目群" },
    "joined": true,
    "error": "可选：自动拉群失败原因"
  }
}
```

- 自动拉群只在 IM 适配器实现 `addMembers` 时执行：飞书需 `im:chat.members:write_only` 且机器人为群管理员；企业微信仅支持应用通过 `appchat` 创建的自建群，绑定已有群时请关闭 `autoJoin`。
- 用户在当前 IM 平台没有身份（例如开发登录）、自动拉群失败或平台不支持（企业微信）时，`joined=false`，客户端展示 `qrDataUrl` / `joinUrl`，不会阻塞加入项目。

## 仓库与 GitHub App

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/repo` | Viewer+ | 当前仓库、installation 列表、GitHub 模式（app/mock） |
| POST | `/v1/projects/:id/repo` | Owner | `{ "installationId": "1", "owner": "org", "name": "repo", "defaultBranch": "main" }` |
| DELETE | `/v1/projects/:id/repo` | Owner | 解绑 |
| GET | `/v1/projects/:id/repo/candidates?installationId=` | Owner | GitHub App 已授权仓库列表 |
| GET | `/v1/github/install/start?projectId=` | Owner | 302 到 GitHub App 安装页 |
| GET | `/v1/github/install/callback?installation_id=&state=` | 登录 | 校验签名 state，记录 installation，302 回项目页 |

`GITHUB_MODE=mock` 时不会访问 GitHub：安装回调与仓库列表来自内置演示数据，PR 使用模拟 URL。

## IM 群

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/channels` | Viewer+ | 绑定历史与当前 active 群 |
| POST | `/v1/projects/:id/channels` | Owner | Body：`{ "provider": "feishu", "externalChatId": "oc_…", "name": "项目群", "config": { "joinUrl": "https://…", "qrDataUrl": "data:image/png;base64,…", "autoJoin": true } }` |
| DELETE | `/v1/projects/:id/channels/:channelId` | Owner | 停用绑定 |

- `(provider, external_chat_id)` 全局唯一；一个群只能属于一个项目。
- 一个项目同时只有一个 active 群；绑定新群会自动停用旧绑定。
- `config.joinUrl` / `config.qrDataUrl` 用于新成员接受邀请后的入群入口；未知字段与非法 URL 会被丢弃。
- `config.autoJoin` 控制是否在邀请接受后自动拉群：飞书默认开启；企业微信默认关闭（仅应用自建群可用）。
- 企业微信可在 `config.webhookUrl` 配置群机器人地址作为发送通道。

## 工单

### `GET /v1/projects/:id/tickets?status=&q=&limit=&offset=`

返回 `{ items, total, limit, offset }`。`limit ≤ 100`。

### `POST /v1/projects/:id/tickets`

Body：

```json
{ "title": "可选", "body": "需求正文", "priority": "normal", "channelId": "可选" }
```

- 权限：Member+；项目必须 `active`；若策略 `membersCanCreateTickets=false`，普通 Member 被禁止。
- 返回 `201 { ticket, warning? }`。`warning` 表示工单已创建但未能入队（例如预算用尽）。
- 入队 plan Run。

### `GET /v1/projects/:id/tickets/:ticketId`

返回 `{ ticket, runs, approvals, messages, intake, ref }`。

### `POST /v1/projects/:id/tickets/:ticketId/approve`

Maintainer+；`{ "comment": "可选" }`。只允许 `planned` 状态；创建 execute Run 并返回 `{ run, ticket }`。

### `POST /v1/projects/:id/tickets/:ticketId/cancel`

Maintainer+；取消 queued Run、请求取消 running Run，工单 `cancelled`。返回 `{ ticket }`。

### `POST /v1/projects/:id/tickets/:ticketId/retry`

Maintainer+；仅 `failed` / `cancelled`，按最后一次 Run 的 kind 重新排队，最多 attempt 2。返回 `{ run, ticket }`。

### 兼容别名（对应方案 §10）

- `POST /v1/tickets`（Body 需含 `projectId`）
- `GET /v1/tickets?projectId=…`
- `GET /v1/tickets/:id`
- `POST /v1/tickets/:id/approve|cancel|retry`

## 运行与日志

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/runs/:id` | Viewer+ | Run 详情 + 事件列表 |
| GET | `/v1/runs/:id/events?limit=200` | Viewer+ | Agent 事件流（type/message/createdAt） |

## 审计与用量

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/v1/projects/:id/audit?action=&limit=&offset=&from=&to=` | Maintainer+ | 审计日志，按时间倒序，最多 200 |
| GET | `/v1/projects/:id/usage?days=30` | Viewer+ | 每日 runs/tokens/cost、今日 Token、策略 |

## Webhook

### `POST /webhooks/feishu`

- `url_verification`：返回 `{ "challenge": "…" }`（仍需 verification token 正确）。
- 事件：`im.message.receive_v1`；支持 `encrypt` 字段（AES-256-CBC）与 `X-Lark-Signature` 验签。
- 响应：`{ "code": 0, "processed": 1 }`；重复事件 `processed: 0`。
- 兼容：加密回调必须签名；未签名的 `url_verification` 仅在没有 `encrypt` 且 token 正确时接受。

### `GET /webhooks/wecom`

企业微信 URL 验证：校验 `msg_signature`、解密 `echostr`、校验 corp id，返回明文 challenge（`text/plain`）。

### `POST /webhooks/wecom`

解密 XML 消息、验签；处理后返回空字符串（`text/plain`）。

### `POST /webhooks/github`

- 必须配置 `GITHUB_WEBHOOK_SECRET`；校验 `X-Hub-Signature-256`。
- 使用 `X-GitHub-Delivery` 去重。
- 处理 `pull_request`、`issue_comment`、`pull_request_review_comment`、`check_suite`、`check_run`。
- 响应：`202 { "ok": true, "handled": "merged" }`；重复投递 `202 { "ok": true, "duplicate": true }`。

## 内部接口

`POST /internal/runs/:id/events`

```http
Authorization: Bearer <INTERNAL_TOKEN>
Content-Type: application/json

{ "type": "log", "message": "…", "payload": { "any": "json" } }
```

写入 `run_events` 并刷新心跳，返回 `{ ok: true }`。供外部 Worker/Agent 包装器使用；内置 Worker 直接写库。

`POST /internal/runs/:id/heartbeat`：仅刷新心跳。

## 健康检查

| 路径 | 说明 |
| --- | --- |
| `GET /healthz` | 存活；返回 uptime 与版本 |
| `GET /readyz` | 数据库探活；失败 503 |
| `GET /metrics` | Prometheus 文本：`superagent_runs_total{status}`、`superagent_tickets_total{status}`、`superagent_outbox_pending`、`superagent_up` |

## 示例：本地演示

```bash
BASE=http://127.0.0.1:3100
COOKIE=$(curl -si -X POST "$BASE/v1/auth/dev-login" \
  -H 'content-type: application/json' \
  -d '{"name":"Alice"}' | grep -i '^set-cookie:' | sed 's/^[^:]*: //; s/;.*//')

curl -s "$BASE/v1/projects" -H "cookie: $COOKIE"
curl -s -X POST "$BASE/v1/projects/<id>/tickets" \
  -H "cookie: $COOKIE" -H 'x-superagent-csrf: 1' -H 'content-type: application/json' \
  -d '{"title":"示例","body":"新增欢迎页"}'
```
