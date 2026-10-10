# dsh-gitee-chat

[![npm](https://img.shields.io/npm/v/dsh-gitee-chat.svg)](https://www.npmjs.com/package/dsh-gitee-chat)
[![CI](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml/badge.svg)](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.2-4a6cf7.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![license](https://img.shields.io/npm/l/dsh-gitee-chat.svg)](./LICENSE)

> 会话内的 Gitee 企业项目管理：**模型只触发，脚本去拉数，卡片在对话里画图**。
> 不做侧边栏，不维护本地数据库。

## 它解决什么

之前的做法要么得开侧边栏看板，要么把整坨 JSON 塞进模型上下文。这个包把两件事拆开：

```
模型调用 gitee_board              ← 只触发一次
     │
     ├─→ gq 脚本拉 Gitee 企业版 API   ← 数据由后台脚本取，字段已裁剪
     │
     ├─→ 模型只拿到 summary 摘要      ← 几十~一千 token，与数据量无关
     │
     └─→ 卡片直接找宿主路由要全量数据  ← 不经过模型，想画多少画多少
```

一句话：**上下文占用与数据量解耦**。一千个工作项和十个工作项，模型看到的摘要一样长。

## 安装 —— 让 AI 装，你不动手

这个包自带一个 **skill**（`skills/dsh-gitee-chat/SKILL.md`），它会教 AI：
**探测环境 → 只问探测不出来的 → 写配置 → 自检**。所以正常装法是说一句话：

> 帮我装 `<本包目录>` 这个 Gitee 插件，配置项你问我。

AI 随后会探测插件侧
（token 在不在、有几个企业、MCP 在不在、哪个 profile 装了本插件），
**只问三个它猜不到的**（用哪个企业 / 能不能直接改数据 / 规范要求几个标签），
把答案写进 profile 的 `cordis.patch.yml`（**只替换本插件那一段**，别人的配置原样保留、改前先备份），
装好 preset，最后自检并把结论告诉你。**配置类改动会热重载，通常不用重启**；
只有改到插件代码时它才会让你重启 `dsh web`。

使用者视角的完整说明见 [`USAGE.md`](./USAGE.md)。配置项逐个的解释见本文末尾
「换一台机器 / 换一个同事」。

### Windows：一个 cmd 脚本装好 Node + DSH + 本插件

同事的新机器上，先 clone 本仓库，然后在仓库里跑一句：

```bat
git clone https://github.com/huayuguo/dsh-gitee-chat.git
cd dsh-gitee-chat
scripts\install-dsh.cmd
```

它把整条链装完（外加把环境变量在当前窗口刷好）：

1. **检测 Node**（要 `^22.19 || >=24`）：先找机器上的 `node`；没有就**优先用桌面应用自带的 runtime**（`%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\...`）；两份都没有才用 `winget` 装 LTS，**没有 winget 就直说**，让你去 <https://nodejs.org/en/download> 点一下再重跑 —— 不假装自己能装
2. **先把注册表里的 PATH 刷进当前窗口**，非桌面 profile 再补上 npm 全局 bin 目录（`dsh` 就落在这里）—— 所以装完不用重开终端，也不用手工改 PATH
3. **找 dsh CLI**：桌面版**不装全局 dsh**，直接用**应用自带**的 `<应用>\resources\runtime\cli\bin\dsh.cmd`（全局装的 dsh 会拒绝 `--profile desktop`）；只有 `dsh web` / 独立版缺了才 `npm install -g @deepseek-ai/dsh@latest`，然后验收 `node -v` / `npm -v` / `dsh --version`
4. **pnpm**：有应用自带 runtime 就直接用它的 `pnpm.mjs`（固定带 `--config.confirmModulesPurge=false --config.minimumReleaseAge=0`），非桌面机缺了才 `npm install -g pnpm` —— `dsh plugin add` 要在 profile 目录里调它，真机上没装就是 `dsh: pnpm failed in profile directory`
5. **构建本插件**（`lib/` 不入库）：`npm install --legacy-peer-deps` + `npm run build`
6. **`remove` 再 `add "file:<仓库>"`**：`file:` 是**副本**，升级必须重新 add（没有自动更新）；**profile 装错是静默失效**：桌面版只有 `desktop`，`dsh web` 默认 `web`（`install-dsh.cmd` 自动挑，也可用 `GITEE_CHAT_DSH_PROFILE` 指定）；`file:` 真目录装法，别用 `link:`
7. **写默认配置、清残留、自检**：`setup.mjs apply`（幂等、带备份、全默认值）→ `setup.mjs repair`（去掉插件市场留下的半状态行）→ `verify`。
   verify 是报告：新机器上报「还没有 Gitee token」是预期，不算装失败

```bat
scripts\install-dsh.cmd https://registry.npmmirror.com    :: 国内网络慢时换源
```

> 为什么是 `.cmd` 而不是 `.ps1`：很多受管机器默认 `ExecutionPolicy` 是 Restricted，
> `.ps1` 会被直接拒绝执行（"running scripts is disabled"）；批处理没有这个策略，也不依赖
> PowerShell。脚本内容**纯 ASCII**（非 ASCII 的 `.cmd` 在 936 代码页下会变乱码）。

#### 装完之后：脚本会顺手处理 PowerShell 的脚本策略

真机实测（Node 24.19.0 + npm 11.17.0）。如果你在 PowerShell 里敲 `dsh -V`
看到下面这句，那不是装失败 —— 是 npm 的 shim 撞上了策略：

```
dsh : 无法加载文件 C:\Users\<你>\AppData\Roaming\npm\dsh.ps1，因为在此系统上禁止运行脚本。
```

npm 的全局 shim 有三份（`dsh`、`dsh.cmd`、`dsh.ps1`）：**PowerShell 优先挑 `.ps1`**，
而默认策略拦它；cmd.exe 挑的是 `dsh.cmd`，所以脚本自己那步验收是通的。
**脚本现在会自己处理**（`install-dsh.cmd` 第 5 步），口径是窄的：

- 只把**出厂默认**的 `Restricted` 提到 `RemoteSigned`，**只作用于当前用户**（不需要管理员）；
- **`AllSigned` 不动** —— 那是有人故意选的更严档位，脚本只提示，不替谁放宽；
- 被**组策略**压着时改不动，脚本会把作用域表打出来并提示改用 `dsh.cmd`；
- 5.1（`powershell.exe`）与 7（`pwsh.exe`）**策略存储互相独立**，两个都探。

改完如果**当前那个窗口**还报同样的错，关掉重开一个（策略按进程读）。手工口径：

```powershell
Get-ExecutionPolicy -List      # 看 MachinePolicy/UserPolicy 是不是 Undefined
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Set-ExecutionPolicy -Scope CurrentUser Undefined     # 撤销
```

#### 卸载 / 复位：`uninstall-dsh.cmd`

装完想撤销，或反复测安装脚本时把机器复位：

```bat
scripts\uninstall-dsh.cmd                  :: 全清：dsh、Node、相关文件夹、策略
scripts\uninstall-dsh.cmd --keep-node      :: 机器本来就有 Node 时只清 dsh
```

它是 `install-dsh.cmd` 的严格逆操作：`npm uninstall -g @deepseek-ai/dsh` →
winget 卸 Node（同 `OpenJS.NodeJS.LTS`，会弹 UAC）→ 删三个文件夹（npm 全局前缀
`%APPDATA%\npm`、npm 缓存 `%LOCALAPPDATA%\npm-cache`、DSH 家
`%USERPROFILE%\.dsh`）→ **把上面第 5 步提上去的策略放回出厂**：`CurrentUser`
的 `RemoteSigned` 改回 `Undefined`，生效策略回落到客户端默认的 `Restricted`
（不执行 .ps1）。口径同样窄：`CurrentUser` 不是 `RemoteSigned` 就不碰（那不是
装出来的）；5.1 与 7 两套存储各还各的；本仓库目录一概不动，要干净源头直接
重新 clone。唯一的含糊处：分不清 `RemoteSigned` 是不是 install 提的——要是你
自己设的，被撤掉后重设一句
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 即可。

#### 再用 DSH 装本插件（手工分步时）

`install-dsh.cmd` 已经把下面几步全做了；脚本某步失败要单独重跑时，手工走
（`lib/` 是构建产物、不入库，用 `file:` 真目录装法，
别用 `link:`）：

```bat
npm install -g pnpm
npm install --legacy-peer-deps
npm run build
dsh plugin --profile desktop remove dsh-gitee-chat
dsh plugin --profile desktop add "file:C:\path\to\dsh-gitee-chat"  :: desktop for the desktop app; web for dsh web
node scripts\setup.mjs apply      :: 写配置（企业 id 留 0 = 自动识别）
node scripts\setup.mjs repair     :: 清插件市场留下的半状态行
node scripts\setup.mjs verify     :: 自检
```

> **桌面版把 `dsh` 换成应用自带的 CLI**：全局装的 dsh 会拒绝 `--profile desktop`
> （*managed exclusively by the Electron application*）。路径是
> `<应用目录>\resources\runtime\cli\bin\dsh.cmd`（`install-dsh.cmd` 会自己找到并打印）；
> 等价的手工入口是应用里的「设置 → 插件 → 添加插件」，填 `file:C:\path\to\dsh-gitee-chat`。
> **升级 = `remove` + `add`**：`file:` 是副本，没有自动更新。

> **补丁文件有两个**：本包通过 `dsh.bundle.patch` 交付根 `cordis.patch.yml`（纯 insert，
> 只声明 host 行）+ `cordis.skills.patch.yml`（skill provider，必须带 config），外加两个
> `presets/gitee-*.patch.yml`。为什么拆开。

> 别把上面几条用 `&&` 连成一行：Windows PowerShell 5.1 不支持 `&&`，整行直接
> 解析错误，一条都不会执行（2026-09-22 真机）。

> 第 4 步报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`（`Lockfile failed supply-chain
> policy check`）：profile 锁文件里有 **24 小时内刚发布**的包，pnpm 11 的供应链校验
> 默认拦下。给那条命令补一个 `--config.minimumReleaseAge=0` 即可
> （实测通过；**别去改 profile 的 `minimumReleaseAgeExclude` —— 校验期不看它**）。
>

> 顺带一提：`npm install -g` 的输出里会有 5 条 `allow-scripts` 警告（npm 11 起的安装脚本
> 门禁，`node-pty` / `koffi` 等）。**实测对本插件与 DSH 无影响** —— 原因。

### 从发行包安装（npm / GitHub Release / Gitee Release）

本插件以三种「包」的形式对外，按网络可达性挑一个（都是同一份 `npm pack` 产物 ——
`files` 白名单 + `prepare` 构建，拿来即用）：

```sh
# ① npm 官方源（推荐；DSH 的标准安装就是它）
dsh plugin --profile desktop add dsh-gitee-chat

# ② GitHub Release 附件（国内直连 GitHub 不稳时的首选）
dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.1/dsh-gitee-chat-0.5.1.tgz"

# ③ 直接从 git 装（会现场跑 prepare 构建，需要能装 devDependencies）
dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.1"
```

**关于国内镜像**：npm 只往**官方源**（`registry.npmjs.org`）发一次；npmmirror / 腾讯云 /
华为云这些**都是只读镜像**，会自动从官方源同步 —— **不要往镜像发**（也发不上去）。
国内同事装的时候换源即可：

```sh
npm config set registry https://registry.npmmirror.com     # 或临时：npm i --registry=…
```

需要立刻同步某个包时，可以用镜像站的同步接口（npmmirror 形如
`PUT https://registry.npmmirror.com/-/package/<包名>/syncs`；具体以镜像站文档为准）。

> **`dsh-gitee-chat/client` 这个入口只给 DSH web 运行时用**：`lib/client.js` 是
> `window.__ModuleLoader__.load({…})` 形态的浏览器侧 bundle，在 Node 里 `import` 会
> `window is not defined`。Node 侧请只用 `.`（host 半）与 `./agent`（preset 半）。

### 手工安装（AI 不在时）

```sh
cd /path/to/dsh-gitee-chat
pnpm install
pnpm run build                    # 产出 lib/index.js（host）+ lib/client.js（client）

dsh plugin --profile desktop add "$(pwd)"   # 桌面版用 desktop；`dsh web` 用 web
# 硬刷新浏览器（Ctrl/Cmd+Shift+R）；只改配置不用重启，改过 lib/ 才要重启 dsh web

npm run setup -- detect           # 看看环境里还缺什么
npm run setup -- apply --answers '{"enterpriseId":0,"allowWrites":true}'   # 写配置
npm run setup -- verify           # 自检
```

`npm run setup -- apply` 同样只动本插件那一段，幂等，可反复跑；
`--dry-run` 可以先看将要写入的差异。

> **`pnpm-workspace.yaml` 里的两个键不能删**（删了 `pnpm install` 就挂，真机实测）：
> `autoInstallPeers: false` —— `@deepseek-ai/dsh-*` 这些 peer 由 **DSH 的依赖闭包**在运行时
> 提供，registry 上没有对应版本的独立包，pnpm 默认会去装 → `ERR_PNPM_NO_MATCHING_VERSION`；
> `allowBuilds.esbuild: true` —— pnpm 10 起默认不跑依赖的构建脚本，不放行就以
> `ERR_PNPM_IGNORED_BUILDS` 退出 1。这个键必须是**真布尔值**：文件里原本躺着 pnpm 自己
> 生成的占位串 `set this to true or false`，谁也没填，于是"照着 README 走"就卡在第一步。
> 用 npm 的话等价物是 `npm install --legacy-peer-deps`（跳过 peer 自动安装）。

> **`npm run check` 需要能解析到 harness 的包**（它要 import 本包的 agent 半）。
> 从零克隆时 `node_modules/@deepseek-ai` 并不存在 —— 用 `link:` 装法跑一次
> `node scripts/setup.mjs apply` 会自动补上那一跳（这就是上面说的「补一跳」），
> 也可以手工指过去：
>
> ```sh
> ln -s "${DSH_HOME:-$HOME/.dsh}/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
> ```

> **兼容策略：跟随最新 DSH，不背旧版。** `package.json` 的 `engines.dsh` 与
> `@deepseek-ai/dsh-*` 的 peer 范围都写在当前 release 线上（当前 `^0.2.0-rc.2`），
> 老 harness 会被市场拒绝安装。**升级 DSH 之后跑一次 `npm run check`**：
> 它会把 peer / `engines.dsh` 该改成的值直接打出来（不跟着改就报错）——
> 原因是 npm 的 peer 规则按 `major.minor.patch` 元组放行预发布版，
> 范围一旦落后就会**静默排除**新版 harness。升完之后顺手跑一次
> `dsh plugin --profile <profile> list`：只要还打印
> `Plugin dsh-gitee-chat@x.y.z is incompatible with dsh …`，就说明范围还没跟上
> （表现是启动日志里 `skipping profile bundle "dsh-gitee-chat"` —— 插件整个不加载，
> 标签页和工具一起消失）。

> **`link:` 装的坑（2026-09-21 同事机实测）**：`dsh plugin add <本包目录>` 记的是
> `link:`，插件模块的 realpath 就落在 `$DSH_HOME/profiles/**` 之外，Node 的父目录
> 回溯够不到 DSH 的依赖闭包（`$DSH_HOME/profiles/node_modules`）—— agent 半那句
> 运行时裸导入（`@deepseek-ai/dsh-tools`）会 `Cannot find package`。它**只在起会话
> 组装 preset 时**加载，所以装完、启动都正常，症状是**「选了工作区没反应」**
> （会话建不起来，前端静默退回）。`npm run setup -- apply` 会探针 + 自动补一跳；
> 想彻底避开，用真目录装法：
>
> ```sh
> dsh plugin --profile <profile> add "file:$(pwd)"
> ```
>
> 代价：`file:` 是副本，改完 `lib/` 要重新 add 一次才生效 —— 所以**开发时**用
> `link:` + `apply` 自愈，**发给同事**用 `file:`。

> 如果 `dsh plugin add` 被 pnpm 供应链策略拦住（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`），
> 那是 profile 里既有条目触发的最小发布年龄策略，与本包无关。临时做法：把本包软链进
> `$DSH_HOME/profiles/web/node_modules/`，并在 profile 的 `package.json` 里把
> `dsh-gitee-chat` 加进 `dependencies` 与 `dsh.profile.bundles`。

## 配置 token

**界面里就能配（推荐）**：

- 应用「**设置 → Gitee 企业项目**」—— 与「插件市场」并列的那个设置分节，填 token 点保存即可；
- 这是**唯一**的界面入口（会话里的「Gitee 项目」标签页没有配置入口：没配 token 时那个标签页
  本来就打不开，配置项挂在它里面是个死循环）。

它写的是下面第 2 条那个文件；存完即时生效（gq 脚本每次调用都现读）。

取数脚本按优先级解析：

1. 环境变量 `GITEE_ENT_MCP_ACCESS_TOKEN`（或 `GITEE_ACCESS_TOKEN` / `GITEE_TOKEN`）
2. 文件 `$DSH_HOME/.gitee-chat/token`（内容为纯 token）
3. 文件 `$DSH_HOME/gitee-chat-token`、`~/.gitee-token`

这份顺序有**两处独立实现**，必须一致：`scripts/gitee/gq.mjs`（插件取数、标签页、体检）与
preset 里 `mcp-gitee` 行的 `env`（MCP 子进程）。所以**在界面里填一次就够**，
MCP 通道也会去读那份文件。两个容易踩的点：

- **桌面版 DSH 从开始菜单 / 资源管理器启动时不继承 shell 里 `export` 的变量**（只继承注册表里的
  用户/系统变量），从终端起 `dsh web` 才会带上当前 shell 的变量 —— 这就是「网页版能用、
  桌面版说没有 token」的常见原因。界面写入的文件两条路都读，所以**优先用界面填**。
- 环境变量那一路对**已经挂载的 MCP 子进程**要重启 DSH 才生效（子进程只在挂载时读 env）；
  token 文件那一路 gq 每次调用现读（界面保存即时生效），但 MCP 子进程仍要重启才会重读文件。

自检：

```sh
node scripts/gitee/gq.mjs health   # token / 企业 / 连通性
node scripts/gitee/gq.mjs role     # 我是谁、什么人格、这个档能做什么
node scripts/gitee/gq.mjs matrix   # 三档能力矩阵全文（人评审用）
```

注意：Gitee 企业版端点要求 `Authorization: Bearer <token>` **加** MCP 同款 User-Agent，
两者缺一会返回 `Only For MCP Gitee Enterprise Application` —— 脚本已内置，自行 curl 时别漏。

## 界面

会话里有一张**看板卡片**（贴着那次工具调用），以及整屏的「**Gitee 项目**」标签页
（与 对话 / 轨迹 / 上下文 并列的第 4 个，版式与「上下文」一致）。

标签页自己拉数据（挂载即拉 + 右上角「刷新」），**全程不经过模型**，所以数据多大都不占上下文：

| 页签 | 内容 |
|---|---|
| 项目 | 企业 KPI 统计条 · 左侧项目列表 · 右侧工作项表（未完成/逾期/全部 筛选）· 点行下钻 |
| 固定分析 | 9 张卡片：项目健康度 / 成员负载 / 延期清单 / 停滞 / 规范体检 / 进度偏差 / 交付容量 / 里程碑达成 / 交付趋势 |

点任意工作项进入**详情面板**：描述（Markdown 渲染）、**前置依赖**（区分已完成 / 未完成，并明确说谁卡住了本项）、
**评论中的讨论**，以及**直接操作**：改状态、改派、发评论。

「固定分析」全部由 gq 脚本计算（同一输入永远得到同一输出），阈值随数据下发；需要判断力的部分
（WBS 合理性、风险根因、复盘）才交给模型，且必须基于这些事实。

### 前置依赖的两种写法

描述里的「## 前置依赖」既可能写 Gitee 编号（`IK90004`），也可能写 **WBS 编码**
（`- ME-02 结构布局确定`）。后者靠工作项标题前缀 `【DEMO900-ME-02】` 反查，短码按
`-` 分段做后缀匹配。**两种都认** —— 只认编号的实现会把「有 3 个前置项」显示成
「写着没有前置依赖」，比不显示更糟。

## 工具与路由

| 面 | 名字 | 说明 |
|---|---|---|
| 工具 | `gitee_board` | 拉取看板数据；模型只得到摘要，卡片负责渲染 |
| 工具 | `gitee_role` | 解析当前 token 的身份、人格与能力档（管理者 / 项目执行·负责人档 / 执行档） |
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

### `gitee_ent`：Gitee 企业 MCP 是公共工具

48 个 MCP 工具不限于 Gitee 模式：任意会话（PTC、随便什么 preset）都能通过一个工具调到：

```text
gitee_ent(op:"list")                                  # 目录：工具名 + 首行说明，写工具带 ✎
gitee_ent(op:"schema", name:"list_enterprise_issues") # 这一个工具的参数说明
gitee_ent(op:"call",   name:"…", args:{…})            # 真正调用
```

两级暴露是为了省上下文：48 个工具的完整 schema 约 **14.6K tokens/请求**，而常驻的 gateway 说明
只有约 **0.4K**，目录（只在实际用时进上下文）约 1.1K，单个工具的参数说明约 100–150 tokens。
为什么不用 DSH 原生的 `deferLoading`：它「声明了也不会激活」，且 MCP 客户端没法把工具标成延迟加载。

Gitee 模式的会话不受影响：那里仍然用原生 `mcp__gitee_ent__*`（gateway 在 Gitee 作用域里被隐藏），
能力档门禁（管理者 / 负责人档 / 执行档）一字未改。只读部署（`allowWrites: false`）下 `gitee_ent`
会硬拦 20 个写工具，**Gitee 模式内外一个口径**。真正的权限边界始终在 Gitee 云端：能不能改，
取决于 token 的身份（拿不到就是 403/404），本地这层是「不给误操作的承诺」，不是安全边界。

### skill 是怎么加载的

skill **就在本包里**（`<包>/skills/dsh-gitee-chat/SKILL.md`），由本包自己的
`cordis.skills.patch.yml`（`dsh.bundle.patch` 里的第二个文件；单独一个文件，因为
`cordis.patch.yml` 必须保持纯 insert）按**插件标准**挂一个 `skill-filesystem` provider 指向它 ——
不往 `$DSH_HOME/skills` 拷文件。要点（实测）：

- `!!js` 里的 `baseUrl` 是 **profile 目录**，所以表达式按**包名** `dsh-gitee-chat` 解析，
  换机器 / 换 profile 都不用改。
- **必须换 `providerName`**：`dsh-base` 已经挂了一个名为 `filesystem` 的 provider，
  同名会让整棵插件树启动失败。
- **解析失败 fail-soft**：手工拷 `lib/` 而没注册 bundle 时 `resolve()` 会抛，
  那会让整个 DSH 起不来 —— 所以回落到一个不存在的路径。
- `customSkillDirs` 的元素是**根目录**（其下每个子目录一个 `SKILL.md`），
  且 `!!js` 必须返回**字符串**（返回数组会变成 `[[path]]`，schema 直接报错）。
- 结果对**所有 preset 可见**（安装它的那段对话本身就能用上），且**热加载，不用重启**。

### 写回通道

所有改动都从 `src/host/write.ts` 的 `createIssueWriter().write()` 出去，**全包唯一的写出口**。
只有三种操作被允许：`set-state` / `comment` / `assign`。评论正文走子进程 stdin（不塞 argv）。

界面不做乐观更新：写完重新拉一次详情，看到的就是服务端真值。
`allowWrites: false` 的只读部署会明确说「写通道已关闭」，而不是给一堆点了会失败的按钮。

> 模型侧的写操作走它自己的 MCP 工具（`update_enterprise_issue` 等），那是**另一个平面**、
> 另一条通道，故意不复用：MCP 工具受能力档门禁约束，而 UI 只做最小写集合。

## 换一台机器 / 换一个同事

这个包**不含**任何「本机 / 本公司」的硬编码：企业 id、API base、User-Agent、阈值、
token 位置全部可以从配置或环境变量覆盖。换环境时按下面走一遍：

```sh
npm run doctor      # 可移植性体检（preset 交付 / 插件行 / 产物 / MCP / token / 企业）
npm run build
npm run presets:check   # preset 随 bundle 补丁交付，这里只做交付自检
```

| 你会遇到的东西 | 它从哪来 | 怎么改 |
|---|---|---|
| 企业 id | `$DSH_HOME/.gitee-chat/config.json` | 界面「设置 → Gitee 企业项目 → 当前企业」里选（推荐，立即生效），或 `gq enterprises --use <id>`，或配置 `enterpriseId`，或环境变量 `GITEE_ENT_ID` |
| 企业版 token | 环境变量或 `$DSH_HOME/.gitee-chat/token` | 三种变量名任选其一；界面「设置 → Gitee 企业项目」写的就是文件那份，插件取数与 MCP 子进程**都按同一条顺序读它**。桌面版不继承 shell 的 `export`，所以文件那条路更可靠 |
| API base | 配置 `apiBase` | 私有化部署时改它 |
| User-Agent | 脚本内置默认值 | 换 MCP 版本/平台时用配置 `userAgent` 或 `GITEE_ENT_USER_AGENT` |
| 分析阈值 | 脚本里的具名默认值 | 配置 `thresholds` 或 `GITEE_CHAT_*` 环境变量；**「标签数 = 3」是本团队的约定**，别人家设 2/4，或设 0 关闭 |
| 哪些 preset 算 Gitee 模式 | **按事实判定**：读 preset 组合，看有没有挂 `dsh-gitee-chat/agent` | 也可用配置 `presetIds: [...]` 显式列出；判定与 preset 名字无关 |
| MCP 可执行文件 | **随包分发**（`vendor/mcp-gitee-ent/`，linux+windows amd64），安装时自动落地到**用户级 bin**（Linux/macOS `~/.local/bin`，Windows `%USERPROFILE%\.local\bin`） | 什么都不用做。Windows 上该目录默认不在 PATH（preset 用绝对路径，不受影响）；想让别的 MCP 客户端也能直接调 `mcp-gitee-ent`，把该目录加进 PATH。本平台未随包（arm64/macOS）时才需 `go install`，或用 `MCP_GITEE_ENT_BIN` 指到已有二进制 |
| **知识库文档缓存** | 配置 `docs.root`，默认 `$DSH_HOME/gitee/docs` | 改 `docs.root`（支持 `~`）。**注意：文档的端点不在这里配** —— 唯一实现是 MCP |
| MCP 文档工具名前缀 | 配置 `docs.mcpToolPrefix`，默认 `mcp__gitee_ent__` | 只有改了 preset 里 `mcp-gitee` 行的 `serverName` 才需要动它 |

已知的**不**可移植之处（刻意保留，属于个人/部署配置，不放进包里）：

- `presets/*/agent.cordis.yml` 是从官方 `standard` preset 复制的 283 行组合快照。
  DSH 版本升级后官方 preset 若有变化，需要重新同步 —— `doctor` 会检查组合里引用的插件行能否解析。
- 每个 preset 里的 `--enabled-toolsets` 列表由 `scripts/gen-capabilities.mjs` 从 `TIERS` 生成，
  `npm run capabilities:check` 会挡住漂移；如果同事的 MCP 版本工具集不同，改 `TIERS` 后重新生成。
- 界面文案只有中文（未接 `ctx.locale`）。

## 验证

```sh
npm run check                  # 一站式：smoke + render-check + 能力矩阵 + preset + types + 随包 MCP
node scripts/smoke.mjs         # 只跑 host 半
node scripts/render-check.mjs  # 只跑卡片渲染
```

CI（`.github/workflows/check.yml`）在 ubuntu + windows 上跑同一条 `pnpm run check` 全量链。

- `smoke.mjs`：host/agent 平面纪律、工具、路由、缓存、栅栏、能力档推导与门禁、
  两批固定分析（含确定性）、描述模板解析（编号 / WBS 编码 / 链接 / 「无」）、
  **写通道**（参数形状 / 正文走 stdin / 越权与超长在到达脚本前被拒 / 只读降级）、
  可移植性（preset 判定与命名解耦、`presetIds` 覆盖），
  **skill 的挂载方式**（补丁行 / frontmatter / `!!js` 的成功与 fail-soft 两条分支，
  用一个临时的"假 profile"验证解析结果真的指向本包 `skills/`），
  以及 `setup.mjs` 的四个动词能跑、每个问题都有兜底值。
  **冒烟测试绝不真的写 Gitee**：写通道用桩执行器验证，路由层只验门禁。
- `render-check.mjs`：把卡片、整屏视图、9 张分析卡、详情面板、非 Gitee 降级提示
  用 `react-dom/server` 渲染并断言内容，产出 `preview/board-preview.html`（可直接用浏览器打开）。
  同时断言**界面不出现硬编码色值**（颜色必须走主题令牌）。

## 文档索引

| 文档 | 给谁看 |
|---|---|
| [`USAGE.md`](./USAGE.md) | **使用者**：怎么用界面、出问题怎么办、想改什么跟 AI 说 |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | **AI**：安装/配置/诊断的四步流程与硬规则 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 每个版本改了什么（发版必更） |

## 目录

```
src/index.ts              host 半（profile）：装配执行器、身份解析、路由、发布 giteeChat 服务
src/agent.ts              agent 半（preset）：触发型工具 + 人格注入 + 能力档门禁  ⚠️ 平面不同，必须分开
src/host/gq.ts            取数执行器：脚本执行 + 进程内缓存 + 样例降级 + stdin 支持
src/host/role.ts          身份 → 人格/能力档（进程级缓存，装配期同步取用）
src/host/write.ts         **唯一写入口**（改状态 / 评论 / 改派 / 文档页）
src/host/tools.ts         触发型工具（返回值只有摘要）
src/host/routes.ts        数据通道 /api/gitee-chat/*
src/host/trust-fence.ts   浏览器信任栅栏
src/host/mcpDocs.ts       知识库文档委派层：按会话 agent 作用域调 MCP 工具（**不实现端点**）
src/host/docCache.ts      文档按需缓存 + 页级四态判定（纯函数，可断言）
src/host/docService.ts    文档编排：列文档 / 页树 / 读正文 / 核对拉取
src/client/index.tsx      client 入口：注册 tool.call.toolview + conversation.view
src/client/ui.tsx         共享原件（卡片/卡头/分段开关/统计格/表格/Markdown 渲染）
src/client/BoardCard.tsx  卡片取数与状态机     src/client/BoardView.tsx  卡片纯展示层
src/client/GiteeProjectView.tsx  整屏标签页（项目 / 仓库 / 固定分析 / 知识库）
src/client/DocPanel.tsx          知识库面板（节点树 / 附件缓读 / 预览分工）
src/client/RepoPanel.tsx         仓库面板（两种口径的仓库列表 + 仓库 WIKI）
src/host/repoService.ts          仓库 / WIKI 编排层
src/host/wikiCache.ts            仓库 WIKI 的 git 取数与工作区软链接（唯一不走 MCP 的口）
src/client/AnalysisCards.tsx     9 张固定分析卡片
src/client/IssueDetail.tsx       工作项详情 + 写回（描述 / 前置依赖 / 评论讨论）
src/client/charts.tsx     纯 SVG/CSS 图表（零图表库依赖）
scripts/gitee/gq.mjs      取数脚本（零依赖 Node ESM）
scripts/gitee/analysis.mjs 固定分析纯函数（两批，可独立单测）
scripts/check-presets.mjs preset 交付自检 + `--doctor` 可移植性体检（preset 写进 bundle 补丁，不从用户根加载）
scripts/setup.mjs         detect / questions / apply / verify —— AI 靠它做到使用者无操作
skills/dsh-gitee-chat/SKILL.md  教 AI 怎么装、怎么问、怎么改配置（随包分发）
USAGE.md                 使用者视角的用法与排错
```

