# Web 控制台说明

控制台是 React 18 + Vite + TypeScript 的单页应用，构建产物由 API 进程从 `server/public` 提供。没有引入 UI 框架，样式集中在 `web/src/styles.css`，颜色、圆角、阴影全部走 CSS 变量，支持明/暗双主题。

## 信息架构

```text
/login                     登录（飞书 / 企业微信 OAuth，或开发登录）
/invite/:token             邀请预览、接受；接受后展示项目群二维码/链接（或自动入群结果）
/join/:token              企业微信扫码入群页；登录后自动加入项目并拉入应用群
/                          项目列表 + 新建项目
/projects/:id              项目工作台
  ?tab=overview            概览：统计、企业微信扫码入群、交付配置、最近工单、活跃 Turn
  ?tab=session             Main Session：状态、模型、transcript、Eval Turns
  ?tab=tickets             工单列表、筛选、分页、新建
  ?tab=members             成员、角色、添加/移除
  ?tab=channel             IM 群绑定/解绑、群二维码上传、邀请链接、自动拉群开关（飞书 / 企微自建群）、接入说明
  ?tab=repo                GitHub 仓库：安装、选择、手动绑定、解绑
  ?tab=invites             邀请二维码、有效期/次数、撤销
  ?tab=settings            名称/描述、执行策略、模型、安全说明
  ?tab=audit               审计日志（动作、人、目标、元数据）
  ?tab=usage               Token 趋势、预算使用、每日明细
/projects/:id/tickets/:tid 工单详情：需求、Executor Session、Report、计划、Turn 日志、消息、审批
```

导航侧栏展示当前用户加入的项目及活跃工单数；顶部面包屑与主题切换、退出登录在侧栏底部。

## 设计令牌

定义在 `web/src/styles.css` 的 `:root` 与 `[data-theme='dark']`：

| 令牌 | 用途 |
| --- | --- |
| `--bg` / `--surface` / `--surface-2` | 页面、卡片、浅填充 |
| `--ink` / `--text` / `--muted` | 标题、正文、次要信息 |
| `--line` / `--line-strong` | 分隔线与输入边框 |
| `--brand` / `--brand-soft` / `--brand-ink` | 主操作、选中态、主色上的文字 |
| `--success` / `--warning` / `--danger` / `--info`（+ `-soft`） | 状态色与浅底 |
| `--radius` / `--radius-sm` | 卡片 14px、控件 9px |
| `--shadow-sm` / `--shadow-md` | 卡片与浮层 |
| `--sidebar*` | 深色侧栏的专用色，不随明暗主题反转 |

状态色映射集中在 `web/src/format.ts` 的 `statusTone`，徽标、时间线、运行状态都复用它。切换主题时只替换 CSS 变量，不改组件。

## 页面与状态

每个数据页都实现 **loading / empty / error** 三态，而不是只画 happy path：

- 列表加载：`Spinner`；失败：`ErrorState` + 重试；为空：`EmptyState` + 主操作。
- 表单提交：按钮 `loading`，错误显示为 `ErrorNotice` 或 Toast；成功刷新列表。
- 危险操作（解绑、移除成员、取消工单、归档）：二次确认弹窗。
- 工单详情：活跃状态下每 5 秒轮询；展示 Executor Session、Mandate、最近 Report 与 transcript；Turn 日志按需展开；审批/停止/重试按角色和 stage 显示。
- 无权限：隐藏不可用操作，并说明所需角色。

## 响应式

- ≥ 1040px：四列统计卡、双栏详情。
- 900–1040px：统计卡两列，工单详情单列。
- ≤ 900px：侧栏变为顶部紧凑导航（品牌 + 项目横向滚动 + 主题/退出），内容全宽。
- ≤ 640px：所有网格单列，表单两列变一列，二维码面板纵向排列。

在 1440、860、390 三个宽度下用截图工具验证过无横向溢出。截图见 `docs/screenshots/10-project-narrow.png`、`11-projects-mobile.png`。

## 截图

| 页面 | 文件 |
| --- | --- |
| 登录 | `docs/screenshots/01-login.png` |
| 项目列表 | `docs/screenshots/02-projects.png` |
| 项目概览 | `docs/screenshots/03-project-overview.png` |
| Main Session | `docs/screenshots/03b-main-session.png` |
| 企业微信扫码入群 | `docs/screenshots/03c-wecom-join.png`、`03d-wecom-joined.png` |
| 工单列表 | `docs/screenshots/04-tickets.png` |
| 工单详情 | `docs/screenshots/05-ticket.png` |
| 邀请与二维码 | `docs/screenshots/06-invites.png`、`06b-invite-qr.png`、`07e-invite.png`、`07f-invite-group.png`（扫码入群） |
| 成员 | `docs/screenshots/07-members.png` |
| IM 群与入群配置 | `docs/screenshots/07g-channel.png` |
| 仓库 | `docs/screenshots/07b-repo.png` |
| 审计 | `docs/screenshots/07c-audit.png` |
| 设置 | `docs/screenshots/07d-settings.png` |
| 深色主题 | `docs/screenshots/08-project-dark.png`、`09-ticket-dark.png` |
| 窄屏 / 移动 | `docs/screenshots/10-project-narrow.png`、`11-projects-mobile.png` |

重新生成（需要本机 Chrome，演示服务运行在 3100）：

```bash
cd platform
node scripts/ui-screenshots.mjs http://127.0.0.1:3100
```

脚本通过 Chrome DevTools Protocol 开发登录、遍历页面并截图，不依赖 Playwright。

## 可访问性

- 交互元素使用原生 `button` / `a` / `input`，有可见 `:focus-visible` 焦点环。
- 模态框带 `role=dialog`、`aria-modal`、标题关联与 Esc 关闭。
- 状态不只靠颜色：徽标同时有文本，表格列有明确表头。
- 图标按钮都有 `aria-label` / `title`。
- Toast 区域 `aria-live="polite"`。

## 前端开发

```bash
cd platform
pnpm dev:api      # :3000
pnpm dev:web      # :5173，Vite 代理 /v1 与 /webhooks
pnpm typecheck
```

生产构建：`pnpm build`，输出到 `server/public`，由 API 直接托管，无需单独的前端服务器。
