# 安装 / 配置 / 排障（装配向）

> 这份只解决「装、配、修」。**怎么用面板、MCP 工具怎么调**看 `../SKILL.md`。
> 目标是：你检查、你问、你写配置，使用者不打开任何文件。

## 1 装 / 升级

| 场景 | 命令 |
|---|---|
| 装进某个 profile | `dsh plugin --profile <name> add <本包目录>` |
| 看环境齐不齐 | `node scripts/setup.mjs env`（`--json` 给机器读，看 `ok` 字段） |
| 看现状（人话） | `node scripts/setup.mjs detect` |
| 该问使用者什么 | `node scripts/setup.mjs questions` |
| 写配置 | `node scripts/setup.mjs apply --answers '{"enterpriseId":11111111,"allowWrites":true}'`（`--dry-run` 预演） |
| 全项自检 | `node scripts/setup.mjs verify` |
| 修插件市场半状态 | `node scripts/setup.mjs repair`（`--dry-run` 先看） |

`apply` 幂等，做三件事：① 在 profile 的 `cordis.patch.yml` 里 `# >>> gitee-chat` / `# <<< gitee-chat` 两个哨兵之间整段替换本插件配置（**只动这一段**，改前备份）；② 写 `$DSH_HOME/.gitee-chat/config.json`；③ 落地随包 MCP 二进制 + 跑 `scripts/check-presets.mjs`。

**生效边界**：配置类改动热重载（改完刷新页面即可）；只有动过插件代码 / `lib/` 才需要重启 `dsh web`。

## 2 配置有两个真源，别写串

| 真源 | 内容 | 谁写 |
|---|---|---|
| profile 的 `cordis.patch.yml` | 插件 `config`（企业 id 钉住值、`allowWrites`、`thresholds`、`docs.*`…） | `setup.mjs apply` |
| `$DSH_HOME/.gitee-chat/config.json` | 当前企业选择（设置页 / `gq enterprises --use` 写它） | 设置页或脚本 |

补丁里同 id 的 `config` 是**整体替换**（不是深合并）——所以 `apply` 生成的永远是完整配置，手改单个键要重跑 `apply`，不要让使用者去编辑 YAML。

## 3 配置字段（`src/index.ts` 的 `Config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enterpriseId` | `0` | 钉住企业。`0` = 让脚本解析（单企业自动用，多企业报错） |
| `allowWrites` | `true` | 写通道总开关，见 §6 |
| `mode` | `auto` | 人格：`auto` 推导 / 强制 `manager`/`project`/`exec` |
| `thresholds` | `{}` | 分析阈值覆盖，见 §7 |
| `docs.root` | `$DSH_HOME/gitee/docs` | 知识库本地缓存根 |
| `docs.mcpToolPrefix` | `mcp__gitee_ent__` | 必须与 preset 里 `serverName: gitee_ent` 一致 |
| `docs.autoCheckOnRead` | `true` | 读本地前先核对一次一致性 |
| `docs.maxPageBytes` | `200000` | 单页正文落盘上限（字符） |
| `apiBase` | `https://api.gitee.com/enterprises` | 端点基址 |
| `scriptPath` | 包内 `scripts/gitee/gq.mjs` | **不要写成空串**，见 §9 第一行 |
| `scriptTimeoutMs` | `60000` | 单次脚本超时 |
| `cacheTtlSeconds` | 内置 | gq 输出短时缓存（0 = 关） |
| `roleTtlSeconds` | `600` | 身份解析缓存 |
| `allowFixtureFallback` | 生产建议 `false` | 无 token 时用样例数据渲染（只给演示） |
| `presetIds` / `agentRowName` | 空 / `dsh-gitee-chat/agent` | Gitee 模式判定：留空按「组合里挂了这一行」判 |

## 4 企业 id 从哪来（4 级，顺序不可变）

1. 插件配置 `enterpriseId`（>0 = 钉住，其它来源都不生效）；
2. 环境变量 `GITEE_ENT_ID` → `GITEE_CHAT_ENTERPRISE_ID`；
3. `$DSH_HOME/.gitee-chat/config.json` 的 `enterpriseId`（设置页切企业写这里，改完即生效）；
4. token 只看得见一家 → 自动用；**多家 → 报错要求指定，绝不自动挑**（挑错就是拿错公司数据）。

`src/host/enterpriseId.ts` 是唯一真源，与 `scripts/gitee/gq.mjs` 的 `resolveEnterprise()` 逐条对齐。
凡是发给 MCP 的 `enterprise_id` 都必须经过它 —— 否则会出现「一半好用一半 401」（仓库、知识库走 MCP 全挂，看板正常）。

切换企业：设置页「Gitee 企业项目 → 当前企业」，或 `gitee_enterprises {use:<id>}`，都不用重启。

## 5 token 从哪来

| 来源 | 位置 | 说明 |
|---|---|---|
| 环境变量 | `GITEE_ENT_MCP_ACCESS_TOKEN` → `GITEE_ACCESS_TOKEN` → `GITEE_TOKEN` | 先 trim，谁先有值用谁 |
| token 文件 | `$DSH_HOME/.gitee-chat/token` → `$DSH_HOME/gitee-chat-token` → `~/.gitee-token` | 内容为纯 token |

- **界面是唯一推荐入口**：「设置 → Gitee 企业项目」粘贴保存（写的就是第一份 token 文件），即时生效。
  不要让使用者在对话里贴 token，也不要让他手抄环境变量。
- 桌面版从开始菜单启动**不继承** shell 里 `export` 的变量，只认 token 文件 —— 所以只配环境变量在桌面版会「配了但没生效」。
- MCP 子进程前 dsh-mcp-client 会清洗匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量，所以 preset 里必须
  **显式注入** `GITEE_ENT_MCP_ACCESS_TOKEN`。那条 `!!js` 表达式必须**始终返回字符串**（返回 `undefined`
  会被 `z.dict(String)` 拒收 ⇒ 整行 mount 失败是终态，preset 永久红标「加载失败」）。
- **边界**：企业 token 只给 MCP 用。直接 `curl https://api.gitee.com/enterprises/...` 会 401
  `Only For MCP Gitee Enterprise Application`；拿它调标准 `api/v5` 会 `Access token is wrong type`。
  诊断时若要 curl，UA 得是 `mcp-gitee-ent …` 开头（端点有 UA 门禁，不是接口不存在）。

## 6 只读开关（`allowWrites: false`）

关掉后：界面上的改状态/评论/改派按钮明确报错；**25 个写工具**在 MCP 通道被硬拦
（`src/generated/tierWrites.ts` 的 `WRITE_TOOLS`）—— 早先 `allowWrites` 只管界面，AI 仍能建工作项，现在补成真的。
被拦的工具会明确回「写通道已关闭」，不是「没权限」。

## 7 阈值（默认即 `scripts/gitee/analysis.mjs`）

| 键 | 默认 | 含义 | 环境变量 | 配置键 |
|---|---|---|---|---|
| `stallDays` | 14 | 进行中且 N 天没更新 = 停滞 | `GITEE_CHAT_STALL_DAYS` | `thresholds.stallDays` |
| `overloadOpen` | 8 | 未完成数下限（过载） | `GITEE_CHAT_OVERLOAD_OPEN` | `thresholds.overloadOpen` |
| `overloadOverdue` | 2 | 逾期数下限（过载） | `GITEE_CHAT_OVERLOAD_OVERDUE` | `thresholds.overloadOverdue` |
| `requiredLabels` | 3 | 规范要求的三维标签数（0 = 关） | `GITEE_CHAT_REQUIRED_LABELS` | `thresholds.requiredLabels` |
| `weeklyCapacity` | 10 | 每周交付容量 | `GITEE_CHAT_WEEKLY_CAPACITY` | `thresholds.weeklyCapacity` |
| `trendWeeks` | 8 | 交付趋势回看周数 | `GITEE_CHAT_TREND_WEEKS` | `thresholds.trendWeeks` |
| `milestoneRiskDays` | 7 | 里程碑剩余天数小于它且有未完成 = 有风险 | `GITEE_CHAT_MILESTONE_RISK_DAYS` | `thresholds.milestoneRiskDays` |

改法：`apply --answers '{"thresholds":{"requiredLabels":2}}'`（不必重启）；环境变量要重启。

## 8 自检命令

| 命令 | 看什么 |
|---|---|
| `node scripts/setup.mjs verify` | token 来源、MCP 后端（随包/清单/sha256 一致）、skill 是否生效、preset 是否齐、profile bundle、插件市场半状态、agent 半能否 import、补丁现值、真实取数连通性（企业名 + 样例项目数） |
| `node scripts/setup.mjs env` | 协作环境逐项（git / Obsidian / MCP / token / Apifox …） |
| `node scripts/check-presets.mjs` | 用真求值器跑 preset 里的 `!!js` 表达式 |
| 工具 `gitee_chat_health` | token、企业、API 连通、MCP 后端 `matchesManifest` 与 `reportedVersion` |
| `GET /api/gitee-chat/ping` | `scriptExists`、`mcp.manifest.toolCount`（应为 **55**） |

## 9 常见错误

| 症状 | 原因 | 处置 |
|---|---|---|
| 界面「取数失败 · gq 输出不是 JSON：」（冒号后为空） | 配置里 `scriptPath` 是**空串** → 执行 `node '' …` → 退出码 0、零输出 | 从补丁里删掉那一行（不要改成空串），重启 |
| preset 红标「加载失败」，tooltip 含 `<ai/dsh-mcp-client>: invalid config … env` | token 表达式求值成 `undefined`，env 校验只收字符串 ⇒ mount 失败是**终态** | 配一个 token（环境变量或文件）并重启；`check-presets.mjs` 可提前发现 |
| `未配置 token` | 三处都没配 | 让他去「设置 → Gitee 企业项目」里填，不要让他贴 token |
| `enterprise_id is invalid` / 要求指定企业 | 多企业未固定 | 设置页选企业，或 `apply --answers '{"enterpriseId":<id>}'` |
| 仓库 / 知识库分段整体 401，看板正常 | 发给 MCP 的 `enterprise_id` 用了钉住值 0 | 走 `enterpriseId.ts` 的解析；设置页选一次企业 |
| 标签页空白 / 取不到数 | host 半没重启，或 profile 里没装 bundle | 重启 `dsh web`；`detect` 看 `profiles[].hasBundle` |
| 「选了工作区没反应」/ 建会话退回选工作区 | agent 半 import 不了（`link:` 装法够不到 DSH 依赖闭包） | `apply` 会探针并补一跳；或改用 `add file:<本包目录>` |
| AI 说建不了项目 / 少工具 | 二进制被换成上游 npm 版（没有 `create_program`），而 `--enabled-toolsets` 只过滤不校验 | 看 `gitee_chat_health` 的 MCP 后端段；`rm` 掉用户级 bin 里那份后 `apply` |
| 文档导不进 / 导不出 | 没传 `workspace`（作用域落到 MCP 进程 cwd） | 传当前工作区绝对路径（是 **MCP 所在机器**的路径） |
| 写文档报 `expected_version` / version changed | 乐观锁：有人先改了 | 重新读页面拿新 `version` 再写，**别绕过** |
| 附件下载报 `output_directory` / lstat no such file | 文件类工具的 `output_directory` **必须已存在** | 先 `mkdir` 再传 |
| 附件 `download_url` 取到 401 | 那是 Web 域 URL，要会话 Cookie | 用 `download_attach_file`（API 形态 `GET /{eid}/attach_files/{file_id}`） |
| 知识库分段报 `UNKNOWN_TOOL` | host 调 MCP 工具需要 agent 作用域；或 `docs.mcpToolPrefix` 与 preset `serverName` 不一致 | 先打开该会话；核对前缀 |
| WIKI 克隆 `repository not found` | 用了 `name` 而不是 `path_with_namespace` | 用 `path_with_namespace`（两者经常不同） |
| 会话里同时存在别的 Gitee 手册（写着「31 个工具」） | 用户级 skill 根里还有旧版 `gitee-ent`/`gitee-mcp` | 移走它们（skill 目录每轮重扫，不用重启）；工具数以 `gitee_chat_health` 实测为准 |

## 10 装配要点（改之前先读这段）

- **MCP 二进制随包**：`vendor/mcp-gitee-ent/`（linux-amd64 / windows-amd64.exe / `manifest.json`，55 个工具）。
  落地四级回落：`MCP_GITEE_ENT_BIN` → 用户级 bin（POSIX `$XDG_BIN_HOME` 或 `~/.local/bin`，Windows `%USERPROFILE%\.local\bin`）
  → 旧副本 `$DSH_HOME/.gitee-chat/bin/` → PATH。三处实现必须一致：preset 的 `command` 表达式、
  `src/host/mcpBinary.ts` 的 `materializedPath()`、`scripts/setup.mjs` 的 `mcpTargetPath()`。
- **preset 挂满 55 个工具**（`presets/gitee.patch.yml` 的 `--enabled-toolsets`，与 manifest 逐字一致）；
  三档 40/48/55 是**人格收敛建议**，硬拦只看 `allowWrites` 的 25 个写工具。
- **两个 Gitee preset 由 bundle 的 `dsh.bundle.patch` 交付**，装配期组合；DSH 0.1.7 起没有「用户根 preset 目录」。
- **skill 也在包里**（`skills/dsh-gitee-chat/SKILL.md`），由本包的 `cordis.skills.patch.yml` 挂载：`providerName`
  必须换名（`gitee-chat-skills`，宿主已有 `filesystem`）、`includeDefaultRoots: false`、`customSkillDirs` 用
  `!!js` 从 **profile 目录**按包名解析、失败 fail-soft、**必须返回单个字符串**（返回数组会 `[[path]]` 启动失败）。
- **模板**：`templates/review.md`、`test.md`、`pr.md` 随包；界面上改过就写用户副本
  `$DSH_HOME/.gitee-chat/templates/<name>.md`，优先级高于内置。`pr.md` 目前只能靠同名用户副本覆盖
  （`POST /pr/templates` 的 `kind` 只收 `review`/`test`，没有 pr 的仓库级绑定入口）。

## 11 装完之后告诉使用者什么

1. 刷新浏览器页面（配置类改动热重载；改过代码才需要重启 `dsh web`）。
2. token 在「设置 → Gitee 企业项目」填。
3. 新建会话时选「Gitee 项目管理」。
4. 打开会话里的「Gitee 项目」标签页，点右上角「刷新」。
5. 想改任何配置，回来找你说一句就行。

## 12 延伸阅读

- 仓库根 `README.md`：换一台机器 / 换一个同事时每个可变项从哪来。
- `USAGE.md`：界面用法（给使用者）。`FUNCTIONS.md`：功能清单。`DOCS.md`：知识库能力。
- `DESIGN.md` §10 / §14–§17 / §23 / §30 / §32 / §35 / §37：写通道纪律、preset 判定、skill 装配、半状态修复。
