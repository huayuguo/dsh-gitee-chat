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

## 2. 锁文件：内部维护，不入库

- `package-lock.json` **不入库**（两条线都忽略）。内部开发机照常用它保证 `npm ci` 可复现，
  但它属于「本机环境产物」，不是发布物（npm 包的 `files` 从不包含锁文件）。
- 更新依赖后：`npm install` → 本地 `npm run check` 绿 → **不要** `git add package-lock.json`。
- 外部发布线用 pnpm（`pnpm-lock.yaml`），与 npm 锁互不相干；两边都别互相搬。

## 3. 两条线的命名

| 线 | 分支 | tag 形态 |
|---|---|---|
| 内部（Gitee 私有，`origin` + `lidakeji`） | `dev/win`（正在改）、`main` | `0.5.4`（不带 `v`） |
| 外部（GitHub 公开，`github`） | `release/0.5.4`（本仓准备）→ 推送为 GitHub 的 `main`；`github-main` 是上一版 `v0.5.3` 的快照 | `v0.5.4`（带 `v`） |

- 不要把外部线分支命名成 `github/main`：它与远端跟踪分支同名，git 会报
  `refname 'github/main' is ambiguous`，脚本里得一直写 `refs/heads/...` 才不歧义。

- 目标状态：`0.5.4` 与 `v0.5.4` **内容等位**（同一份发布物，只是线不同）。
- 等位由 `release-manifest.json` 记录「外部提交 ← 内部提交」的对应关系，`check-tags.mjs` 负责断言。
- 推送纪律：每次 push 都要当次批准，禁止 `git push --tags` 一把梭。

## 4. 代码与发布物

- `lib/`（构建产物）、`types/`、`.tmp/`、`node_modules/` 不入库。
- npm 包内容以 `package.json` 的 `files` 为准：`lib`、`vendor`、`scripts`、`skills`、`presets`、`assets`、
  `cordis.patch.yml`、`cordis.skills.patch.yml`、`README.md`、`README.en.md`、`USAGE.md`、`LICENSE`。
- 随包 MCP 二进制在 `vendor/mcp-gitee-ent/`，由 `scripts/build-mcp.mjs` 从 fork 仓（`dsh-mcp-gitee-ent`）构建，
  `manifest.json` 里的 `forkCommit` 必须与 fork 仓 HEAD 一致。
