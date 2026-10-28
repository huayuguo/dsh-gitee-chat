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

从 0.5.4 起还多了一条：面板数据会留一份**带时效的快照**，会话里的 agent 可以用
`gitee_board_snapshot` 直接读它（附 `fetchedAt / ageSeconds / stale`），
不用重新联网、也不占多少 token。

## 安装

三种来源都是同一份 `npm pack` 产物（`files` 白名单 + `prepare` 构建，拿来即用）：

| 来源 | 命令 | 什么时候用 |
|---|---|---|
| **npm 官方源**（推荐） | `dsh plugin --profile desktop add dsh-gitee-chat` | 默认；DSH 的标准安装方式 |
| GitHub Release 附件 | `dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.4/dsh-gitee-chat-0.5.4.tgz"` | 直连 GitHub 不稳时的备用 |
| git 直装 | `dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.4"` | 想跟某个 tag / 分支 |

- **profile 要对**：桌面版是 `desktop`，`dsh web` 是 `web`。装错 profile 是**静默失效** —— 界面里什么都没有，也不报错。
- **桌面版的 `dsh` 用应用自带的那个**：全局装的 `dsh` 会拒绝 `--profile desktop`。路径在
  `<应用目录>\resources\runtime\cli\bin\dsh.cmd`；等价 GUI 入口是「设置 → 插件 → 添加插件」，
  填 `dsh-gitee-chat`（npm）或 `file:<本包目录>`（本地）。
- **升级 = `remove` + `add`**：`file:` 与 npm 装法都是副本，没有自动更新。从 0.5.3 升上来时，
  profile 里可能还留着旧的两行预设（`preset-gitee-exec` / `preset-gitee-manager`），删掉它们，别留两个 Gitee 入口。
- npm 只往**官方源**（`registry.npmjs.org`）发一次；国内镜像会自动同步，**不要往镜像发**（也发不上去）。
- **包里有什么**：`files` 白名单只发 `lib`（含 `lib/types/` 类型声明）、`vendor`（随包 MCP 二进制）、
  三个运行期脚本（`scripts/setup.mjs`、`scripts/check-presets.mjs`、`scripts/gitee/`）、`skills`、
  `presets`、`assets`、两个 `cordis*.patch.yml`、`LICENSE`、`README.md`、`README.en.md`、`USAGE.md`、`icon.svg`；
  构建与自检脚本留在仓库里，不发 `src`。

### 让 AI 装上并配好（推荐）

本包自带一个 skill（`skills/dsh-gitee-chat/SKILL.md`），装了之后直接说：

> 帮我配置这个 Gitee 插件，配置项你问我。

它先探测环境（token 在不在、token 能看见几个企业、随包 MCP 在不在、哪个 profile 装了本插件），
**猜不到的一律先问**（用哪个企业、能不能直接改数据 `allowWrites`、规范要求几个标签），
再用 `node scripts/setup.mjs apply --answers '…'` 写配置：只替换 profile 的 `cordis.patch.yml` 里
`# >>> gitee-chat` / `# <<< gitee-chat` 两个哨兵之间的**本插件那一段**（改前先备份），
顺带写 `$DSH_HOME/.gitee-chat/config.json`、落地随包 MCP 二进制，最后 `verify` 自检并汇报。
配置类改动**热重载**（刷新页面即可），只有动过代码 / `lib/` 才需要重启 `dsh web`。

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

装完打不开、报错看不懂，先查 [USAGE.md 的排障表](./USAGE.md#三出问题先看这张表)；
升级后出现两个 Gitee 入口、旧预设行残留这类症状都在里面。

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
「Gitee 项目」标签页没有配置入口：没配 token 时面板本身就取不到数），存完即时生效。

需要的是 **Gitee 企业版的 access token**（个人版 token 打不到企业端点）；能看多少、能改多少，
最终取决于这个 token 在 Gitee 云端的角色 —— 拿不到就是 403/404，插件这一层只是「不给误操作的承诺」。

同一个设置页里还有另外两块：**当前企业**（token 可见多家企业时选一个，避免拿错公司的数据）和
**缓存与后台刷新**（见下文「缓存与时效」）。

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

会话头里的「**Gitee 项目**」标签（与 对话 / 轨迹 / 上下文 并列）打开就是整屏工作台，
它渲染在对话正文区里、**不接管右侧边栏**（文件预览、别的面板照常用）。

模型调用 `gitee_board` 时，对话里还会贴一张**看板卡片**（KPI + 状态分布 + 项目进度 + 风险清单，
按摘要裁剪过）；要下钻就用整屏工作台。

**0.5.4 起没有「Gitee 模式」这道门**：任何会话都能打开面板、都能点写操作的按钮
（经 `POST /write`、`/issue-create`、`/pr/create`、`/pr/action` 四个写路由出去）。
能不能改由 **token 在云端的角色**与部署配置 `allowWrites` 决定，与你在哪个会话无关。

工作台自己向宿主路由取数（挂载即拉 + 右上角刷新 + 30 秒读缓存），**全程不经过模型**，
所以数据多大都不占上下文。写操作后不整页闪：后台重取后原地更新，看到的是服务端真值。

### 六个页签

| 页签 | 内容 |
|---|---|
| 概览 | 四张 KPI 卡（项目数 · 工作项 · 待我处理 PR · 逾期工作项）+ 工作项状态分布环图 + 项目进度条 + 归我处理的风险 + PR 待办 |
| 项目 | 左侧项目列表 + 工作项表；点**仓库卡片**进「仓库下钻页」，点工作项行开详情 |
| 我的工作项 | 企业内「我是负责人 + 我是协作者」的工作项聚合（脚本在一次 payload 里算好，不额外请求），未完成 / 完成 / 逾期 / 全部可切；点一行直接开详情 |
| 合并请求 | 四种筛选（待我审核 / 待我测试 / 我提出的 / 全部）× 四种状态（打开 / 已合并 / 已关闭 / 全部状态）；顶部另有「可合并」卡（审查与测试均已通过）；抽屉里审、测、合 |
| 知识库 | 企业知识库的**节点树**（文件夹 + 上传附件形态）：左侧项目列表 + 右侧节点树，按需展开；预览交给侧边栏插件 |
| 固定分析 | 9 张卡片：项目健康度 / 成员负载 / 延期清单 / 停滞 / 规范体检 / 进度偏差 / 交付容量 / 里程碑达成 / 交付趋势 |

头部会写清数据来源（实时拉取 / 样例数据）、生成时间、当前身份，以及「缓存」「已截断」这类标记。

### 仓库下钻页（项目 → 仓库）

点项目页里的仓库卡片，会下钻成三栏：

```
[项目列表] │ [该项目的仓库列表] │ [仓库详情：工作项 / 合并请求 / WIKI]
```

- 栏宽可**拖动并记住**；
- 中栏的仓库列表可以切换，换仓库只重取右栏；
- 右栏三个页签：**工作项**（可按仓库新建、点行开详情）、**合并请求**（点行直接开抽屉）、**WIKI**；
- WIKI 首次点开会浅克隆整个 wiki 仓库到本地，之后读本地副本，`刷新` 才 `fetch`（离线也能看）；
  没有 WIKI 的仓库会明确说明，不会白屏；
- 返回按钮回到项目页；在仓库详情里换项目会留在三栏视图、清掉当前仓库。

### 合并请求：建 → 审 → 测 → 合

**新建 PR 不再只能去网页**：列表右上角「＋ 新建 PR」打开插件内弹窗 —— 仓库下拉、源分支 / 目标分支下拉
（分支从企业 API 现取；源 = 目标，或仓库只有一个默认分支时按钮置灰并说明原因）、标题、描述、
一键「**套用模板**」、审查人数 / 测试人数、草稿。它走宿主 `POST /pr/create`，与 MCP 的
`create_enterprise_repo_pull` 等价。

**AI 起草**：弹窗里点「✨ AI 起草」，宿主先抓 `compare`（源 vs 目标的真实提交与文件差异）与 PR 模板拼成
prompt，再在**所选会话下起一个子智能体**产出标题 + 描述并回填表单。取消勾选「子智能体」时，
同一段结论还会落进所选主会话（人能接着追问），表单照旧回填。

**AI 审核**：PR 抽屉的「AI 审核」页选工作区 / 会话 → 在所选主会话下起子智能体读 diff，按
**阻断 / 重要 / 次要** 分级给结论，默认不往主会话插用户消息（勾掉「子智能体」则结论落进主会话，
方便接着追问）。拿到结论后可一键「**提交评论并驳回**」或「**只提交评论**」再人工操作；
默认**不会**自动通过。

**抽屉里还能直接写回**：审核通过 / 拒绝 / 重置、测试通过 / 失败、合并、评论。按钮是否可点由云端权限决定
（不是审查人、没合并权限时按钮会禁用并说明缺哪项）；失败原因翻成白话
（`not-reviewer` / `nothing-to-reset` / `nothing-to-merge` 等）。审核模板与测试模板分开、面板里可改
（存成用户副本），内置模板不会被覆盖。

### 工作项

点任意工作项进入**详情面板**：描述（Markdown 渲染）、**前置依赖**（区分已完成 / 未完成，
并明确说谁卡住了本项）、**评论中的讨论**，以及**直接操作**：改状态、改派、发评论。

新建工作项在项目页与仓库详情都有入口，弹窗照 Gitee 网页版：标题、**负责人、优先级、计划时间起止
三项必填**（默认今天开始、下周五截止）。

**前置依赖两种写法都认**：Gitee 编号（`IK90004`）与 WBS 编码（`- ME-02 结构布局确定`，
靠标题前缀 `【DEMO900-ME-02】` 反查、短码按 `-` 分段做后缀匹配）。只认编号的实现会把
「有 3 个前置项」显示成「写着没有前置依赖」，比不显示更糟。

### 固定分析

9 张卡片全部由 `gq` 脚本计算（同一输入永远得到同一输出），阈值随数据下发；
需要判断力的部分（WBS 合理性、风险根因、复盘）才交给模型，且必须基于这些事实。

## 工具与路由

| 面 | 名字 | 说明 |
|---|---|---|
| 工具 | `gitee_board` | 拉看板数据；模型只得到摘要，卡片负责渲染 |
| 工具 | `gitee_board_snapshot` | 读面板留下的快照，带 `fetchedAt / ageSeconds / stale / ttlSeconds`；省 token、省往返 |
| 工具 | `gitee_role` | 解析当前 token 的身份、人格与能力档（管理者 / 负责人档 / 执行档） |
| 工具 | `gitee_enterprises` | 列出 / 切换当前企业 |
| 工具 | `gitee_chat_health` | 取数环境自检（token / 企业 / 连通性） |
| 工具 | `gitee_ent` | **公共 gateway**：任何 agent / 任何 preset 都能调 Gitee 企业 MCP，见下 |
| 路由 | `POST /api/gitee-chat/payload` | 卡片取全量数据（body: `{scope, program, refresh}`） |
| 路由 | `GET /api/gitee-chat/session?sessionId=` | 这个会话的 preset 与是否 Gitee 预设（**只作诊断用，不再是任何门禁**） |
| 路由 | `GET /api/gitee-chat/issues?program=` | 单项目工作项清单 |
| 路由 | `GET /api/gitee-chat/issue?ident=` | 工作项详情：描述 + 前置依赖 + 评论 |
| 路由 | `GET /api/gitee-chat/states?type=` | 某工作项类型下的可选状态（改状态的选项来源） |
| 路由 | `GET /api/gitee-chat/members?program=` | 项目成员（改派的候选人） |
| 路由 | `POST /api/gitee-chat/write` | 工作项写入口（改状态 / 改派 / 评论） |
| 路由 | `POST /api/gitee-chat/issue-create` | 新建工作项（负责人 / 优先级 / 计划时间必填） |
| 路由 | `GET /api/gitee-chat/repo/issues` · `/repo/branches` | 仓库维度的工作项与分支（新建 PR 的分支下拉） |
| 路由 | `GET /api/gitee-chat/pr/list` · `/pr/detail` | PR 列表（筛选 + 状态）与详情（信息 / 文件 diff / 评论） |
| 路由 | `POST /api/gitee-chat/pr/create` · `/pr/action` | 新建 PR；审核通过 / 拒绝 / 重置、测试通过 / 失败、合并、评论 |
| 路由 | `POST /api/gitee-chat/pr/ai-review` | 渲染 AI 审核 prompt（模板 + 范围 + 指定文件） |
| 路由 | `POST /api/gitee-chat/pr/ai-review/subagent` | 在所选会话下起子智能体跑审核；`GET` 同一路由取跑批结果 |
| 路由 | `POST /api/gitee-chat/pr/draft` | AI 起草：抓 `compare` 拼 prompt，起子智能体产出标题 + 描述 |
| 路由 | `GET/POST /api/gitee-chat/pr/templates` | 审查 / 测试模板读取与保存（用户副本优先于内置） |
| 路由 | `GET/POST /api/gitee-chat/pr/draft-target` | AI 审核 / 起草默认投递给哪个工作区与会话 |
| 路由 | `GET /api/gitee-chat/role` · `/health` · `/ping` · `/preview` | 身份人格 / 自检 / 存活 / 静态预览 |
| 路由 | `GET/POST /api/gitee-chat/token` · `/settings` · `GET /enterprises` · `POST /enterprise` | 设置页：token、当前企业、缓存与后台刷新 |
| 路由 | `/api/gitee-chat/docs` · `/docs/search` · `/doc` · `/doc/page` · `/doc/nodes` · `/doc/attachment` · `/doc/repos` · `/doc/wiki` · `/doc/wiki/page` · `/doc/cache` · `/doc/cache/forget` · `/doc/sync` | 知识库节点树、附件与仓库 WIKI：读、缓存、同步 |
| 路由 | `GET /api/gitee-chat/issue-types` · `/sessions` · `POST /pr/ai-review/subagent/cancel` · `GET /debug/services` · `/debug/presets` | 类型清单、可选会话、取消跑批、装配自检 |

所有路由都过与 `/api` 网关同款的 browser-trust fence（loopback 或部署的 trustedHosts + 同源）。
四个写路由（`/write`、`/issue-create`、`/pr/create`、`/pr/action`）在 `allowWrites: false` 的
只读部署上统一 403；**不再按「会话是否 Gitee 模式」拦**，sessionId 只用于审计与文档写的作用域。

### 写回

界面上的改动分四条路出去：工作项走 `src/host/write.ts`（`set-state` / `comment` / `assign`，
正文走子进程 stdin，不塞 argv）与 `/issue-create`；PR 走 `/pr/create` 与 `/pr/action`
（审核通过 / 拒绝 / 重置、测试通过 / 失败、合并、评论）。界面不做乐观更新：
写完重新拉一次详情，看到的就是服务端真值。`allowWrites: false` 的只读部署会明说
「写通道已关闭」，而不是给一堆点了会失败的按钮。

> 模型侧的写操作走它自己的 MCP 工具（`update_enterprise_issue`、`create_enterprise_repo_pull` 等），
> 那是**另一个平面**、另一条通道，故意不复用：MCP 工具受能力档门禁约束，而 UI 只做最小写集合。
> 两条路真正的权限边界都在 Gitee 云端。

### `gitee_ent`：Gitee 企业 MCP 是公共工具

55 个 MCP 工具不限于 Gitee 预设，任意会话都能通过一个工具调到：

```text
gitee_ent(op:"list")                                  # 目录：工具名 + 首行说明，写工具带 ✎
gitee_ent(op:"schema", name:"list_enterprise_issues") # 这一个工具的参数说明
gitee_ent(op:"call",   name:"…", args:{…})            # 真正调用
```

两级暴露是为了省上下文：55 个工具的完整 schema 常驻要十几 K tokens，而常驻的 gateway
说明只有约 **0.4K**，目录（只在实际用时进上下文）约 1.1K，单个工具的参数说明约 100–150 tokens。
Gitee 预设会话不受影响：那里仍用原生 `mcp__gitee_ent__*`（gateway 在 Gitee 作用域里被隐藏），
能力档门禁一字未改。只读部署（`allowWrites: false`）下会硬拦写工具，
**Gitee 预设内外一个口径**。真正的权限边界始终在 Gitee 云端：能不能改，取决于 token 的身份
（拿不到就是 403/404），本地这层是「不给误操作的承诺」，不是安全边界。

### 人格与三档能力矩阵

插件只注入一个 agent 预设「Gitee 项目管理」，它带一段 `gitee-role` 的 system prompt context。
档位**不是安装时选的**，而是每次取数按 token 在 Gitee 云端的角色现算：

| 档 | 谁 | MCP 工具 | 范围 |
|---|---|---|---|
| 管理者 | 企业拥有者 / 超管 / 管理员 | 55 | 跨项目组合分析、全部工作项与合并请求 |
| 负责人档 | 某项目的负责人 | 48 | 该项目范围内的分析与工作项 |
| 执行档 | 其他人 | 40 | 只给本人相关的工作项 |

换企业、换 token 会即时改档；档位决定「工具给不给你」（默认硬拒绝，配置 `enforceTier: false` 可关掉本地这层），
权限边界仍在云端。只读部署下三档的写工具**一律硬拦**。

## 缓存与时效

- **读路由 30 秒 TTL 缓存** + 执行器 60 秒 memo，两层都带单飞（同一 key 同时只有一个在飞），
  写成功后一起失效 —— 重复点开同一个项目是命中，不是再起一个子进程。
- **快照**：看板数据会留一份带 `fetchedAt / ageSeconds / stale / ttlSeconds` 的快照，
  新鲜期默认 60 秒（最小 10，`0` = 关闭缓存），可落盘到 `$DSH_HOME/.gitee-chat/cache/board/`，重启后首屏不用冷启。
- **可选的定期后台刷新**：只在最近有人看面板时才真去拉，闲置超过设定分钟数就停，避免白转和限流。
- **设置页（设置 → Gitee 企业项目）**里三块：token、当前企业、**缓存与后台刷新**
  （agent 可读快照 / 落盘 / 新鲜期秒数 / 后台刷新开关 + 间隔秒 + 空闲分钟）。
  这些值写在 `$DSH_HOME/.gitee-chat/config.json`（本地覆盖，压过插件补丁里的静态值），**保存即生效，不用重启**。
- 慢请求会打一行 `[gitee-chat][slow]`；`GITEE_CHAT_TRACE=1` 全都打。

## 换一台机器 / 换一个同事

这个包**不含**任何「本机 / 本公司」的硬编码，下面这些都能从配置或环境变量覆盖：

| 你会遇到的东西 | 它从哪来 | 怎么改 |
|---|---|---|
| 企业 id | `$DSH_HOME/.gitee-chat/config.json` | 界面「设置 → Gitee 企业项目 → 当前企业」里选（推荐，立即生效），或 `gq enterprises --use <id>`，或配置 `enterpriseId`，或环境变量 `GITEE_ENT_ID` |
| 企业版 token | 环境变量或 `$DSH_HOME/.gitee-chat/token` | 三种变量名任选其一；插件取数与 MCP 子进程**都按同一条顺序读它** |
| API base | 配置 `apiBase` | 私有化部署时改它 |
| User-Agent | 脚本内置默认值 | 配置 `userAgent` 或 `GITEE_ENT_USER_AGENT` |
| 分析阈值 | 脚本里的具名默认值 | 配置 `thresholds` 或 `GITEE_CHAT_*` 环境变量；**「标签数 = 3」是本团队的约定**，别人家设 2/4，或设 0 关闭 |
| 缓存与后台刷新 | `$DSH_HOME/.gitee-chat/config.json` 的 `cache` / `autoRefresh` | 设置页里点，或直接改这两个键 |
| 哪些 preset 算 Gitee 预设 | **按事实判定**：读 preset 组合，看有没有挂 `dsh-gitee-chat/agent` | 也可用配置 `presetIds: [...]` 显式列出；判定与 preset 名字无关。**这只影响工具呈现，不再影响面板可用性** |
| MCP 可执行文件 | **随包分发**（`vendor/mcp-gitee-ent/`，linux + windows amd64），安装时自动落地到用户级 bin（Linux/macOS `~/.local/bin`，Windows `%USERPROFILE%\.local\bin`） | 什么都不用做。本平台未随包（arm64 / macOS）时才需 `go install`，或用 `MCP_GITEE_ENT_BIN` 指到已有二进制 |
| 知识库文档缓存 | 配置 `docs.root`，默认 `$DSH_HOME/gitee/docs` | 改 `docs.root`（支持 `~`）；**文档的端点不在这里配**，唯一实现是 MCP |
| MCP 文档工具名前缀 | 配置 `docs.mcpToolPrefix`，默认 `mcp__gitee_ent__` | 只有改了 preset 里 `mcp-gitee` 行的 `serverName` 才需要动它 |

已知的**不**可移植之处（刻意保留）：预设的 `agent.cordis.yml` 是从官方 `standard` preset
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
node scripts/render-check.mjs   # 只跑卡片渲染（产出 .tmp/preview/board-preview.html，可直接用浏览器打开）
```

CI（`.github/workflows/check.yml`）在 ubuntu + windows 上跑同一条 `pnpm run check` 全量链。
**冒烟测试绝不真的写 Gitee**：写通道用桩执行器验证，路由层只验「只读部署被拦」这类门禁。

## 文档索引

| 文档 | 给谁看 |
|---|---|
| [`USAGE.md`](./USAGE.md) | **使用者**：界面怎么用、出问题怎么办、想改什么跟 AI 说 |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | **AI**：安装 / 配置 / 诊断的四步流程与硬规则 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | **开发者**：构建、自检、代码结构、提交规范 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 每个版本改了什么 |
| [`SECURITY.md`](./SECURITY.md) | 安全问题怎么报（不要开公开 issue） |

设计说明、决策记录、功能清单、能力矩阵这类**内部资料不入库**，随发布物只带上面这几份对外文档。
