# 贡献指南

本包主要面向中文用户，issue / PR 用中文即可。

## 开发环境

- Node `^22.19 || >=24`，pnpm（版本见 `package.json#packageManager`）。
- `pnpm install && node build.mjs`，然后 `pnpm run check` 必须全绿。

## 提交 PR 前

- 跑一遍 `pnpm run check`（smoke / render-check / 能力矩阵 / preset / 类型声明 / 随包 MCP）。
- 改了 `src/` 的导出：跑 `pnpm run types:gen`，把 `types/` 的生成结果一起提交。
- 改了能力档或 preset 工具集：跑 `pnpm run capabilities`，把派生物一起提交。
- **不要手改** `lib/`、`types/`、`vendor/`（前两个是生成物，后一个是外部二进制）。
- 新功能请附 smoke / render-check 断言。

## 提交信息

`type(scope): 摘要`，例如 `fix(host): 修正 XDG_BIN_HOME 回落`。

## 安全问题

见 [SECURITY.md](./SECURITY.md)，不要开公开 issue。
