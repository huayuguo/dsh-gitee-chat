# 维护约定（给 AI 与人）

本仓库同时服务两条发布线，约定只有一句话：**入库的东西必须是发布物需要的，或者发布线一致性需要的。**

## 1. 文档只在本机（不入库）

- 设计说明 `docs/design/`、决策记录 `docs/decisions/`、功能清单 `FUNCTIONS.md`、能力矩阵 `CAPABILITIES.md`、
  以及 `DESIGN.md`/`DOCS.md`，**全部在本机 `docs/` 下维护，`.gitignore` 已忽略，不入任何分支**。
- 理由：它们讲的是「内部怎么想、怎么演化」，对拿包的人没有价值；入库只会在「内部线」与「GitHub 发布线」
  之间制造第二个差异源。
- `CAPABILITIES.md` 由 `node scripts/gen-capabilities.mjs` 从 `scripts/gitee/gq.mjs` 的 `TIERS` 生成；
  该文件不在时，`smoke.mjs` 与 `gen-capabilities.mjs --check` 会**跳过比对而不是判红**。真正的防漂移靠两份
  入库产物：`src/generated/tierWrites.ts` 与各 preset 的 `--enabled-toolsets`。

## 2. 锁文件：pnpm 锁入库，两条线同一份

- `package-lock.json` **不入库**（两条线都忽略）：那是本机 `npm install` 的产物，不是发布物。
- `pnpm-lock.yaml` **入库，且两条线逐字节相同**：CI（`check.yml` / `release.yml`）靠
  `pnpm install --frozen-lockfile` 复现构建，锁一分叉 CI 就会红。
- 改依赖后的顺序：改 `package.json` → `pnpm install --lockfile-only` → 两条线同步这一份锁 →
  `npm run parity` 必须绿 → 再 `npm run check`。
- pnpm 的设置（`autoInstallPeers: false`、`allowBuilds.esbuild`、`minimumReleaseAgeExclude`）在
  `pnpm-workspace.yaml`，同样是两线同一份。

## 3. 两条线的命名

| 线 | 分支 | tag 形态 |
|---|---|---|
| 内部（Gitee 私有，`origin` + `lidakeji`） | `dev/win`（正在改）、`main` | `0.5.4`（不带 `v`） |
| 外部（GitHub 公开，`github`） | `release/0.5.4`（本仓准备）→ 推送为 GitHub 的 `main`；`github-main` 是上一版 `v0.5.3` 的快照 | `v0.5.4`（带 `v`） |

- 不要把外部线分支命名成 `github/main`：它与远端跟踪分支同名，git 会报
  `refname 'github/main' is ambiguous`，脚本里得一直写 `refs/heads/...` 才不歧义。

- 目标状态：`0.5.4` 与 `v0.5.4` **内容等位**（同一份发布物，只是线不同）。
- **等位的判定方式（2026-10-28 起）**：两条线**文件集相同**、`scripts/` **逐字节相同**，内容差异只允许出现在
  ① `README.md` / `README.en.md` 的 `<!-- parity:install:begin … end -->` 之间（装法），
  ② `package.json` 的 `repository` / `homepage` / `bugs` 三个字段。
  由 `scripts/check-parity.mjs` 断言：`npm run parity`（对等）、`npm run release:check`（对等 + 发布包必须能力）。
  规则与被哪个脚本强制，记在 `release-manifest.json`。
- `scripts/check-tags.mjs` 只管另一件事：tag ↔ `package.json` 版本 ↔ `CHANGELOG` 条目三者一致。
- 改代码的顺序固定：**先落内部线 → 投影到对外线 → `npm run parity` 绿 → 再谈打 tag / 推送**。
- 推送纪律：每次 push 都要当次批准，禁止 `git push --tags` 一把梭。

## 4. 代码与发布物

- `lib/`（构建产物）、`types/`、`.tmp/`、`node_modules/` 不入库。
- npm 包内容以 `package.json` 的 `files` 为准：`lib`、`vendor`、`assets`、
  `scripts/setup.mjs`、`scripts/check-presets.mjs`、`scripts/gitee`（运行期脚本只有这三个路径）、
  `skills`、`presets`、`cordis.patch.yml`、`cordis.skills.patch.yml`、
  `LICENSE`、`README.md`、`README.en.md`、`USAGE.md`、`icon.svg`。
- `scripts/` 里其余脚本（`check-parity`、`check-tags`、`check-types`、`smoke`、`render-check`、
  `gen-capabilities`、`build-mcp`、`preset-files`）只留在仓库、**不进包**；两条线的 `scripts/` 必须完全一致。
- 随包 MCP 二进制在 `vendor/mcp-gitee-ent/`，由 `scripts/build-mcp.mjs` 从 fork 仓（`dsh-mcp-gitee-ent`）构建，
  `manifest.json` 里的 `forkCommit` 必须与 fork 仓 HEAD 一致。
