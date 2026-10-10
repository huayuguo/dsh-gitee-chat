# dsh-gitee-chat 仓库规则（AGENTS）

面向贡献者与 AI 的**项目全局**约定。使用者文档见 [README.md](./README.md) / [USAGE.md](./USAGE.md)；
安装与诊断流程见 skills 目录里的 SKILL.md。

## 1. 形态

三半结构，平面不同、必须分开：

- `src/index.ts` + `src/host/*` —— host 半（profile bundle）。
- `src/agent.ts` —— agent 半（preset 工具与人格注入）。
- `src/client/*` —— client 半（web bundle，`tool.call.toolview` + 整屏标签页）。

生成物与外部件：

- `lib/` **不入库**（`.gitignore`），由 `build.mjs`（esbuild）生成；`prepare` 会在 `pnpm install` 后自动构建。
- `types/` 由 `tsc --emitDeclarationOnly` 生成，**不要手改**；改导出后跑 `pnpm run types:gen`。
- `vendor/mcp-gitee-ent/` 是随包分发的外部二进制，**不要手改**；更新走 `scripts/build-mcp.mjs`。
- 能力档 / preset 派生物由脚本生成（`pnpm run capabilities`），不要手改。

## 2. 构建与自检

```sh
pnpm install        # 需要 pnpm（packageManager 已钉版本）
node build.mjs      # 生成 lib/
pnpm run check      # 全量：smoke + render-check + 能力矩阵 + preset + types + 随包 MCP
```

单项：`pnpm run smoke` / `render-check` / `capabilities:check` / `presets:check` / `types:check` / `mcp:check`。

- **改了导出**：跑 `pnpm run types:gen` 重新生成 `types/`，再提交生成结果。
- **改了能力档 / preset 工具集**：跑 `pnpm run capabilities` 重新生成，`--check` 会挡漂移。
- 全部检查都**不真的写 Gitee**（写通道用桩）。

## 3. 依赖

- 运行期依赖由 DSH 宿主提供：`peerDependencies` 里的 `@deepseek-ai/*` 与 `react`。
- 为了让 `smoke` / `types:check` 能在没有 DSH 的机器（含 CI）上跑，`@deepseek-ai/*` 的
  **dev 树 peer 闭包**以精确版本钉在 `devDependencies` 里；升级宿主基线时要一起抬，
  并用 `pnpm peers check` 复核（另见 `pnpm-workspace.yaml` 注释）。

## 4. 发布

- 目的地：npm 官方源 `dsh-gitee-chat` + GitHub `huayuguo/dsh-gitee-chat`。
- 流程：bump `package.json` 版本 + 更新 `CHANGELOG.md` → CI 全绿 → 打 `v*` tag → `release.yml` 发布。
- `prepublishOnly` 会再挡一次能力矩阵 / preset / types 漂移。

## 5. 提交与远端

- 提交信息用 `type(scope): 摘要`（`feat` / `fix` / `docs` / `chore` / `build` / `test`）。
- 仓库另有 Gitee 内网远端；**推送前先确认目标 remote 与分支**。
