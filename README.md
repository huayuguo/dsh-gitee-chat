# dsh-gitee-chat

[![npm](https://img.shields.io/npm/v/dsh-gitee-chat.svg)](https://www.npmjs.com/package/dsh-gitee-chat)
[![CI](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml/badge.svg)](https://github.com/huayuguo/dsh-gitee-chat/actions/workflows/check.yml)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.0--rc.2-4a6cf7.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)
[![license](https://img.shields.io/npm/l/dsh-gitee-chat.svg)](./LICENSE)

把 **Gitee 项目管理**装进 [DSH](https://github.com/deepseek-ai/deepseek-harness) 会话：
一整页能点的项目工作台 + 一套能写的工具 + 随包的 55 个 Gitee 企业 MCP 工具。

- **面板不占上下文**：工作项/合并请求/知识库的数据由面板自己向宿主取，多大的数据量都不进模型；
- **工具只回摘要**：`gitee_board` 给模型的是几十到一千 token 的摘要，卡片直接向宿主路由要全量数据；
- **写操作有边界**：界面只做最小写集合（状态 / 指派 / 评论 / 新建工作项 / PR 动作），其余交给 MCP。

![Gitee 项目面板：概览页 · 项目进度 · 风险与 PR 待办](assets/overview.png)

## 能做什么

会话头里的「Gitee 项目」是一个**整页工作台**（渲染在会话正文区，不接管也不顶掉右侧边栏），
六个页签：

| 页签 | 内容 |
|---|---|
| 概览 | 企业级 KPI、风险提醒、最近动态 |
| 项目 | 左侧项目列表 + 仓库卡片 + 工作项表（未完成 / 已完成 / 逾期 / 全部）；点行开详情，点仓库卡片下钻三栏 |
| 我的工作项 | 负责人 + 协作者两种关系的聚合，带未完成 / 完成 / 逾期筛选 |
| 合并请求 | 待我审核 / 待我测试 / 我提出的 / 全部 + 状态筛选；点行开抽屉 |
| 知识库 | 左侧项目 + 节点树 + 可拖分栏；节点按需展开，附件按需下载，预览优先交给侧边栏 |
| 固定分析 | 9 张卡片：项目健康度 / 成员负载 / 延期清单 / 停滞 / 规范体检 / 进度偏差 / 交付容量 / 里程碑达成 / 交付趋势 |

**仓库卡片下钻**：三栏（项目列表 | 仓库列表 | 仓库资源），左栏可拖宽并记住；默认「本项目」、
可切「内源仓库」，口径跨项目保留；仓库详情三个页签（工作项 / 合并请求 / WIKI）用暖浅色区分。

**合并请求全流程**（抽屉里）：概览 · 变更文件 · 评论 · AI 审核 → 审核通过 / 驳回 → 测试通过 → 合并；
「＋ 新建 PR」支持手动填表（仓库 / 分支 / 标题 / 描述 / 审查人数 / 测试人数 / 草稿 / 套用模板），
与 MCP 的 `create_enterprise_repo_pull` 等价。

**AI 起草与审核**：审核任务投递到所选主会话下的子智能体（不往主会话插用户消息），面板轮询结论并给出
可一键落地的操作（提交评论并驳回 / 通过）；起草 PR 描述同样走子智能体，结论回填表单。
审核/测试模板分开绑定、面板内可编辑；PR 描述模板在新建 PR 时一键套用。

**工作项**：新建（标题 / 负责人 / 优先级 / 计划时间必填）、改状态、改派、评论；状态四色药丸区分；
写操作后不整页重拉。详情含描述、前置依赖（认 Gitee 编号与 WBS 编码两种写法）与评论讨论。

**能力档**：只有一个 agent 预设「Gitee 项目管理」。档位不靠选，而是每次取数按 **token 在 Gitee 云端的
角色与项目关系**推导：企业拥有者/超管/管理员 = 管理者（55 个 MCP 工具）；某项目负责人 = 负责人档（48）；
其他 = 执行档（40，只看本人工作项）。换企业 / 换 token 即时改档。

## 安装

要求：DSH `^0.2.0-rc.2`，Node `^22.19 || >=24`。

```sh
# 推荐：npm 官方源
dsh plugin --profile desktop add dsh-gitee-chat
```

| 来源 | 命令 | 什么时候用 |
|---|---|---|
| **npm 官方源** | `dsh plugin --profile desktop add dsh-gitee-chat` | 默认 |
| GitHub Release 附件 | `dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.4/dsh-gitee-chat-0.5.4.tgz"` | 直连 npm 不稳时 |
| git 直装 | `dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.4"` | 想跟某个 tag |
| 本地源码 | `npm install --legacy-peer-deps && npm run build` 后 `add "file:$(pwd)"` | 开发 / 改代码 |

- **profile 要对**：桌面版是 `desktop`，`dsh web` 是 `web`；装错是**静默失效**（界面里什么都没有）。
- 桌面版用**应用自带**的 `dsh`（`<应用目录>\resources\runtime\cli\bin\dsh.cmd`），或走 GUI「设置 → 插件 → 添加插件」。
- **升级 = `remove` 再 `add`**：都是副本，没有自动更新。从 0.5.3 升上来时，profile 里可能还留着旧的
  预设行（`preset-gitee-exec` / `preset-gitee-manager`），删掉它们，别留两个 Gitee 入口。
- npm 只往官方源发；国内镜像会自动同步，不要往镜像发。
- 装完在 **设置 → Gitee 企业项目** 填企业版 access token。
- 让 AI 代装：本包自带 `skills/dsh-gitee-chat/SKILL.md`，说一句「装这个 Gitee 插件，配置项问我」即可。

## 配置

「设置 → Gitee 企业项目」一页管完，**保存即生效，不用重启**：

| 项 | 说明 |
|---|---|
| 企业版 Token | 存到 `$DSH_HOME/.gitee-chat/token`；取数脚本与 MCP 子进程读同一份 |
| 当前企业 | token 可见多个企业时选一个，避免「拿错公司数据」 |
| 会话里的 AI 可以读看板快照 | 默认开：`gitee_board_snapshot` 返回快照（带时效），不必翻页重拉 |
| 快照落盘 | 默认开：缓存写到 `$DSH_HOME/.gitee-chat/cache/`，重启后仍可命中 |
| 新鲜期（秒） | 默认 60，最小 10，`0` = 关闭缓存 |
| 后台定期刷新 | 默认关；开着时按下面的间隔预取看板，打开面板就是热的 |
| 刷新间隔（秒） | 默认 60，最小 10 |
| 闲置暂停（分钟） | 默认 30：这段时间内没人用面板就不刷，避免空转与限流 |

token 解析顺序：`GITEE_ENT_MCP_ACCESS_TOKEN` / `GITEE_ACCESS_TOKEN` / `GITEE_TOKEN` →
`$DSH_HOME/.gitee-chat/token` → `$DSH_HOME/gitee-chat-token` → `~/.gitee-token`。
桌面版从开始菜单启动时**不继承 shell 的 export**，所以优先在设置页里填。

## 工具

| 工具 | 作用 |
|---|---|
| `gitee_board` | 看板摘要（模型看摘要，面板看全量） |
| `gitee_board_snapshot` | 直接读缓存快照，返回 `fetchedAt / ageSeconds / stale / ttlSeconds` |
| `gitee_role` | 当前 token 的身份、人格与能力档 |
| `gitee_enterprises` | 列出 / 切换当前企业 |
| `gitee_chat_health` | 取数环境自检（token / 企业 / 连通性） |
| `gitee_ent` | **公共 gateway**：`op:"list"` → `op:"schema"` → `op:"call"`，在非 Gitee 预设会话里可调 55 个企业 MCP 工具 |

Gitee 预设会话里 `gitee_ent` 刻意隐藏（避免绕过档位门禁），改用原生 `mcp__gitee_ent__*`（按档裁剪）。
只读部署（`allowWrites: false`）下写工具会被硬拦；真正的权限边界始终在 Gitee 云端 token 的角色。

## 随包 MCP

`vendor/mcp-gitee-ent/` 随包分发 `mcp-gitee-ent` 二进制（Linux / Windows amd64，上游基线 **v0.2.5**，
55 个工具）。安装时自动落地到用户级 bin（Linux/macOS `~/.local/bin`，Windows `%USERPROFILE%\.local\bin`），
不需要 `go install`；其他平台用 `MCP_GITEE_ENT_BIN` 指到自己的二进制。

MCP 是进程级直连，**没有会话模式门槛**：任何会话都能取数，能不能写仍看云端 token。PR 子资源参数统一为
`pull_request_iid`（0.5.3 及以前是 `pull_request_id`）；附件下载遇到 404 会自动兜底。

## 取数与缓存

- 单次取数是「起一个 Node 脚本 → HTTPS 打 Gitee 企业 API」，单轮 RTT 约 0.4s；
- 读路由带 30s 缓存，执行器结果再记 60s，并发单飞（同一请求同时只发一次）；写完两层都清，重复点击 <10ms；
- 工作项列表悬停即预取详情，点下去直接命中缓存；
- 看板翻页改并发探测：307 条工作项 2.6s → 1.6s；工作项详情 1.8s → 0.5s；
- 面板先渲染上次快照再后台刷新，会话也能用 `gitee_board_snapshot` 直读同一份；
- 慢请求记一条 `[gitee-chat][slow]` 日志，`GITEE_CHAT_TRACE=1` 全量打印。

## 兼容性

DSH `^0.2.0-rc.2`、Node `^22.19 || >=24`、Linux / macOS / Windows。仓库里的 `check.yml`
在每次 push 与 `v*` tag 上跑同一套自检与发布流水线。

## 开发

```sh
npm install --legacy-peer-deps
npm run build        # lib/*.js + lib/types/（宿主 / agent / 面板）
npm run check        # 类型 + 冒烟 + 渲染断言 + 能力矩阵 + preset 交付 + MCP 二进制校验
npm run doctor       # 可移植性体检（preset / 插件行 / 产物 / token / 企业）
npm pack             # 产出可安装的 tgz（只含 package.json `files` 列出的文件）
```

`src/index.ts` 是宿主半（路由、缓存、写出口、设置），`src/agent.ts` 是 agent 半（工具与人格），
`src/client/` 是面板组件（`GiteeProjectView.tsx` 为整页入口），`scripts/gitee/gq.mjs` 是取数脚本。

## 文档

| 文档 | 给谁看 |
|---|---|
| [`USAGE.md`](./USAGE.md) | 使用者：界面怎么用、出问题怎么办 |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | AI：安装 / 配置 / 诊断 / MCP 用法（索引层，细节在 `references/`） |

English: [README.en.md](./README.en.md)

## 许可证

[MIT](./LICENSE) © 2026 保定多普康智能科技有限公司 · jackxiao (xd20260413@outlook.com)
