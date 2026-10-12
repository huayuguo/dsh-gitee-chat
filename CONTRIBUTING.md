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

## 代码结构（三个平面必须分开）

`src/index.ts` + `src/host/*` 是 **host 半**（profile bundle），`src/agent.ts` 是 **agent 半**
（preset 工具与人格注入），`src/client/*` 是 **client 半**（web bundle）。三者平面不同：
host 半只装配与发服务、不注册工具与人格，client 半只在浏览器里跑。改之前先看清在哪个平面。

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
src/host/repoService.ts   仓库 / WIKI 编排层
src/host/wikiCache.ts     仓库 WIKI 的 git 取数与工作区软链接（唯一不走 MCP 的口）
src/client/index.tsx      client 入口：注册 tool.call.toolview + conversation.view + settings.section
src/client/ui.tsx         共享原件（卡片/卡头/分段开关/统计格/表格/Markdown 渲染）
src/client/BoardCard.tsx  卡片取数与状态机     src/client/BoardView.tsx  卡片纯展示层
src/client/GiteeProjectView.tsx  整屏标签页（项目 / 仓库 / 固定分析 / 知识库）
src/client/DocPanel.tsx          知识库面板（节点树 / 附件缓读 / 预览分工）
src/client/RepoPanel.tsx         仓库面板（两种口径的仓库列表 + 仓库 WIKI）
src/client/AnalysisCards.tsx     9 张固定分析卡片
src/client/IssueDetail.tsx       工作项详情 + 写回（描述 / 前置依赖 / 评论讨论）
src/client/charts.tsx            纯 SVG/CSS 图表（零图表库依赖）
scripts/gitee/gq.mjs      取数脚本（零依赖 Node ESM）
scripts/gitee/analysis.mjs 固定分析纯函数（两批，可独立单测）
scripts/check-presets.mjs preset 交付自检 + `--doctor` 可移植性体检（preset 写进 bundle 补丁，不从用户根加载）
scripts/setup.mjs         detect / questions / apply / verify —— AI 靠它做到使用者无操作
skills/dsh-gitee-chat/SKILL.md  教 AI 怎么装、怎么问、怎么改配置（随包分发）
USAGE.md                 使用者视角的用法与排错
```

`lib/`（esbuild 产物）与 `types/`（`tsc` 产物）是生成物，`vendor/` 是外部二进制，都不要手改。

## 提交信息

`type(scope): 摘要`，例如 `fix(host): 修正 XDG_BIN_HOME 回落`。

## 安全问题

见 [SECURITY.md](./SECURITY.md)，不要开公开 issue。
