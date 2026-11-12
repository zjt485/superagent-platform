# 部署与运维

本文覆盖单机 Docker Compose 部署、飞书与 GitHub App 配置、Agent Runtime 接入、备份与常见故障。

## 1. 前置条件

- 一台 Linux VM（MVP 建议 8C16G 起），安装 Docker 24+ 与 Docker Compose v2；
- 一个域名，80/443 可访问公网（飞书 / GitHub Webhook 强制要求 HTTPS）；
- 飞书企业自建应用、GitHub App 的创建权限；
- 具备 DSH headless 或其它 Agent 运行时的镜像/命令（演示可先用 FakeRuntime）。

> 本仓库的演示不需要以上外部条件；真实试点至少需要域名、飞书应用与 GitHub App。

## 2. 单机 Compose

```bash
cd platform
cp .env.example .env
# 生成密钥
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('INTERNAL_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))"
```

编辑 `.env`：

- `PUBLIC_BASE_URL` / `DOMAIN`：例如 `https://agent.example.com`；
- `POSTGRES_PASSWORD`：强随机；
- `SESSION_SECRET`、`INTERNAL_TOKEN`：上面生成的值；
- `AUTH_DEV_LOGIN=false`（生产环境为 true 时进程会拒绝启动）；
- `GITHUB_MODE=app`，填写 GitHub App 凭据；
- `AGENT_RUNTIME=command`，填写 `AGENT_COMMAND`。

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api worker
```

首次启动由 `api` 执行数据库迁移（`MIGRATE_ON_START=true`），`worker` 依赖 `api` healthy 后才启动，避免并发迁移。

访问 `https://<DOMAIN>`；用飞书扫码登录。平台管理员可通过 `PLATFORM_ADMIN_EXTERNAL_IDS` 指定（逗号分隔，支持 `feishu:ou_xxx` 或纯 external id）。

### 服务拓扑

| 服务 | 说明 |
| --- | --- |
| `api` | 控制面 + Webhook + Web 控制台静态资源；无状态，可多副本 |
| `worker` | 领取 Session Turn；Main eval 或 Executor 执行；克隆/复用仓库目录；推送分支与创建 PR |
| `postgres` | 控制面数据库（Postgres 16） |
| `redis` | BullMQ 队列与唤醒（可降级为 DB 队列） |
| `caddy` | TLS、反向代理、Webhook 入口 |

Worker 容器内**不挂载 Docker socket**；Executor Session 在容器内按工单使用持久目录，Main Session 使用 scratch 目录。若需要更强的内核级隔离，可把 `worker` 换成一次性任务容器（K8s Job / ECS Task），`TurnRuntime` 接口不变。

### 只用 API 镜像

镜像内包含 api 与 worker 两个入口：

```bash
docker build -t superagent-platform:0.1.0 .
docker run --rm -p 3000:3000 --env-file .env superagent-platform:0.1.0             # api
docker run --rm --env-file .env superagent-platform:0.1.0 node dist/worker-main.js # worker
```

（必须在 `/app/server` 工作目录，镜像已设置。）

## 3. 飞书接入（默认）

1. 在飞书开放平台创建**企业自建应用**，启用「机器人」能力。
2. 权限：至少 `im:message`（读取群消息）、`im:message:send_as_bot`（发送消息）、`im:chat:readonly`（读取群信息）。若希望成员接受邀请后**自动拉群**，额外申请 `im:chat.members:write_only`，并把机器人设为群管理员；否则成员会看到群二维码/链接。
3. 事件订阅：
   - 请求地址：`https://<DOMAIN>/webhooks/feishu`；
   - 订阅事件：`im.message.receive_v1`；
   - 复制 **Verification Token** 与 **Encrypt Key** 到 `.env`；
   - 在开放平台完成 URL 验证（平台会返回 `challenge`）。
4. 网页应用（控制台登录）：
   - 重定向 URL：`https://<DOMAIN>/v1/auth/feishu/callback`；
   - 复制 App ID / App Secret 到 `.env`（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。
5. 发布应用版本，管理员审核通过后把机器人拉进项目群。
6. 获取机器人的 `open_id` 填入 `FEISHU_BOT_OPEN_ID`：
   - 可用应用凭据调用 `GET https://open.feishu.cn/open-apis/bot/v3/info`；
   - 不填时，适配器会把「任意 @ 提及」视为 @bot（不建议生产）。
7. 获取群 `chat_id`（群设置或回调日志），在控制台「IM 群」页绑定；也可以让项目 Owner 在群里发送 `@bot /bind <项目标识>`。
8. 在「IM 群」绑定表单里可上传**群二维码**、填写群邀请链接。新成员接受项目邀请后会看到「最后一步：加入项目群」：自动拉群成功则提示已入群，否则展示二维码/链接。

> `PUBLIC_BASE_URL` 必须与飞书回调域名一致，否则 OAuth 回跳地址会错。

## 4. GitHub App 接入

1. 在组织下创建 GitHub App：
   - Homepage：`https://<DOMAIN>`；
   - Callback URL：`https://<DOMAIN>/v1/github/install/callback`；
   - Webhook URL：`https://<DOMAIN>/webhooks/github`；
   - Webhook secret：填入 `GITHUB_WEBHOOK_SECRET`；
   - 仓库权限：Contents（读写）、Pull requests（读写）、Metadata（只读）、Checks（只读，可选）；
   - 订阅事件：Pull request、Issue comment、Pull request review comment、Check suite、Check run。
2. 生成私钥（`.pem`），填入 `GITHUB_APP_PRIVATE_KEY`（把换行写成 `\n`）或挂载文件并设置 `GITHUB_APP_PRIVATE_KEY_PATH`。
3. 记下 App ID 与 App slug（安装链接用）。
4. 在控制台项目「仓库」页点击「安装 / 授权 GitHub App」，选择仓库；或使用手动绑定。
5. 在仓库开启 branch protection：禁止直接 push 默认分支；可要求 PR review。

平台只会推送 `agent/*` 分支、创建 PR、读取 CI 状态，**不会自动合并**。

## 5. 企业微信接入（可选）

1. 企业微信管理后台创建自建应用，记录 CorpID、AgentId、Secret。
2. 接收消息：
   - URL：`https://<DOMAIN>/webhooks/wecom`；
   - Token / EncodingAESKey 填入 `.env`（`WECOM_TOKEN` / `WECOM_ENCODING_AES_KEY`）；
   - 在控制台 IM 群页填写群 `chatid`。
3. OAuth：应用可信域名配置 `<DOMAIN>`，网页授权回调 `https://<DOMAIN>/v1/auth/wecom/callback`。需要 `snsapi_base` 网页授权及通讯录读取权限。
4. 若应用消息无法发到已有群，可在群内添加「群机器人」，把 Webhook 地址填到绑定的 `config.webhookUrl`。
5. 企业微信**已有群**不支持通过 API 加人：请上传群二维码或填写群邀请链接，成员接受项目邀请后扫码入群。
6. 如果想自动拉群，使用应用通过 `appchat/create` 创建的自建群，把对应 `chatid` 绑定到项目，并在「IM 群」勾选“邀请后自动拉群”。平台会用 `appchat/get` 读取现有成员、合并新成员后 `appchat/update`；普通已有群会失败并自动回落到二维码/链接。
7. **群内 @ 机器人**：企业微信自建应用（appchat）只能向群发消息，官方不支持接收普通群消息。请额外创建一个「智能机器人」，使用长连接模式，并把它加入项目群一次（企业微信没有 API 可自动拉机器人进群）。平台用 `@wecom/aibot-node-sdk` 接收 @ 消息、发送回复；appchat 仍负责建群、OAuth 和拉人。

### 5.1 真实扫码入群流程（appchat 应用群）

企业微信没有给普通内部群生成“入群二维码”的 API。平台使用应用自建群：

1. 项目创建并绑定 GitHub 仓库；
2. 在项目详情页点击「创建企业微信群并生成二维码」：
   - 用当前 Owner 的企业微信 userid 调 `appchat/create`；
   - 群名 `${项目名} · Superagent`，成员包含项目内已有企业微信身份；
   - 保存 `chatid`，绑定为项目群，若项目是 draft 且有仓库则自动 active；
3. 页面展示平台签名二维码（90 天，链接为 `/join/<token>`）；
4. 用户用企业微信扫码 → 打开平台入群页 → 企业微信 OAuth 登录；
5. 平台加入项目成员，并用 `appchat/get` + `appchat/update` 把该 userid 合并进应用群；
6. 群主在群里添加一次「智能机器人」（群设置 → 群机器人 / 智能机器人），把 BotID/Secret 配到 `.env`：

   ```env
   WECOM_BOT_ID=
   WECOM_BOT_SECRET=
   # 私有部署才需要
   WECOM_BOT_WS_URL=
   ```

   API 进程启动后会自动建立 WebSocket 长连接；群内 @ 机器人会进入 Main Session。回复通过智能机器人发送，appchat 仅用于建群/OAuth/拉人。一个 BotID 同时只能有一条长连接，因此启用 Bot 时 API 不要多副本。

7. 用户可在群里 @机器人 提需求，Main/Executor 双 Agent 对绑定的 GitHub 仓库工作。智能机器人回调的 `chatid` 必须与绑定项目的 `externalChatId` 一致；如果先在群里手动建群并加机器人，用群内 `/bind <项目slug>` 绑定。

权限/配置要求：

- 自建应用可见范围包含 Owner 和所有扫码成员；
- `WECOM_CORP_ID`、`WECOM_SECRET` 有效（appchat 与 OAuth 都用 corp secret）；
- `WECOM_BOT_ID` / `WECOM_BOT_SECRET`：智能机器人长连接凭证；管理员后台把机器人 API 模式设为「长连接」；
- `PUBLIC_BASE_URL` 与企业微信可信域名一致，且必须是 HTTPS；
- 已有群（非应用创建）无法通过 API 拉人：项目详情页会提示先解绑，或继续上传群二维码/邀请链接。

**限制**：

- 企业微信应用消息没有原生线程；智能机器人只会在群内被 @（或单聊）时推送消息，因此线程追问也需要 @ 机器人，不能像飞书那样自动收普通回复。
- appchat 群本身不能接收群消息；必须使用智能机器人。机器人加入群需要群主手动操作一次（企业微信未开放自动拉机器人入群的 API）。
- 智能机器人回调的 `from.userid` 对非超级管理员可能返回**加密 userid**，与 OAuth 的明文 userid 不一致。当前平台按 OAuth 身份匹配成员；若你的企业返回加密 ID，需要额外做身份绑定（尚未实现），否则会表现为“消息被忽略/不是成员”。联调时先确认回调 userid 与 OAuth userid 是否一致。

## 6. Agent Runtime 接入（双 Session）

平台不内置 DSH CLI 参数，而是通过 `AGENT_COMMAND` 适配。每次模型调用是一个 **Turn**；Main Session 和 Executor Session 共用同一个命令，通过环境变量与输入文件区分角色。

命令可用占位符：

```text
{workspace}   Main：项目 scratch 目录；Executor：持久工单目录（已 clone）
{promptFile}  角色提示词（system prompt 的本地文件）
{inputFile}   结构化 packet：{ role, project, thread/ticket, policy, transcript, ... }
{resultFile}  期望写入 .superagent/result.json 的路径
{turnId}      Turn id
{ticketId}    Executor 的工单 id，Main 为空
```

运行时环境还提供 `SUPERAGENT_ROLE=main|executor`、`SUPERAGENT_SESSION_ID`、`SUPERAGENT_TURN_ID`、`SUPERAGENT_TICKET_ID`、`SUPERAGENT_INPUT_FILE`、`SUPERAGENT_RESULT_FILE`。

约定：

- Main Session 只输出 decisions，不修改仓库；Executor Session 只改工作区文件；
- **不要**执行 `git push` 或创建 PR；平台负责 commit、推送 `agent/*`、创建 PR；
- 结束时写 `result.json`：

```json
{
  "output": { "status": "ready", "summary": "…", "plan": "…" },
  "tokens": 1234,
  "cost": 0.0123
}
```

`output` 必须符合角色协议：

- Main：`{"decisions":[{"triggerId","action":"accept|ignore|attach|stop",...}]}`
- Executor：`{"status":"progress|waiting|ready|blocked|failed|dropped","summary","plan?","attention?","branch?","tokens?","cost?"}`

其他要求：

- 退出码 0 表示成功；非 0 视为 Turn 失败，stderr/错误会写入 Turn。
- 单 Turn 受 `policy.maxRunMinutes` 与 `AGENT_TIMEOUT_MINUTES` 双重限制。
- Executor 的持久目录在工单结束后由保留策略清理；Main 的 scratch 目录也不应长期保留。
- 如使用 DSH Session 能力，请按 `SUPERAGENT_SESSION_ID` 恢复同一 Session；平台同时持久化 transcript，模型不可用时可回放。

```env
AGENT_RUNTIME=command
AGENT_COMMAND=sh /opt/superagent/agent-wrapper.sh {workspace} {promptFile} {inputFile} {resultFile} {turnId} {ticketId}
```

把 `deploy/agent-wrapper.sh` 复制到镜像/宿主并替换其中的 DSH headless 调用。容器里需要安装 `git`、DSH 运行所需依赖与模型凭据；模型密钥只注入 Worker 环境，不进入 API 进程。

## 7. 数据库迁移

- 自动：`MIGRATE_ON_START=true`（默认）。
- 手动：

```bash
docker compose run --rm api node dist/db/migrate-cli.js
# 或本机
cd platform/server && pnpm db:migrate
```

- 生成新迁移（开发机）：

```bash
cd platform/server
pnpm db:generate
```

迁移文件在 `server/drizzle/`，镜像构建时拷贝。

## 8. 备份与保留

- **Postgres**：每日 `pg_dump -Fc`，保留 14–30 天，异地保存；同时在试点前演练一次恢复。

```bash
docker compose exec -T postgres pg_dump -U superagent -Fc superagent > backup-$(date +%F).dump
docker compose exec -T postgres pg_restore -U superagent -d superagent --clean --if-exists < backup.dump
```

- **Redis**：Compose 已开启 AOF；队列可重建，不作为业务真相来源。
- **工作目录**：Executor 的工单目录跨 Turn 保留，工单结束后按保留策略清理；Main 的 scratch 目录可随时清理。`KEEP_WORKSPACES=true` 仅用于排障并需人工清理。
- **消息 / 审计保留**：方案建议消息 90 天、审计 1 年。MVP 未内置定时清理，生产可用定时 SQL 或部署侧任务实现（见 STATUS.md「待完成」）。
- **删除项目**：删除 `projects` 行会级联清理成员、仓库、群、邀请、工单、Session/Turn、Report、Input、审批、Outbox 与审计；工作目录按 `project_id` 前缀清理。

## 9. 扩容与高可用

| 组件 | 扩容方式 |
| --- | --- |
| `api` | 无状态，直接多副本；Compose 可去掉端口映射，由 Caddy 做负载均衡 |
| `worker` | 多副本；`WORKER_CONCURRENCY` 控制每进程并发；项目级 Executor Turn 的 `maxConcurrentRuns` 由 claim 逻辑强制 |
| Postgres | 托管实例 / 主从；每日备份 |
| Redis | 托管实例；BullMQ 连接需允许 `maxRetriesPerRequest: null` |
| 工作目录 | 多 Worker 时用本地临时盘即可；若需要留存，挂载独立卷或对象存储 |

监控重点：

- 队列深度与最老 queued 时长；
- `superagent_runs_total{status="failed|timeout"}`；
- Outbox `pending` 数量与重试失败；
- Webhook 5xx / 401 比例；
- 每个项目的今日 Token 与 PR 产出时长。

## 10. 常见故障

| 现象 | 排查 |
| --- | --- |
| 飞书 URL 验证失败 | `PUBLIC_BASE_URL` 是否 HTTPS；`FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` 是否与后台一致；`/webhooks/feishu` 是否被代理到 api |
| 飞书回调 401 | 签名头缺失（未配置 encrypt key 时不需要）、时间戳偏差 >5 分钟、`FEISHU_BOT_OPEN_ID` 配错导致 @ 未识别 |
| 群消息不建单 | 群是否绑定到项目、项目是否 active、发送者是否成员、是否 @bot、是否在普通线程（非工单） |
| 建单后没有回执 | Outbox 是否 pending；是否配置 `FEISHU_APP_ID/SECRET`；查看 api 日志 `IM notification delivery failed` |
| GitHub PR 创建失败 | installation 是否授权该仓库；App 权限是否含 Contents/Pull requests；Worker 日志中的 git 错误 |
| Worker 一直不领取 | 项目是否 active；是否达到 `maxConcurrentRuns`；队列驱动与 Redis 连接；Turn 是否卡在 `running`（reaper 会在心跳超时后回收） |
| 登录后看不到项目 | 是否通过邀请加入；身份 provider/external id 是否与入群账号一致 |
| 接受邀请后没有自动进群 | 飞书：检查 `im:chat.members:write_only` 与群管理员权限；企业微信：仅 `appchat` 自建群可用。确认 `config.autoJoin=true`；失败时成员仍可扫码入群，审计里查 `channel.auto_join_failed` |
| 企业微信回调 400/401 | 检查 `WECOM_TOKEN`、`WECOM_ENCODING_AES_KEY`（43 位）、`WECOM_CORP_ID`；确认回调 URL 配的是 `/webhooks/wecom` 且域名与可信域名一致 |
| 入群二维码不显示 | 在「IM 群」绑定表单上传群二维码（<500KB）或填写群邀请链接；企业微信必须手动配置 |
| 生产启动失败 `SESSION_SECRET must be at least 32 characters` | 补齐密钥；`AUTH_DEV_LOGIN` 必须为 false |

## 11. 安全检查清单

- [ ] 生产 `AUTH_DEV_LOGIN=false`、`SESSION_SECRET` / `INTERNAL_TOKEN` 强随机且不进 Git。
- [ ] Webhook 域名 HTTPS，飞书/GitHub 密钥已配置并验证签名。
- [ ] GitHub App 使用最小权限；目标仓库开启 branch protection。
- [ ] Worker 容器非 root、无 Docker socket、无宿主目录挂载。
- [ ] Postgres/Redis 不暴露公网端口；Caddy 只开放 80/443。
- [ ] 日志不包含 token / cookie / 私钥（平台已做脱敏，仍需抽查）。
- [ ] 备份与恢复演练；审计保留策略已确认。
- [ ] 每个项目 `dailyTokenBudget`、`maxConcurrentRuns`、`maxRunMinutes` 按团队预算配置。

## 12. 不使用 Docker 的开发部署

```bash
cd platform
pnpm install
pnpm --filter @superagent/web build
cd server
PGLITE_DIR=./data/pglite PORT=3000 pnpm dev:api
# 另开终端
pnpm dev:worker
```

默认没有 `DATABASE_URL` 时使用 PGlite（嵌入 Postgres），适合本地与单机演示；生产请使用 Postgres 16。

服务端启动时会自动加载 `.env`（依次尝试 `server/.env`、`../.env`，已存在的环境变量优先），因此本地配置可以写进 `platform/.env`。

## 13. 本地接企业微信联调（单进程）

没有 Docker、没有公网服务器时，可以用一条隧道 + API 进程内 Worker 跑通真实企业微信回调。**仅用于开发联调，生产必须使用独立 Worker。**

### 13.1 准备隧道

```bash
# 任选其一；隧道必须提供 HTTPS（企业微信回调硬要求）
cloudflared tunnel --url http://127.0.0.1:3000
# 或 ngrok http 3000
```

记下 HTTPS 地址，例如 `https://abc-123.trycloudflare.com`。

### 13.2 写 `platform/.env`

```env
NODE_ENV=development
PUBLIC_BASE_URL=https://abc-123.trycloudflare.com
AUTH_DEV_LOGIN=true
INLINE_WORKER=true
QUEUE_DRIVER=db
AGENT_RUNTIME=fake
GITHUB_MODE=mock

# 企业微信自建应用
WECOM_CORP_ID=ww...
WECOM_AGENT_ID=1000002
WECOM_SECRET=...
WECOM_TOKEN=...
WECOM_ENCODING_AES_KEY=43位...
WECOM_BOT_NAME=Superagent

# 本地 PGlite（默认即可）
PGLITE_DIR=./data/pglite
```

说明：

- `INLINE_WORKER=true` 让 API 进程顺带消费 Session Turn，避免再起一个 Worker；`NODE_ENV=production` 时配置校验会拒绝该值。
- `AGENT_RUNTIME=fake` + `GITHUB_MODE=mock` 用于先验证“企微消息 → 工单 → PR 流程”；真正改代码/开 PR 需要改回 `command`/`app` 并配置 DSH 与 GitHub（见第 6 节）。
- 如果只用群机器人发送、不想配应用消息，仍然需要 CorpID/Secret 做 OAuth；发送侧可改用 `config.webhookUrl`。

### 13.3 配置企业微信后台

1. 接收消息 URL：`https://abc-123.trycloudflare.com/webhooks/wecom`，Token/EncodingAESKey 与 `.env` 一致。
2. 网页授权回调：`https://abc-123.trycloudflare.com/v1/auth/wecom/callback`，可信域名填隧道域名。
3. 把应用可见范围设为你和测试同事。

### 13.4 启动并测试

```bash
cd platform
pnpm install
pnpm build                 # 构建 Web 控制台
pnpm dev:api               # 自动加载 .env，:3000；日志出现 inline worker enabled
```

1. 用隧道地址打开控制台，点击“使用企业微信登录”。
2. 创建项目，绑定企业微信群：
   - 填写群 `chatid`；
   - 若为已有群，上传群二维码/邀请链接，并关闭“邀请后自动拉群”；
   - 在“群机器人 Webhook”填入该群的机器人地址（已有群必须，否则回执发不出去）；
   - 若是应用自建群，可勾选自动拉群。
3. 生成邀请链接，让测试账号接受邀请成为项目成员。
4. 在企业微信群里发送 `@Superagent /help`，应收到帮助；发送 `@Superagent 修复登录页文案` 创建工单。
5. 控制台应看到工单从 `queued → working → review`（兼容状态 `triaged → running → waiting_review`），出现 Mock PR 链接；Main Session 页有 eval Turn，审计里有 `webhook.wecom`、`ticket.created`、`turn.succeeded`。

### 13.5 排查

- 企业微信后台 URL 验证失败：确认隧道在线、`/webhooks/wecom` 可访问、Token/AESKey 与 `.env` 完全一致。
- 消息进来了但不建单：发送者是否已通过 OAuth 登录并加入项目；消息是否包含 `@WECOM_BOT_NAME`；群是否绑定到该项目且项目为 active。
- 有工单但收不到回执：已有群的 `chatid` 不能直接 `appchat/send`，请配置群机器人 Webhook；查看审计 `notification.sent` / Outbox failed。
- 想验证真实 Agent/PR：把 `AGENT_RUNTIME=command`、`GITHUB_MODE=app` 并配置 `AGENT_COMMAND` 与 GitHub App；或改用第 2 节的 Compose 部署。

> `pnpm demo` 是独立的 Mock 演示（PGlite + FakeRuntime + Mock GitHub），不会读取上述企微凭据；联调请使用 `pnpm dev:api`。
