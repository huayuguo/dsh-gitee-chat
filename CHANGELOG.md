# 更新日志

本文件记录 dsh-gitee-chat 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)；日期为本地（Asia/Shanghai）日期。

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
