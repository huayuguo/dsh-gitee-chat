---
name: dsh-gitee-chat
description: 安装/配置/诊断「Gitee 企业项目管理」这个 DSH 插件，并交付会话内的项目看板、固定分析、工作项详情与写回。当用户说「装这个 Gitee 插件」「配一下 Gitee 项目」「换成我们公司企业」「取不到数据」「怎么只看不改」「阈值不对」时使用。核心要求：**你检查、你问、你写配置，使用者不打开任何文件**。
---

# 安装与配置 Gitee 企业项目管理插件

这个插件的**全部可配置项都能由你写进配置**，使用者不需要打开编辑器、不需要改环境变量、
不需要手工步骤（配置改完会热重载，通常连重启都不需要）。你的职责是：

**探测 → 只问探测不出来的 → apply → verify**

```
detect  →  questions  →  apply  →  verify
（插件事实） （只问不知道的）  （写配置）  （自检并交代）
```

命令都在插件包根目录下执行（用户把仓库路径给你时，`cd` 过去）：

```sh
node scripts/setup.mjs detect                 # 插件侧事实（JSON 加 --json）
node scripts/setup.mjs questions              # 该问什么（带推荐默认值）
node scripts/setup.mjs apply --answers '<json 或 @文件或 ->'  # 写配置
node scripts/setup.mjs verify                 # 自检 + 人类可读结论
```

**Windows 上，DSH 本身还没装**（`dsh --version` 报找不到、或没装 Node）时，跑随包的
cmd 脚本 —— 一条命令装全套：Node（先找机器上的，再找**应用自带 runtime**，都没有才 winget）
→ dsh CLI（**桌面版用应用自带的** `<应用>\resources\runtime\cli\bin\dsh.cmd`，不全局装；
只有 `dsh web` / 独立版才 `npm install -g @deepseek-ai/dsh`）→ pnpm（优先用自带 runtime 的
`pnpm.mjs`）→ 构建本插件 → `remove` + `add "file:<仓库>"` 装进 desktop（或你指定的 profile）
→ 写默认配置 → `repair`（清插件市场半状态）→ 自检（顺手把环境变量刷进当前窗口）：

```bat
scripts\install-dsh.cmd
scripts\install-dsh.cmd https://registry.npmmirror.com
```

第二行的参数是国内网络慢时换源。哪步装不上脚本会直说在哪一步、为什么。
要手工分步装（脚本某步失败单独重跑）时：

```bat
npm install -g pnpm
npm install --legacy-peer-deps
npm run build
dsh plugin --profile desktop remove dsh-gitee-chat
dsh plugin --profile desktop add "file:C:\path\to\dsh-gitee-chat"   :: desktop for the desktop app; web for dsh web
node scripts\setup.mjs apply
node scripts\setup.mjs repair
node scripts\setup.mjs verify
```

（`lib/` 不入库所以先构建；`--legacy-peer-deps` 因为 `@deepseek-ai/dsh-*` peer 由
DSH 闭包提供。**别把几条命令用 `&&` 连成一行** —— Windows PowerShell 5.1 不支持
`&&`，整行直接解析错误，一条都不会执行。）

桌面版要把 `dsh` 换成**应用自带**的 CLI（全局装的 dsh 会拒绝 `--profile desktop`）：
`"C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:<仓库>"`；
`file:` 是副本，**升级 = `remove` + `add`**（没有自动更新）。

> **Windows 装完必踩的两个「假故障」**（真机实测，别当成装失败去重装）：
> 1. PowerShell 里 `dsh -V` 报 `无法加载文件 ...\npm\dsh.ps1，因为在此系统上禁止运行脚本` ——
>    npm 的 shim 有三份，PowerShell 优先挑 `.ps1`，被策略拦。
>    **`install-dsh.cmd` 的策略步骤已自动处理**：只把出厂默认的 `Restricted` 提到 `RemoteSigned`
>    （仅当前用户），`AllSigned` 与受组策略管的机器只提示、不放宽；5.1 与 7 的策略存储是两套，
>    两个都探。真不行就用 `dsh.cmd -V`。改完如果**当前窗口**还报错，关掉重开一个。
>    脚本自己的验收走 cmd 所以是通的 —— **验收通过 ≠ 用户能用**。
> 2. `npm install -g` 末尾 5 条 `allow-scripts` 警告（`node-pty`/`koffi` 等）—— 对本插件与 DSH
>    **无影响**：`node-pty` 运行时回落到随包发布的 `prebuilds/<平台>/`，`koffi` 的原生实现来自
>    `@koromix/koffi-<平台>` 可选依赖。

全部纯 JSON in / JSON out（`--json`），不要解析人话输出。

## 硬规则

1. **绝不让使用者手工编辑文件。** 你问、你写。改完按下面第 5 条的口径说要不要重启。
2. **绝不让使用者把 token 粘进对话或贴给你看。** token 只从环境变量或
   `$DSH_HOME/.gitee-chat/token` 读；`detect` 只回报**来源**（`env:XXX` / `file:/path`），
   永不回值。用户问"token 配好了吗"就跑 `verify`。
3. **企业绝不猜。** token 能看到多个企业时，`enterpriseId` 必须由使用者选定；
   插件宁可报错也不静默挑一个（拿错公司的数据比报错糟得多）。
4. **只问 `questions` 里那几项，且能推断的不问。** `detect` 已经给了默认值，
   使用者说"你决定 / 随便 / 都行"就直接 `apply`（答案可全部省略）。
5. **分清"改配置"与"改代码"**（这条最容易说错，实测口径）：

   | 改什么 | 要重启 `dsh web` 吗 |
   |---|---|
   | profile 补丁里的 **config**（`cordis.patch.yml`） | **不用** —— 组合数秒内热重载，`apply` 完直接刷新页面验证即可 |
   | 插件的**代码**（`src/` → `lib/`） | **要** —— 进程不会重新 import 模块 |
   | skill（本包 `skills/`）、preset | 不用 |

   所以 `apply` 之后**别急着说"重启"**：先刷新页面看是否已经生效，没生效再让人重启。
   反过来，只要你碰过 `lib/`，就**必须**明确说重启 —— 配置热重载会让人误以为代码也热了。
6. **绝不要把 `scriptPath: ''` 写进配置。** profile 补丁里的 `config` 是**整体替换**，
   空串会覆盖掉包内默认值，宿主于是执行 `node '' <子命令>`；Node 把空脚本名当成
   「从 stdin 读脚本」，stdin 立刻 EOF → **退出码 0、零输出**，界面上只留下一句
   「gq 输出不是 JSON：」。**要"用默认值"就整条键都不写**（`apply` 就是这么生成的），
   绝不用空串表达"默认"。同理适用于 `apiBase` / `mode` / `agentRowName`。

## MCP 后端：随包分发，别让使用者装 Go

`mcp-gitee-ent` 是「AI 能建工作项 / 改状态 / 建项目」的唯一通道。它**已经在包里**：

```
vendor/mcp-gitee-ent/mcp-gitee-ent-linux-amd64        7.7 MiB
vendor/mcp-gitee-ent/mcp-gitee-ent-windows-amd64.exe  7.8 MiB
vendor/mcp-gitee-ent/manifest.json                    ← 溯源 + sha256 + 真实工具清单
```

安装时自动落地到**用户级 bin**（POSIX `$XDG_BIN_HOME` → `~/.local/bin`；
Windows `%USERPROFILE%\.local\bin`），preset 的 `command:` 指向它。
回落链：`MCP_GITEE_ENT_BIN` → 用户级 bin → PATH 上的裸名。
替换别人的二进制前会先留一份 `<name>.bak`；Windows 上该目录默认不在 PATH
（preset 用绝对路径不受影响，别的客户端要用需手动加 PATH）。

**所以：不要因为看到 MCP 缺失就让使用者 `go install`。** 先看 `verify` / `gitee_chat_health` 报的 `note`：

| note 说什么 | 怎么办 |
|---|---|
| 「随包分发（无需 Go）… sha256 与清单一致」 | 就绪，什么都不用做 |
| 「尚未落地」 | 跑一次 `apply`（或让宿主重启）即可，**不用装 Go** |
| 「与随包清单 sha256 不一致」 | 本地那份不是随包的（多半是上游 npm 版）；删掉目标文件后 `apply` 会覆盖回随包版本 |
| 「本平台未随包」 | 只有这种情况才需要替代方案：`MCP_GITEE_ENT_BIN` 指到已有二进制，或自己 `go install` |

**为什么不用上游的 npm 包**：`@gitee/mcp-gitee-ent` 确实有平台包（机制同 esbuild），
但实测它的 0.2.1 **没有 `create_program`（建项目）**，文档工具也换了另一族。
而 `--enabled-toolsets` 是**过滤器不是校验器** —— 换错二进制**不会报错**，只会
静默少 10 个工具，使用者看到的现象是「AI 说它做不了」。所以：
不要替换 `vendor/` 里的二进制，也不要给使用者指向上游版本。

**`verify` 对 `file:` 装法报「skill 未生效 ❌」时**：这是 2026-09-21 修掉的一个误报 ——
判据原先写成"解析结果 == 源码目录"（只对 `link:` 成立），现在改判"解析出来的目录里有没有
`SKILL.md`"，并报 `installedAs`。先别再让使用者重装任何东西。

> `file:` 装法加载的是**副本**：改过 `lib/` / `scripts/` 之后必须 `remove` + `add`
> （或 `npm run build` 后重新 `add`）才会生效。

**使用者问「为什么 AI 建不了项目 / 改不了 Gitee 上的东西」时**：跑 `gitee_chat_health`
（或看 `/ping` 的 `mcp` 字段）。取数（gq 脚本）与工具调用（MCP 子进程）是**两条通道**，
取数正常不代表 MCP 能用。`matchesManifest: false` 就是二进制被换过的信号。

**二进制里有 48 个工具**（上游 v0.2.1 的 37 个 + 我们独有的 11 个，含
`create_program` 建项目）。分三档启用，由门禁按 Gitee 身份推导的档硬拦：
exec 34 ⊂ project（负责人档）41 ⊂ manager 48。两个 preset 的 `--enabled-toolsets`
**由 `scripts/gitee/gq.mjs` 的 `TIERS` 派生**（`npm run capabilities`），别手改。
（门禁只管**本插件这个 server** 的工具；同一个 preset 里别家 MCP server 的工具不归本门禁管。）

**这 48 个工具也是公共的**：host 半注册了一个全局工具
`gitee_ent`，任何 preset、任何会话都能用，不必是 Gitee 模式。用法是两级：

```text
gitee_ent(op:"list")                                  # 目录（工具名 + 首行说明，写工具带 ✎）
gitee_ent(op:"schema", name:"create_enterprise_issue") # 这一个工具的参数说明
gitee_ent(op:"call",   name:"…", args:{…})            # 调用，返回 MCP 的文本结果
```

- 为什么这样：全量 48 个工具的 schema 约 14.6K tokens/请求，常驻的 gateway 说明只有约 0.4K；
  目录与单工具说明**只在实际用时**才进上下文。DSH 原生 `deferLoading` 做不到这件事
  （「声明延迟加载工具不会使其激活」，且 MCP 客户端无法标记），所以目录是工具**内部**实现的。
- **Gitee 模式里看不到 `gitee_ent`**：agent 半会 `restrict` 掉它，那边照旧用原生
  `mcp__gitee_ent__*` 与同一套能力档门禁 —— 别在两个入口之间来回绕，Gitee 模式下用原生工具。
- **只读部署**（`allowWrites: false`）：`gitee_ent` 会拦住 20 个写工具（`src/generated/tierWrites.ts`
  是这份名单的唯一真源，`npm run capabilities` 生成）。Gitee 模式内的门禁与它是**两个独立闸门**，
  都保留。
- 找不到工具名时先 `op:"list"`（`op:"call"` 报「工具名可能不对」就是这条路）；结果超过 120 KB
  会被按 UTF-8 字节截断，需要全量数据请走路由 `/api/gitee-chat/payload`。

### 知识库文档有**两条路**，别混

| 场景 | 工具 | 内容怎么传 |
|---|---|---|
| AI 生成内容后直接挂上去 | 我们的 `attach_doc_file` → `doc_nodes/attach_file` | **base64 内容**（MCP 进程**不碰文件系统**） |
| 把本地整理好的资料批量导入 | 上游的 `upload_enterprise_document_files` → `docs/{id}/upload` | **本地文件路径**，1–20 个 zip/html/txt/md、单个 ≤6 MiB |
| 导出到本地 | 上游的 `download_enterprise_document` → `docs/{id}/export` | 写**本地**路径，md/html/pdf |
| 按层级走知识库节点树 | 我们的 `list_doc_nodes` → `doc_nodes/level` | — |
| 平铺列举 / 按关键字找文档 | 上游的 `list_enterprise_documents` → `doc_nodes/tile` · `search` | — |
| **读仓库 WIKI** | **没有 MCP 工具** —— 见下 | — |

⚠️ **仓库 WIKI 不走 MCP**：Gitee 没有任何 HTTP 接口能列它（企业 API 全 404、
开放 API `/repos/{owner}/{repo}/wikis` 是 **405**），它只有 git 形态
`{path_with_namespace}.wiki.git`。插件自己在 `src/host/wikiCache.ts` 里克隆
（这是"文档只走 MCP"这条纪律的**唯一**例外，冒烟有断言守着）。

判断一个仓库有没有 WIKI：看 `list_enterprise_repositories` 的
**`wiki_enabled_with_content`**（本企业 24 个仓库里 6 个为 true）。
注意拼克隆地址要用 **`path_with_namespace`**，不能用 `name` ——
`name=demo-docs` 而 `path=docs`、`name=demo-server` 而 `path=demoserver`，用错就是 404。

⚠️ 后两条（导入/导出）读写的是 **MCP 进程所在机器**的本地路径。它们的作用域
**由你每次调用时传的 `workspace` 参数决定**：

```
workspace = 当前会话工作区的绝对路径（不确定就先 pwd）
```

**这两条调用一律要带 `workspace`。** 目录权限就是那个工作区，工作区之外的路径
会被直接拒绝。不传的话作用域会落到 MCP 进程的工作目录上 —— 通常不是使用者想要的，
报错信息也会提示传这个参数。

两层的设计是这样的：

```
GITEE_ENT_MCP_ALLOWED_FILE_ROOTS（管理员在服务器侧钉的上限，可选）
  └ workspace 参数（你按会话传）
      └ 具体文件路径
```

所以：**使用者说"导不进/导不出"时，先确认你有没有传对 `workspace`**；
其次才看服务器侧有没有配上限。别去改 Gitee，也别让使用者去改配置文件 ——
会话级的作用域本来就该由会话自己带。

三层关系说清楚：`workspace` 是**会话级作用域**，不是安全边界（传参的是你自己）。
要真正的硬约束，才需要管理员设 `GITEE_ENT_MCP_ALLOWED_FILE_ROOTS` ——
它是上限，**参数无法放宽它**（你传的 workspace 若在上限之外会被拒）。

改文档页正文（`update_enterprise_document_page`）要带 `expected_version`：
版本已变时服务端会拒绝，这是防覆盖别人修改的设计 —— 遇到就重新读页面再改，
不要绕过。

**换平台 / 升级二进制**：

```sh
node scripts/build-mcp.mjs                                    # 默认 linux+windows amd64
node scripts/build-mcp.mjs --platforms linux/arm64,windows/arm64
node scripts/build-mcp.mjs --check                            # CI：sha256 + 工具清单 + 与能力矩阵一致
```

## 第 1 步：探测插件侧事实

```sh
node scripts/setup.mjs detect --json
```

重点看这几个字段（`problems` 非空就先解决它们）：

| 字段 | 含义 | 你该做什么 |
|---|---|---|
| `token.found` / `token.source` | token 在不在、在哪 | 不在就告诉使用者两种放法，别问他要 token |
| `mcpBinary.found` | `mcp-gitee-ent` 在不在 PATH | 不在则 MCP 工具用不了（标签页仍可用），给他 `go install` 一行 |
| `profiles[]` + `targetProfile` | 哪个 profile 装了本插件 | **配置就往它写**，别问 |
| `profiles[].currentConfig.present` | 是否已经配过 | `true` 说明是**重配**，先读回现值再问差异 |
| `skill.effective` | skill 行是否已生效（随包 + 补丁声明 + 解析到本包） | `false` 才需要管；见下面「skill 怎么加载」 |
| `presets.installed` vs `expected` | preset 是否**交付**（补丁文件在仓库里 + 列进了 bundle patch） | 缺就跑 `node scripts/check-presets.mjs`；preset 随 bundle 补丁组合，装/改完要重启 `dsh web` |
| `enterprise.list` | token 可见的企业 | `null` = 取不到（多半没 token）；长度 >1 必须问 |
| `enterprise.localFile` | 本地配置文件里的企业（改它**不用重启**） | 与固定企业区分开 |

## 第 2 步：只问探测不出来的

```sh
node scripts/setup.mjs questions --json
```

每个问题都带 `default`（推荐值）与 `ifUnanswered`（未回答时用）。逐条向使用者提问时：

- 一次问完，别来回拉扯超过一轮；能给选项就给选项。
- `essential` 只有三项：`profile`（通常 `detect` 已定，不用问）、`enterpriseId`、`allowWrites`。
- 其余（标签数、每周容量、人格模式）都是调优项，**使用者不关心就用默认值**，
  但 `requiredLabels` 值得单独确认一句 —— 它默认按「职能域 × 优先级 × 阶段」= 3 个标签
  做规范体检，**那是某个团队的约定，不是 Gitee 的规则**；别的团队务必改或设 0。

两个容易问错的点：

- **企业固定 vs 可切换**：写进插件配置（`enterpriseId`）语义上是「钉死一个」（改它热重载即生效，
  但钉死后**界面设置页里的选择不生效**，设置页会明确提示）；写 0 则交给本地配置文件决定，
  使用者可在应用「设置 → Gitee 企业项目 → 当前企业」里随时选（等价于
  `gq enterprises --use <id>`，都**不用改配置、不用重启**）。
  使用者说"我经常换"就选 0，并告诉他去设置页选。
- **`allowWrites`**：关掉 = 只读部署，详情页的改状态/改派/发评论会明确报错。
  有合规顾虑的组织选 false。

## 第 3 步：写配置

```sh
node scripts/setup.mjs apply --answers '{"enterpriseId":11111111,"allowWrites":true,"requiredLabels":3}' --json
# 或先预演：加 --dry-run 看将要写入的差异，不落盘
# 或从文件/ stdin：--answers ./answers.json / --answers -
```

`apply` 会做三件事，全部幂等：

1. **写 profile 的 `cordis.patch.yml`**：在 `# >>> gitee-chat ... >>>` 与 `# <<< gitee-chat <<<`
   两个哨兵之间插入/替换本插件的段落。**只动这一段**，文件里别人的配置原样保留；改前先备份。
2. 写 `$DSH_HOME/.gitee-chat/config.json`（企业选择，重启前就生效）。
3. 落地随包 MCP 二进制 + 跑一次 preset 交付自检（`scripts/check-presets.mjs --check`），
   然后重跑 `detect`，把残留问题回给你。

preset **不在这里装**：两个 Gitee 模式就是本包的 `presets/gitee-*.patch.yml`，
由 bundle 的 `dsh.bundle.patch` 交付、装配期组合（DSH 没有"用户根 preset 目录"这回事）。
skill 同理，随包分发、由本包自己的 `cordis.skills.patch.yml` 挂载（单独一个文件，因为
`cordis.patch.yml` 必须保持纯 insert，见下）。

返回里的 `nextSteps` 直接转述给使用者即可。

**为什么必须写进 cordis.patch.yml**：补丁在**所有 bundle 之后**应用，且同一 id 的
`config` 是**整体替换**（不是深合并）——所以 `apply` 生成的永远是完整配置，不要只写一个键。

`enterpriseId` 之外想手改某个值时，**仍然用 `apply` 重跑**（把现值读出来改一个键），
不要让使用者去编辑 YAML。

## 第 4 步：自检

```sh
node scripts/setup.mjs verify
```

它逐项检查 token / MCP / skill / preset / bundle / 补丁现值 / 真实取数连通性，
并在多企业未指定时给出明确提示。把它的输出直接给使用者（已经是人话）。

失败常见对应：

| 症状 | 原因 | 处置 |
|---|---|---|
| **启动日志 `skipping profile bundle "dsh-gitee-chat"`：工具 / 标签页 / 设置分节一起不见了** | 插件声明的 DSH peer 与当前 DSH 不同线，被 dsh 的兼容门禁**整包**拦下。注意「装得好好的」是假象：`dsh plugin list` 里照列不误，只是不加载 | 把 `package.json` 的 `engines.dsh` / peer 改到与 `dsh --version` 同元组，先跑 `npm run check`（它会打印该跟到哪一版），再 `dsh plugin --profile web list` 确认不再打印 `is incompatible with dsh …`。不要用 `allow-version` 兜（那是绕过） |
| **preset 卡片红标「加载失败」**（tooltip `<ai/dsh-mcp-client>: invalid config … env`；新会话里选不到 Gitee preset） | preset 的 MCP 行 token 表达式求值成 `undefined`，`env` 校验只收字符串 ⇒ 该行 mount 失败（**终态**，不自愈）⇒ preset 被过滤 | 重跑一次 `apply`（会写回"永远返回字符串"的表达式）；临时办法是设一个 token 环境变量并**重启 DSH**。判别：`npm run presets:check` 会用真求值器跑这些表达式 |
| `未配置 token` | 环境变量没设、文件没写 | 让他去应用「设置 → Gitee 企业项目」里填（唯一入口；标签页里没有配置入口），**不要**让他贴 token |
| `enterprise_id is invalid` / 报错要求指定企业 | 多企业且没固定 | 让使用者在应用「设置 → Gitee 企业项目 → 当前企业」里选；或 `apply --answers '{"enterpriseId":<id>}'`；或 `gq enterprises --use <id>`（不用重启） |
| 标签页显示「本会话未使用 Gitee 模式」 | ①该会话的 preset 组合里没挂 `dsh-gitee-chat/agent`；②插件的 DSH peer 与当前 DSH 不同线，读 preset 组合的接口对不上 → 判定永远是"未知" → 即使 preset 正是 gitee-manager 也这么显示 | ①用 Gitee preset 新建会话；②把插件对齐到当前 DSH 线后重启 `dsh web`；`detect` 看 `profiles[].hasBundle` |
| 标签页空白/取不到数 | host 半没重启，或 profile 没装 bundle | 重启 `dsh web`；`detect` 看 `profiles[].hasBundle` |
| **`取数失败 · gq 输出不是 JSON：`（冒号后是空的）** | 配置里 `scriptPath` 是空串 → 宿主执行 `node '' …` → 退出码 0、零输出；**症状在 JSON，病根在路径** | ① 对比 `/ping` 的 `scriptExists`，`false` 即坐实；② 从补丁里**删掉** `scriptPath` 那一行（不要改成空串）；③ 重启 `dsh web`。`detect` 若显示 `scriptPath: ''` 就是这个病 |
| 「导不进 / 导不出文档」 | 多半是**你没传 `workspace`**（或传错），导致作用域落在 MCP 进程的工作目录 | 传当前会话工作区的绝对路径；路径指的是 **MCP 所在机器**的本地路径。仅在组织另配了服务器上限时才需要看 `GITEE_ENT_MCP_ALLOWED_FILE_ROOTS` |
| 改文档页报「version changed」 | `expected_version` 过期（有人先改了） | 重新读页面拿新版本号再改；**别绕过乐观锁** |
| 设知识库权限后没生效 | 二进制若不含 fork 的 `FormValues` 分支，权限参数会被**静默丢弃** | 看 `gitee_chat_health` 里二进制的 `reportedVersion`（随包版是 `0.2.1-dsh.4`）；对不上就重跑 `scripts/build-mcp.mjs` |
| MCP 工具挂不上 | 随包二进制没落地，且 PATH 上也没有 | 跑 `apply` 或重启宿主（会自动落地）；`verify` 会写明是哪一种 |
| **会话里同时出现别的 Gitee 手册（写着「31 个工具」的那种）** | 🔴 用户级 skill 根（`~/.agents/skills/`）里若还躺着旧的 `gitee-ent` / `gitee-mcp` 手册 —— 它们说 **31 个工具**（实际 48），示例里还写着**别的企业 id**。三份手册口径不一致时，模型可能挑错那本去拼调用 | **删掉/移走它们，以本插件为准**：`mv ~/.agents/skills/gitee-ent ~/.agents/skills/gitee-mcp /tmp/`（DSH 会**立刻**重扫，见下一行）。工具数以 `gitee_chat_health` 的**实测**为准，不以任何手册为准 |
| **移走 skill 后要不要重启** | 不需要 —— skill 目录每轮都重扫（与 preset roster 同理） | 移走后在下一轮对话即生效；若目录仍列出，检查是不是**另一个 skill 根**（`~/.config/opencode/skills/` 是 opencode 的，DSH 不扫） |
| **AI 说建不了项目 / 调不到某个工具** | 🔴 二进制被换过（上游 npm 版**没有 `create_program`**，或自己 `go install` 的旧版），而 `--enabled-toolsets` 不校验只过滤 → 静默少工具 | 看 `gitee_chat_health` 的「MCP 后端」段：`matchesManifest: false` 即坐实。`rm` 掉用户级 bin 里那份（Linux/macOS `~/.local/bin/mcp-gitee-ent*`，Windows `%USERPROFILE%\.local\bin\mcp-gitee-ent*`；被替换时会留 `.bak`）后 `apply` |
| **AI 报「当前人格「管理者」不具备该操作的权限：`write` / `remember`」** | 🔴 **门禁误伤**：guard 若只看 `mcp__` 前缀，会把**同一个 preset 里别家 MCP server** 的工具（比如记忆类 MCP 的 `write`/`remember`）也剥成裸名，再拿去比 **Gitee 的**档位表 → 必然「不在本档」。此时 AI 在 Gitee 模式下**写不了记忆**，报的却是"越权改 Gitee" | guard **只审本插件的 server**（前缀跟 `docs.mcpToolPrefix` 走，默认 `mcp__gitee_ent__`）。仍报就核对 `docs.mcpToolPrefix` 与 preset 里 `mcp-gitee` 行的 `serverName` 是否一致。`enforceTier: false` 只能应急，会连"执行档不得建项目"一起放弃 |
| 规范体检把标签数报错 | 默认按 3 个标签 | `apply --answers '{"requiredLabels":<实际数或0>}'` |
| **`npm run check` 报「peer 范围 / engines.dsh 请跟到 ^x.y.z」** | 本插件的策略是**跟随最新 DSH、不背旧版**：npm 的 peer 规则只在「比较符与该版本 `major.minor.patch` 元组一致、且带预发布标签」时才放行预发布版，所以 harness 一换 patch 元组，旧范围就**静默排除**新版本 | 按报错里给的目标值改 `package.json` 的 `engines.dsh` 与 `@deepseek-ai/dsh-*` 的 peer，再跑 `npm run check`。|
| **「选了工作区没反应」/ 建会话后又回到「选择一个工作区」** | 🔴 **agent 半 import 不了**：插件是 `link:` 装的，模块 realpath 落在 `$DSH_HOME/profiles/**` 之外，Node 的父目录回溯够不到 DSH 的依赖闭包（`profiles/node_modules`）→ `Cannot find package '@deepseek-ai/dsh-tools'`。这句裸导入**只在起会话组装 preset 时**加载，所以安装与启动都看不出问题，界面是静默退回（`console.warn("new session failed:")`） | `node scripts/setup.mjs apply` 会探针并**自动补一跳**；`verify` 现在有一行「agent 半：可 import ✓」。要彻底避开改用真目录装法 `dsh plugin --profile <name> add file:<本包目录>`（代价：改完 `lib/` 要重新 add）。|
| **「知识库」分段读不出文档：提示"该会话没有加载"** | 文档取数靠 `sessionId` 解析 **agent 作用域**，会话没加载就拿不到 | 在界面里**先打开这个会话**再点「知识库」分段。`/ping` 的 `docs` 段会报出缓存根与已缓存文档数 |
| **「知识库」分段报 `UNKNOWN_TOOL` / 前端看不到 MCP 文档工具** | host 调 MCP 工具**必须带 agent 作用域**（MCP 行挂在 preset 里，全局视角看不到）；或 `docs.mcpToolPrefix` 与 preset 的 `serverName` 不一致 | 确认该会话用的是 Gitee preset；确认 patch 里的 `docs.mcpToolPrefix`（默认 `mcp__gitee_ent__`）与 preset 里 `mcp-gitee` 行的 `serverName: gitee_ent` 对得上 |
| **「知识库」分段是空的 / 文件点不开** | 本企业知识库是 **`DocDirectory` + `AttachFile` 的节点树**，不是 WikiInfo 文档。列表必须走 `list_doc_nodes`（`/doc/nodes`）；用 `list_enterprise_documents`（`/doc_nodes/tile`，源码里硬编码 `file_type=WikiInfo`）**恒返回 0 且不报错** | 确认界面走的是 `/doc/nodes`。若节点上显示「内容待接入」，见下一行 |
| 「知识库」里附件显示「**内容待接入**」 | 二进制不是随包那份（`download_attach_file` 是 fork 独有工具，随包版 `0.2.1-dsh.4` 带它） | 看 `/ping` 的 `mcp.manifest.toolCount`：应为 **48**，`matchesManifest` 应为 true。不是就重跑 `apply`（会重新落地随包二进制）并**重启 `dsh web`** |
| 附件下载报 `output_directory` / `cannot resolve … lstat …: no such file or directory` | MCP 文件类工具的**前置条件**：`output_directory` **必须已存在**（`ResolveWritableDirectory` 会 `EvalSymlinks`+`Stat`），`workspace` 同理 | 插件已在调用前 `mkdir` 好缓存目录；手工调 MCP 工具时**自己先建目录**。另外缓存根 `$DSH_HOME/gitee/docs` 在会话工作区之外，`workspace` 必须指到缓存根。别去改 `GITEE_ENT_MCP_ALLOWED_FILE_ROOTS` |
| 用 curl 打 `doc_nodes` 报 `"Only For MCP Gitee Enterprise Application"` | 该族端点有 **UA 门禁**：UA 必须以 `mcp-gitee-ent` 开头 | 诊断时加 `-H 'User-Agent: mcp-gitee-ent 0.2.1-dsh.4 Go/linux/amd64/go1.26.0'`。**不是接口不存在** |
| 照节点里的 `attach_file.download_url` 取附件得到 **401** | 那个 URL 是 **Web 域**，要会话 Cookie | 用 API 形态 `GET /{eid}/attach_files/{file_id}`（带企业 token）。`download_attach_file` 就是这么实现的 |
| 「文档状态一直是未缓存 / 上次核对」 | 列表状态是**上次核对**的结论（列表不为每篇文档多发一次调用，这是刻意的） | 打开那篇文档即触发一次核对；或点「核对」 |
| 「拉取变更」点了没反应 / 有页没被拉下来 | 那是 `local-dirty`（本地改过）或 `conflict`（两边都改）的页 —— **设计上永不自动覆盖** | 到 Gitee 页面对比后决定保留哪一侧；插件**不自动合并**是刻意的 |
| 文档写回报 `expected_version` 相关错误 | 乐观锁拦住了：有人在你读之后改了这一页 | **重新读页面拿新 version 再改**；绝不要绕过乐观锁 |
| **点文件后侧边栏报 `path "…" is outside workspace`（403 forbidden）** | 侧边栏的**文件围栏**（`workspaceFence`，默认 **开**）按**会话 cwd 的 realpath** 判定；缓存根在工作区之外，**软链接一解析就跑到工作区外，所以也过不去** | 点侧边栏自己弹的「关闭围栏」按钮（那是它的错误面，插件不该替你改全局设置）；或把 `docs.root` 指到工作区内的路径 |
| **「仓库」分段看不到 WIKI 内容** | 三个可能：① 这个仓库 `wiki_enabled_with_content` 是 **false**（真的没有 WIKI）；② WIKI 仓库存在但**是空仓**（有个仓库就是这种，`git clone` 成功但零提交）；③ 克隆失败（网络 / 凭据） | 界面上会分别显示「这个仓库没有 WIKI 内容」/「WIKI 是空的」/ 具体的 git 错误。克隆走 `{path_with_namespace}.wiki.git`，**用 `name` 拼会 404** |
| 仓库 WIKI 克隆报 `repository not found` | 用了 `name` 而不是 `path_with_namespace`（两者经常不同） | 用 `path_with_namespace`。另外确认 env 里 `GITEE_ENT_MCP_ACCESS_TOKEN` / `GITEE_ACCESS_TOKEN` / `GITEE_TOKEN` 有一个可用 |

## skill 是怎么加载的（不要手工拷贝）

本插件的 skill **就在插件包里**（`<包>/skills/dsh-gitee-chat/SKILL.md`），
由插件自己的 `cordis.skills.patch.yml`（`dsh.bundle.patch` 的第二个文件）按插件标准挂载：

```yaml
- id: gitee-chat-skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: 'gitee-chat-skills'   # 宿主已有一个叫 filesystem 的 provider，必须换名，否则启动即报冲突
    includeDefaultRoots: false          # 只扫自己的根，不重复扫 project/user 根
    customSkillDirs:
      - !!js "…按包名解析到 <包>/skills…"
```

要点（这几条都是实测出来的，别凭直觉改）：

- **`!!js` 里的 `baseUrl` 是 profile 目录**，不是插件目录。所以表达式是
  「从 profile 目录按包名 `dsh-gitee-chat` 解析」——这也正是 bundle 的安装位置。
- **必须换 `providerName`。** `dsh-base` 已经挂了一个名为 `filesystem` 的 provider，
  同名会直接让整棵插件树启动失败。
- **解析失败要 fail-soft**：表达式里包 try/catch，失败时回落成**一个不可能存在的
  目录字符串**。否则有人手工拷 `lib/` 而不注册 bundle 时，`resolve()` 抛错会让整个
  DSH 起不来。
- 表达式**必须返回单个字符串**。`customSkillDirs` 本身已经是数组，元素再返回数组
  就变成 `[[path]]`，报 `expected string but got [path]` 并让启动失败。
- 结果对**所有 preset 可见**（用户级），所以安装它的那段对话本身就能用上这个 skill；
  改完**不需要重启**（skill 是热加载的）。

## 装完之后告诉使用者什么

1. **刷新浏览器页面**（配置类改动会热重载，通常不需要重启）。
2. 只有在**改过插件代码 / `lib/`** 时才说**重启 `dsh web`**。
3. **token 在应用「设置 → Gitee 企业项目」里填**（唯一入口 —— 标签页里没有配置入口）。
4. 新建会话时选「Gitee 企业项目管理」或「Gitee 项目执行」。
5. 打开会话里的「Gitee 项目」标签页，点右上角「刷新」。
6. 想改任何配置，回来找你说一句就行。

## 参考

- `README.md`「换一台机器 / 换一个同事」：每个可变项从哪来、怎么改。
- `USAGE.md`：界面怎么用（给使用者看的）。
