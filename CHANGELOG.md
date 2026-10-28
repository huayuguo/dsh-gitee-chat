# 更新日志

本文件记录 dsh-gitee-chat 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；日期为本地（Asia/Shanghai）日期。

## [0.5.4] - 2026-10-27

**合并请求全流程 + 面板重构版**。0.5.3 只有「看板 + 工作项写回 + 固定分析」，PR 相关的事都得回 Gitee
网页做；这一版把 PR 从「发现 → 读 diff → 审核 → 测试 → 合并」整条链路搬进插件，并把面板重排成六个页签。

### 新增

- **面板六个页签**：`概述` / `项目` / `我的工作项` / `合并请求` / `知识库` / `固定分析`。
  概述是新的：四张 KPI 卡 + 状态分布环图 + 项目进度 + 归我处理的风险 + PR 待办。
- **「我的工作项」页签**：企业内「我是负责人 + 我是协作者」的工作项聚合，在 payload 里算好（零额外请求）。
- **仓库下钻页**：点项目里的仓库卡片进入三栏（项目列表 / 该项目仓库列表可切换 / 仓库详情：工作项·合并请求·WIKI），
  栏宽可拖动并记住。
- **合并请求页签与 PR 详情抽屉**：四种筛选（待我审核 / 待我测试 / 我提出的 / 全部）× 四种状态；
  抽屉里看信息、文件 diff、评论，并直接做审核/测试/合并。
- **新建 PR 弹窗**：仓库下拉、源/目标分支下拉（源=目标时禁止创建，并说明原因）、标题、描述、
  一键套用模板、审查/测试人数、草稿；**AI 起草**把 diff 交给所选会话的子智能体产出标题+描述并回填。
- **AI 审核**：PR 详情里起一个子智能体读 diff，给出阻断/重要/次要分级结论，可一键「提交评论并驳回」，
  或只提交评论再人工决定。
- **写回补全**：工作项新建（负责人、优先级、计划时间起止三项必填）、改状态、改派、评论；
  PR 审核通过/拒绝/重置、测试通过/失败、合并、评论。
- **设置项**：「设置 → Gitee 企业项目」内的 token / 当前企业 / **缓存与后台刷新**（agent 可读快照、落盘、TTL 秒、
  后台刷新开关·间隔秒·空闲分钟）。
- **`gitee_board_snapshot` 工具**：会话可直接读面板快照（带 `fetchedAt` / `ageSeconds` / `stale` / `ttlSeconds`），
  不必为看一眼数据重翻 4 页 API。
- **缓存与快路径**：读路由 30s TTL + 单飞；面板在本地有仓库克隆时用本地 diff，避免远端 compare 的往返。

### 变更

- **去掉「会话模式」门禁**：任何会话都能打开面板与调用写路由，不再要求会话由 Gitee preset 创建。
  preset（`Gitee 项目管理`）仍负责注入人格与三档能力说明，只是不再是使用前提。
- **能力档位改为按 token 的云端角色动态判定**（管理者 / 负责人 / 执行），只读部署下写工具硬拦；
  「无删除入口」的表述纠正为「面板没有删除入口，删除走 MCP（不可逆）」。
- 随包企业版 MCP 升到上游 **v0.2.5**（`0.2.5-dsh.7`，55 个工具），PR 子资源参数统一为 `pull_request_iid`
  （0.5.3 及更早是 `pull_request_id`）。
- 类型声明改按 DSH 官方包约定放在 `lib/types/`，随 `lib` 一起发布；发布物不再单独发 `src/`。

### 修复

- **人格注入在会话启动时可能拿到空值**：`systemPrompt` 的同步读取撞上异步解析，改成注入后再读（`ctx.inject`）。
- **只读部署仍能通过面板写路由改数据**：`/write`、`/pr/create`、`/pr/action` 等统一按 `allowWrites` 硬拦。
- 面板时间戳不再显示 UTC（曾出现「少了 8 小时」）。
- 仓库列表点选会被「默认仓库」弹回、拖动栏宽被布局上限卡死、写操作后整页重拉导致闪动 —— 均已修。

## [0.5.3] - 2026-10-12

**仓库面板与知识库面板整体 401 的修复版**。0.5.2 及更早：插件配置 `enterpriseId: 0`（自动档，
默认值）时，这两个面板会整体报 `[api_error] 401 企业未授权此应用进行访问`，而看板/人格/工作项
一切正常 —— 后者走 gq 脚本，脚本遇到 0 会自己回落读 `~/.dsh/.gitee-chat/config.json`，
**MCP 通道没有这层回落**，把字面量 `0` 当成企业 id 发了出去。

### 修复

- **`enterpriseId: 0` 被当成企业 id 发给 MCP ⇒ 仓库/知识库面板 401**（新增 `src/host/enterpriseId.ts`）：
  生效企业改为**每次现取**（插件配置钉住值 → 环境变量 → 本地配置文件 → token 唯一企业自动），
  不缓存（企业可在设置里随时切换）；**多家企业绝不自动挑一个**（与 gq 同一条纪律，静默取第一家
  会拿错公司的数据，宁可报可行动错误）。
- **那句 401 本身会把人带偏**（`src/host/mcpDocs.ts`）：实测 token 有效、企业 id 换成别家的
  也逐字报「企业未授权此应用进行访问」—— 所以它只表示"这个企业 id 不在当前 token 名下"。
  现在这句话会被翻译成"企业 id 不对、不用重配 token"，并写出本次用的是哪个 id、来源是什么；
  解析不出企业时改报 `no-enterprise`（含去哪儿选，而不是甩一句 MCP 原始报错）。
- **模型侧工具目录抬头写出生效企业 id 与来源**（`src/host/gateway.ts`、`src/index.ts`）：
  现取而非注册快照，且企业 id 为 0 时不写（避免模型照着 `enterprise_id: 0` 去调，重演同一个 401）。
- `src/host/routes.ts` 给 `no-enterprise` 映射 409、`src/host/docService.ts` 与
  `src/host/repoService.ts` 的缓存分层与返回值改用现取的生效企业。

### 测试

- `scripts/smoke.mjs`：新增「永不发 0」（钉住不探测 / 唯一企业自动用 / 多家报可行动错误 /
  顺序 flag>env>file）与「401 被翻译成可行动的话」两组用例，以及工具目录抬头的正反两例。

## [0.5.2] - 2026-10-12

**0.5.1 的修正版**。0.5.1 是从打 tag 的那个提交（f3cf5e2）构建的，里面缺了下面这批 Windows
修复 —— **Windows 上请用 0.5.2 取代 0.5.1**。

### 修复

- **Windows 上知识库文档的 workspace 链接恒失效**（`src/host/wikiCache.ts`）：判据写成了
  `cwd.startsWith('/')`，Windows 盘符路径永远不成立，`workspaceLink()` 直接返回 `null`，
  「把知识库文档挂进当前工作区」这条路径在 Windows 上等于没有；改判 `path.isAbsolute(cwd)`，
  建链接时按平台选 `junction`（普通用户即可创建；`symlink` 要开发者模式或管理员）。

### 构建与发布链

- `scripts/smoke.mjs`：Windows 上按平台造路径、PATH 分隔符、目录链接与可执行位断言，
  `pnpm run check` 在 Windows 开发机上不再假红。
- `scripts/gen-capabilities.mjs`：派生物比对忽略 CRLF（Windows 结账默认 `core.autocrlf=true`，
  否则能力矩阵会误报漂移）。
- `.github/workflows/release.yml`：缺 `NPM_TOKEN` 时给出可行动的报错（0.5.1 首次发布就是
  这么挂的，日志只有一句 `ENEEDAUTH`）；手动触发不再被 tag 门槛拦死，且无 tag 时不跑
  Release 附件步骤。
- 自此 CI 的 `windows-latest` 矩阵在 `check` 与 `release` 两个工作流上都全绿。

## [0.5.1] - 2026-10-10

**首个公开发布版本**，当前版本包含：

### 插件形态

- 三半结构：**host 半**（profile bundle：装配执行器、身份/人格解析、HTTP 路由、发布 `giteeChat` 服务）、
  **agent 半**（preset：触发型工具 + 人格注入 + 能力档门禁）、**client 半**（web bundle：
  `tool.call.toolview` 看板卡片 + 整屏标签页）。
- preset 与 skill 都**随包分发**：两个 Gitee 模式是 `presets/gitee-*.patch.yml`（由
  `dsh.bundle.patch` 交付、装配期组合）；skill 由本包 `cordis.skills.patch.yml` 挂一个
  `skill-filesystem` provider 指向 `<包>/skills`，不往 `$DSH_HOME/skills` 拷文件。

### Gitee 企业 MCP

- **随包分发后端二进制**（linux / windows amd64，48 个工具 = 上游 0.2.1 的 37 个 + fork 独有 11 个，
  含 `create_program` 建项目）。安装时落地到**跨平台用户级 bin**（POSIX `$XDG_BIN_HOME` →
  `~/.local/bin`；Windows `%USERPROFILE%\.local\bin`）—— 公开的 MCP 后端不塞在插件私有目录，
  任何 MCP 客户端都能直接调 `mcp-gitee-ent`。落地前若目标已存在且不是随包版本，先备份成
  `<name>.bak`；使用者**不需要 Go 环境**。
- **公共 gateway `gitee_ent`**：host 半注册的全局工具（两级暴露 `op: list | schema | call`），
  任何 preset / 会话都能调 Gitee 企业 MCP，常驻成本约 1.2 KB/轮。Gitee 模式内仍用原生
  `mcp__gitee_ent__*` 工具，并由 `restrict` 隐藏 gateway，避免出现两个重复入口。
- **三档能力矩阵**：exec 34 ⊂ project 41 ⊂ manager 48，写工具并集 20。名单由
  `scripts/gitee/gq.mjs` 的 `TIERS` 派生（`src/generated/tierWrites.ts` + 两个 preset 的
  `--enabled-toolsets`），`--check` 防漂移。只读部署（`allowWrites: false`）在 gateway 层硬拦写工具。

### 能力

- 会话内**项目看板卡片**与**整屏标签页**（项目 / 仓库 / 固定分析 / 知识库）。
- **9 张固定分析卡**：项目健康度 / 成员负载 / 延期清单 / 停滞 / 规范体检 / 进度偏差 / 交付容量 /
  里程碑达成 / 交付趋势 —— 全部纯函数、确定性、可在冒烟里逐条断言，不消耗模型。
- **工作项详情与写回**（改状态 / 改派 / 评论）：全包唯一写入口；要求会话确实处于 Gitee 模式，
  且只能改当前身份有权限改的东西。
- **知识库文档与附件**：按需缓存 + 页级四态判定（`synced` / `remote-ahead` / `local-dirty` / `conflict`），
  端点全部委派 MCP，插件不自己拼 Gitee 文档端点；仓库 WIKI 走 git 克隆（Gitee 无对应 HTTP 接口）。

### 工程

- **类型声明自动生成**：`types/` 由 `tsc --emitDeclarationOnly` 从 `src/` 生成
  （`tsconfig.types.json`）；一致性守卫 `scripts/check-types.mjs --check` 重新生成后要求
  `git diff` 干净，挂在 `pnpm run check` 上。
- **CI 跑全量链**：`@deepseek-ai/*` 的 dev 树 peer 闭包以精确版本钉在 `devDependencies`，
  ubuntu + windows 两个矩阵都直接跑 `pnpm run check`（smoke / render-check / 能力矩阵 / preset /
  types / 随包 MCP），不再跳过任何一项。
- **包元数据**：`packageManager`（pnpm 版本）、`icon`、`dsh.manifestVersion`；单一锁文件
  （只保留 `pnpm-lock.yaml`）；`publishConfig` 钉到 `https://registry.npmjs.org/`。
- **发布**：打 `v*` tag 触发 `release.yml`，先重跑全量检查，再 `npm publish --provenance`，
  随附 `npm pack` 产物与 `SHA256SUMS.txt`。
- **仓库文档**：`AGENTS.md`（仓库规则）、`CONTRIBUTING.md`、`SECURITY.md`、`.editorconfig`、
  issue 模板（`.github/ISSUE_TEMPLATE/issue_report.yml`）。
- 自检全家桶：`scripts/smoke.mjs`（装配 / 工具 / 路由 / 缓存 / 门禁 / 写通道）、
  `scripts/render-check.mjs`（卡片与视图渲染回归）、`scripts/check-presets.mjs`（preset 交付）、
  `scripts/build-mcp.mjs --check`（随包二进制 sha256 与工具清单）。

[0.5.1]: https://github.com/huayuguo/dsh-gitee-chat/releases/tag/v0.5.1
