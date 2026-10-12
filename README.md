# dsh-gitee-chat

[![npm](https://img.shields.io/npm/v/dsh-gitee-chat.svg)](https://www.npmjs.com/package/dsh-gitee-chat)
[![CI](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml/badge.svg)](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.2-4a6cf7.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![license](https://img.shields.io/npm/l/dsh-gitee-chat.svg)](./LICENSE)

> DSH 插件：在会话里管 Gitee 企业项目。
> **模型只触发，脚本去拉数，卡片在对话里画图** —— 不做侧边栏，不维护本地数据库。

## 它解决什么

要么开侧边栏看板，要么把整坨 JSON 塞进模型上下文 —— 这个包把两件事拆开：

```
模型调用 gitee_board              ← 只触发一次
     │
     ├─→ gq 脚本拉 Gitee 企业版 API   ← 数据由后台脚本取，字段已裁剪
     ├─→ 模型只拿到 summary 摘要      ← 几十~一千 token，与数据量无关
     └─→ 卡片直接找宿主路由要全量数据  ← 不经过模型，想画多少画多少
```

一句话：**上下文占用与数据量解耦**。一千个工作项和十个工作项，模型看到的摘要一样长。

## 安装

三种来源都是同一份 `npm pack` 产物（`files` 白名单 + `prepare` 构建，拿来即用）：

| 来源 | 命令 | 什么时候用 |
|---|---|---|
| **npm 官方源**（推荐） | `dsh plugin --profile desktop add dsh-gitee-chat` | 默认；DSH 的标准安装方式 |
| GitHub Release 附件 | `dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.2/dsh-gitee-chat-0.5.2.tgz"` | 直连 GitHub 不稳时的备用 |
| git 直装 | `dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.2"` | 想跟某个 tag / 分支 |

- **profile 要对**：桌面版是 `desktop`，`dsh web` 是 `web`。装错 profile 是**静默失效** —— 界面里什么都没有，也不报错。
- **桌面版的 `dsh` 用应用自带的那个**：全局装的 `dsh` 会拒绝 `--profile desktop`。路径在
  `<应用目录>\resources\runtime\cli\bin\dsh.cmd`；等价 GUI 入口是「设置 → 插件 → 添加插件」，
  填 `dsh-gitee-chat`（npm）或 `file:<本包目录>`（本地）。
- **升级 = `remove` + `add`**：`file:` 与 npm 装法都是副本，没有自动更新。
- npm 只往**官方源**（`registry.npmjs.org`）发一次；国内镜像会自动同步，**不要往镜像发**（也发不上去）。

### 让 AI 装上并配好（推荐）

本包自带一个 skill（`skills/dsh-gitee-chat/SKILL.md`），装了之后直接说：

> 帮我配置这个 Gitee 插件，配置项你问我。

它会探测环境（token 在不在、有几个企业、MCP 在不在、哪个 profile 装了本插件），
**只问三个它猜不到的**（用哪个企业、能不能直接改数据、规范要求几个标签），
把答案写进 profile 的 `cordis.patch.yml`（**只替换本插件那一段**，改前先备份），最后自检并汇报。
配置类改动会热重载，**通常不用重启**。

### Windows 一键安装（新机器）

```bat
git clone https://github.com/huayuguo/dsh-gitee-chat.git
cd dsh-gitee-chat
scripts\install-dsh.cmd
```

脚本一次做完：Node（优先用桌面应用自带 runtime，没有才 `winget` 装 LTS）→ dsh CLI → pnpm →
本包构建 → `file:` 安装 → 写默认配置 → 自检，并把 PATH 在当前窗口刷好。某一步失败它会说清原因，
不假装成功。撤销：

```bat
scripts\uninstall-dsh.cmd              :: 全清：dsh + Node + 相关文件夹 + 脚本策略
scripts\uninstall-dsh.cmd --keep-node  :: 机器本来就有 Node，只清 dsh
```

安装/升级时的三处常见坑（PowerShell 执行策略、`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、
`link:` 装法的失败症状）见 [USAGE.md 附录](./USAGE.md#附录安装与升级的常见坑)。

### 手工 / 开发安装

```sh
pnpm install && node build.mjs
dsh plugin --profile desktop add "file:$PWD"

node scripts/setup.mjs apply     # 写配置（enterpriseId: 0 = 自动识别企业）
node scripts/setup.mjs verify    # 自检；新机器上「还没有 token」是预期，不算装失败
```

改 `src/`、跑自检、提 PR 的流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 配置 token

在应用里 **设置 → Gitee 企业项目** 填 token 保存即可 —— 这是唯一的界面入口（会话里的
「Gitee 项目」标签页没有配置入口：没配 token 时那个标签页本来就打不开），存完即时生效。

取数脚本按优先级解析：

1. 环境变量 `GITEE_ENT_MCP_ACCESS_TOKEN`（或 `GITEE_ACCESS_TOKEN`、`GITEE_TOKEN`）
2. 文件 `$DSH_HOME/.gitee-chat/token`
3. 文件 `$DSH_HOME/gitee-chat-token`、`~/.gitee-token`

两个容易踩的点：

- **桌面版从开始菜单启动时不继承 shell 里 `export` 的变量**（只继承注册表里的用户/系统变量）——
  「网页版能用、桌面版说没有 token」多半是这个原因，所以**优先用界面填**。
- **已经挂载的 MCP 子进程**只在挂载时读一次 env 与 token 文件，改完要重启 DSH；
  `gq` 脚本每次调用现读（界面保存即时生效）。

自检：

```sh
node scripts/gitee/gq.mjs health   # token / 企业 / 连通性
node scripts/gitee/gq.mjs role     # 我是谁、什么人格、这个档能做什么
```

> Gitee 企业版端点要求 `Authorization: Bearer <token>` **加** MCP 同款 User-Agent，
> 两者缺一会返回 `Only For MCP Gitee Enterprise Application` —— 脚本已内置，自行 curl 时别漏。

## 界面

会话里有一张**看板卡片**（贴着那次工具调用），以及整屏的「**Gitee 项目**」标签页
（与 对话 / 轨迹 / 上下文 并列的第 4 个）。标签页自己拉数据（挂载即拉 + 右上角刷新），
**全程不经过模型**，所以数据多大都不占上下文：

| 页签 | 内容 |
|---|---|
| 项目 | 企业 KPI 统计条 · 项目列表 · 工作项表（未完成 / 逾期 / 全部）· 点行下钻 |
| 仓库 | 仓库列表（两种口径）+ 仓库 WIKI |
| 固定分析 | 9 张卡片：项目健康度 / 成员负载 / 延期清单 / 停滞 / 规范体检 / 进度偏差 / 交付容量 / 里程碑达成 / 交付趋势 |
| 知识库 | 企业知识库文档树 · 预览分工 · 按需缓存与四态判定 |

点任意工作项进入**详情面板**：描述（Markdown 渲染）、**前置依赖**（区分已完成 / 未完成，
并明确说谁卡住了本项）、**评论中的讨论**，以及**直接操作**：改状态、改派、发评论。

固定分析全部由 `gq` 脚本计算（同一输入永远得到同一输出），阈值随数据下发；
需要判断力的部分（WBS 合理性、风险根因、复盘）才交给模型，且必须基于这些事实。

**前置依赖两种写法都认**：Gitee 编号（`IK90004`）与 WBS 编码（`- ME-02 结构布局确定`，
靠标题前缀 `【DEMO900-ME-02】` 反查、短码按 `-` 分段做后缀匹配）。只认编号的实现会把
「有 3 个前置项」显示成「写着没有前置依赖」，比不显示更糟。

## 工具与路由

| 面 | 名字 | 说明 |
|---|---|---|
| 工具 | `gitee_board` | 拉看板数据；模型只得到摘要，卡片负责渲染 |
| 工具 | `gitee_role` | 解析当前 token 的身份、人格与能力档（管理者 / 负责人档 / 执行档） |
| 工具 | `gitee_enterprises` | 列出 / 切换当前企业 |
| 工具 | `gitee_chat_health` | 取数环境自检（token / 企业 / 连通性） |
| 工具 | `gitee_ent` | **公共 gateway**：任何 agent / 任何 preset 都能调 Gitee 企业 MCP，见下 |
| 路由 | `POST /api/gitee-chat/payload` | 卡片取全量数据（body: `{scope, program, refresh}`） |
| 路由 | `GET /api/gitee-chat/session?sessionId=` | 这个会话是不是 Gitee 模式（整屏视图与写路由的门禁依据） |
| 路由 | `GET /api/gitee-chat/issues?program=` | 单项目工作项清单 |
| 路由 | `GET /api/gitee-chat/issue?ident=` | 工作项详情：描述 + 前置依赖 + 评论 |
| 路由 | `GET /api/gitee-chat/states?type=` | 某工作项类型下的可选状态（改状态的选项来源） |
| 路由 | `GET /api/gitee-chat/members?program=` | 项目成员（改派的候选人） |
| 路由 | `POST /api/gitee-chat/write` | **唯一写入口**（改状态 / 评论 / 改派） |
| 路由 | `GET /api/gitee-chat/role` | 当前身份与人格（读缓存） |
| 路由 | `GET /api/gitee-chat/health` / `/ping` / `/preview` | 自检 / 存活 / 静态预览 |

所有路由都过与 `/api` 网关同款的 browser-trust fence（loopback 或部署的 trustedHosts + 同源）。
`/write` **额外要求** `sessionId` 属于一个 Gitee 模式的会话，否则 403 —— 这条路由挂在 profile 层，
凡是浏览器能打到 loopback 的都能打它，用会话身份把「谁能写」收敛住。

### 写回

所有改动都从 `src/host/write.ts` 出去，**全包唯一的写出口**，只允许三种操作：
`set-state` / `comment` / `assign`（正文走子进程 stdin，不塞 argv）。界面不做乐观更新：
写完重新拉一次详情，看到的就是服务端真值。`allowWrites: false` 的只读部署会明说
「写通道已关闭」，而不是给一堆点了会失败的按钮。

> 模型侧的写操作走它自己的 MCP 工具（`update_enterprise_issue` 等），那是**另一个平面**、
> 另一条通道，故意不复用：MCP 工具受能力档门禁约束，而 UI 只做最小写集合。

### `gitee_ent`：Gitee 企业 MCP 是公共工具

48 个 MCP 工具不限于 Gitee 模式，任意会话都能通过一个工具调到：

```text
gitee_ent(op:"list")                                  # 目录：工具名 + 首行说明，写工具带 ✎
gitee_ent(op:"schema", name:"list_enterprise_issues") # 这一个工具的参数说明
gitee_ent(op:"call",   name:"…", args:{…})            # 真正调用
```

两级暴露是为了省上下文：48 个工具的完整 schema 约 **14.6K tokens/请求**，而常驻的 gateway
说明只有约 **0.4K**，目录（只在实际用时进上下文）约 1.1K，单个工具的参数说明约 100–150 tokens。
Gitee 模式的会话不受影响：那里仍用原生 `mcp__gitee_ent__*`（gateway 在 Gitee 作用域里被隐藏），
能力档门禁一字未改。只读部署（`allowWrites: false`）下会硬拦 20 个写工具，
**Gitee 模式内外一个口径**。真正的权限边界始终在 Gitee 云端：能不能改，取决于 token 的身份
（拿不到就是 403/404），本地这层是「不给误操作的承诺」，不是安全边界。

## 换一台机器 / 换一个同事

这个包**不含**任何「本机 / 本公司」的硬编码，下面这些都能从配置或环境变量覆盖：

| 你会遇到的东西 | 它从哪来 | 怎么改 |
|---|---|---|
| 企业 id | `$DSH_HOME/.gitee-chat/config.json` | 界面「设置 → Gitee 企业项目 → 当前企业」里选（推荐，立即生效），或 `gq enterprises --use <id>`，或配置 `enterpriseId`，或环境变量 `GITEE_ENT_ID` |
| 企业版 token | 环境变量或 `$DSH_HOME/.gitee-chat/token` | 三种变量名任选其一；插件取数与 MCP 子进程**都按同一条顺序读它** |
| API base | 配置 `apiBase` | 私有化部署时改它 |
| User-Agent | 脚本内置默认值 | 配置 `userAgent` 或 `GITEE_ENT_USER_AGENT` |
| 分析阈值 | 脚本里的具名默认值 | 配置 `thresholds` 或 `GITEE_CHAT_*` 环境变量；**「标签数 = 3」是本团队的约定**，别人家设 2/4，或设 0 关闭 |
| 哪些 preset 算 Gitee 模式 | **按事实判定**：读 preset 组合，看有没有挂 `dsh-gitee-chat/agent` | 也可用配置 `presetIds: [...]` 显式列出；判定与 preset 名字无关 |
| MCP 可执行文件 | **随包分发**（`vendor/mcp-gitee-ent/`，linux + windows amd64），安装时自动落地到用户级 bin（Linux/macOS `~/.local/bin`，Windows `%USERPROFILE%\.local\bin`） | 什么都不用做。本平台未随包（arm64 / macOS）时才需 `go install`，或用 `MCP_GITEE_ENT_BIN` 指到已有二进制 |
| 知识库文档缓存 | 配置 `docs.root`，默认 `$DSH_HOME/gitee/docs` | 改 `docs.root`（支持 `~`）；**文档的端点不在这里配**，唯一实现是 MCP |
| MCP 文档工具名前缀 | 配置 `docs.mcpToolPrefix`，默认 `mcp__gitee_ent__` | 只有改了 preset 里 `mcp-gitee` 行的 `serverName` 才需要动它 |

已知的**不**可移植之处（刻意保留）：两个 preset 的 `agent.cordis.yml` 是从官方 `standard` preset
复制的组合快照，DSH 升级后需要重新同步（`pnpm run doctor` 会检查引用的插件行能否解析）；
`--enabled-toolsets` 由 `TIERS` 生成（`pnpm run capabilities:check` 挡漂移）；界面文案只有中文。

## 兼容性

`engines.dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围都写在当前 release 线上（当前 `^0.2.0-rc.2`）——
**跟随最新 DSH，不背旧版**，老 harness 会被拒绝安装。升级 DSH 之后跑一次 `pnpm run check`：
它会把 peer / `engines.dsh` 该改成的值打出来；装完可以用一句确认：

```sh
dsh plugin --profile desktop list   # 还打印 `is incompatible with dsh …` 就是范围没跟上
```

范围没跟上的表现是启动日志里 `skipping profile bundle "dsh-gitee-chat"` —— 插件整个不加载，
标签页和工具一起消失。

## 验证

```sh
pnpm run check                  # 一站式：smoke + render-check + 能力矩阵 + preset + types + 随包 MCP
node scripts/smoke.mjs          # 只跑 host / agent 半
node scripts/render-check.mjs   # 只跑卡片渲染（产出 preview/board-preview.html，可直接用浏览器打开）
```

CI（`.github/workflows/check.yml`）在 ubuntu + windows 上跑同一条 `pnpm run check` 全量链。
**冒烟测试绝不真的写 Gitee**：写通道用桩执行器验证，路由层只验门禁。

## 文档索引

| 文档 | 给谁看 |
|---|---|
| [`USAGE.md`](./USAGE.md) | **使用者**：界面怎么用、出问题怎么办、想改什么跟 AI 说 |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | **AI**：安装 / 配置 / 诊断的四步流程与硬规则 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | **开发者**：构建、自检、代码结构、提交规范 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 每个版本改了什么 |
| [`SECURITY.md`](./SECURITY.md) | 安全问题怎么报（不要开公开 issue） |
