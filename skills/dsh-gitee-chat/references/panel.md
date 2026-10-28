# 面板能干什么（Gitee 项目页 · 六个分段）

> 本文件只在需要“界面上这个按钮在哪、这个字段是什么”时读。

## 3.1 六个分段（`GiteeProjectView.tsx`）

> 返回按钮统一绿色：`← 回到会话`（整页模式）、`← 返回项目`（仓库下钻）、`← 返回工作项列表`。

| 分段 | 内容 |
|---|---|
| 概览 | 4 张 KPI（项目 / 工作项 / 待我处理 PR / 逾期）、状态分布、项目进度、归我处理的风险、PR 待办、数据新鲜度（实时 or 样例数据） |
| 项目 | 项目列表 + 项目详情（工作项、进度、风险），可建工作项 |
| 我的工作项 | 负责人或协作者是我的工作项，跨项目汇总，可点进项目详情（§3.7 之前的仓库卡片改在项目页下钻） |
| 合并请求 | PR 全流程（§3.2–§3.4） |
| 知识库 | 节点树、正文、附件、缓存与核对、写回 |
| 固定分析 | 9 张固定分析卡（§3.8） |

## 3.2 合并请求页（`src/client/PrTab.tsx`）

- **4 张 KPI**：待我审核 / 待我测试 / 我提出的 / 可合并。计数由宿主算（`/pr/list` 的 `counts`），前端不猜。
- **视角 chips**（`PrTab.tsx`）：待我审核＝打开+待审查+我是审查人；待我测试＝打开+待测试+我是测试人；
  我提出的＝我创建的；全部＝我能看到的。
- **状态 chips**：打开 / 已合并 / 已关闭 / 全部；搜索 250ms 防抖，命中标题、作者、分支。
- **每行**：`!iid`、标题、草稿 Tag、仓库路径、`源分支 → 目标分支`、作者、更新时间、审查/测试状态、可合并 Tag，行尾「AI 审核」「查看 / 去处理」。
- **口径面板**：页内「视角与判定口径」把上面四条口径写在界面上，争议时看它。
- **深链**：`#pr=<repoId>:<iid>&dwpane=ai|files|notes&act=merge|check|test|checkAndTest|comment|openCheck|openTest`
  —— 想让人直接落到某个动作，发这种链接，不要口述路径。
- 头部「＋ 新建 PR」打开 §4.2 的对话框（`PrCreateDialog.tsx`）。

## 3.3 PR 详情抽屉（`src/client/PrDrawer.tsx`）

四个 tab：概览（基本信息 + PR 说明）、变更文件（按文件的状态/增删行/diff）、评论、AI 审核。

动作按钮（`PrDrawer.tsx` 起）：

| 按钮 | 落到的工具 | 什么时候可用 |
|---|---|---|
| 审核通过… | `review_enterprise_pull` accept | `auth.can_check` |
| 测试通过… | `test_enterprise_pull` | `auth.can_test` |
| 审核+测试通过… | 顺序打上面两枪，任一步失败即停 | 两个权限都有 |
| 合并… | `merge_enterprise_pull`（可选 merge/squash/rebase） | `auth.can_merge`；不满足合并条件时明确提示「审查或测试未通过」 |
| 发表评论… | `comment_enterprise_pull` | 打开状态 |
| 关闭 / 重新打开… | `update_enterprise_pull state_event` | `can_close` / `can_reopen` |
| 开启审核流程… / 开启测试流程… | `update_enterprise_pull check_state=1` / `test_state=1` | `auth.update` |

每个动作都有二次确认对话框（会写清「会不会通知作者」「合并不可逆」这类后果）。
已合并 / 已关闭的 PR 是**只读**的。

## 3.4 AI 审核：投给子智能体，不是主会话

链路：面板「AI 审核」→ `POST /pr/ai-review/subagent`（`src/host/routes.ts`）→ 在当前所选会话下
`subagents.startActivation`（provider `spawn`）跑一个子智能体 → 结论回面板 → 人确认后写回 PR 评论。

| 事实 | 说明 |
|---|---|
| 耗时 | 约 60s 出结论；面板有运行态与「取消」 |
| 会话必须活跃 | 非活跃会话返回 409 `session-not-live` —— 先在界面里打开那个会话再来 |
| 没装配子智能体 | 501 `no-subagents`，提示升级 DSH |
| 结论格式 | 每条带 `文件:行`；分级 blocker/major/minor/nit + 「未验证」 |
| 自动通过 | 勾了「允许 AI 在结论为通过时自动审核通过」才会 `review_enterprise_pull accept`；**不会自动合并** |
| 模板 | `templates/review.md`、`templates/test.md`；界面上改过就存成用户副本 `$DSH_HOME/.gitee-chat/templates/`，内置永不覆盖 |
| 范围 | 全量 / 仅业务代码（跳文档、配置、锁文件）/ 指定文件 |

「投递到」那行有胶囊勾选框**子智能体**（默认勾选）：勾选 = 纯后台（`delivery: 'caller'`，会话不留痕）；
取消勾选 = 同一个跑批用 `delivery: 'parent'`，DSH 会往所选主会话追加一条 `subagent-settled` 结算消息
（人看得见、可以接着追问），结论**照样回面板/回填表单**。查进度 `GET /pr/ai-review/subagent?runId=…`，
取消 `POST /pr/ai-review/subagent/cancel`。

## 3.5 工作项：看详情与写回（`src/client/IssueDetail.tsx`）

详情字段：状态、负责人、类型、作者、创建/更新、计划与实际起止、截止、完成、预估与登记工时、里程碑、标签。
写回三个动作都走 `POST /api/gitee-chat/write`（`src/host/routes.ts`），每次写有独立 loading 与失败原因；
只读部署下明确拒绝。

| 界面 | `op` | 对应 MCP |
|---|---|---|
| 改状态 | `set-state`（`stateId`） | `update_enterprise_issue` |
| 改派 | `assign`（`assigneeId`） | `update_enterprise_issue` |
| 发评论 | `comment`（`body`） | `comment_enterprise_issue` |

## 3.6 新建工作项（`src/client/IssueCreate.tsx` + `IssueDialog.tsx`）

两个入口共用一套表单：项目页（只挂项目）、仓库页（带 `repoId`，工作项挂在仓库下）。
字段：标题*、类型（默认第一个）、负责人（默认第一个成员）、优先级（P0–P3，默认 P2）、计划开始（默认今天）、
截止（默认下周五）、描述。提交 `POST /api/gitee-chat/issue-create`（`routes.ts`）→ `create_enterprise_issue`，
成功后刷新列表并提示「已创建 <ident> <title>」。

## 3.7 仓库卡片（`src/client/RepoPanel.tsx`）

- 三段视图：本项目 / 企业内部开源 / 全部（`RepoPanel.tsx`）；仓库信息 8 项（id、可见性、默认分支、
  成员数、大小、状态、最近推送、WIKI 有无）。
- 三个 tab：工作项（列表 + 新建）、合并请求（该仓库的 PR）、WIKI（页面树 + 正文）。仓库里的「新建工作项」
  和「查看 PR」都带 `repoId`，是建 PR 对话框的天然入口。
- **WIKI 不走 MCP**：宿主 `git clone {path_with_namespace}.wiki.git` 缓存后本地读（`src/host/wikiCache.ts`）；
  用 `name` 拼会 404 —— 两者经常不同。

## 3.8 固定分析：9 张卡（`src/client/AnalysisCards.tsx`）

① 项目健康度（低分在前）② 成员负载 ③ 延期清单（按逾期天数倒序）④ 停滞 >N 天 ⑤ 标签规范（按标签维度查合规）
⑥ 进度偏差 ⑦ 交付容量 ⑧ 里程碑达成 ⑨ 交付趋势（按周，新增/完成/周末积压）。

阈值（默认值，`scripts/gitee/analysis.mjs` 的 `THRESHOLD_DEFAULTS`；可用 `config.thresholds` 或环境变量覆盖）：

| 键 | 默认 | 含义 | 环境变量 |
|---|---|---|---|
| `stallDays` | 14 | 进行中且这么多天没更新 = 停滞 | `GITEE_CHAT_STALL_DAYS` |
| `overloadOpen` | 8 | 未完成数 ≥ 此值 = 过载 | `GITEE_CHAT_OVERLOAD_OPEN` |
| `overloadOverdue` | 2 | 逾期数 ≥ 此值 = 过载 | `GITEE_CHAT_OVERLOAD_OVERDUE` |
| `requiredLabels` | 3 | 规范要求的三维标签数（0 = 关闭该检查） | `GITEE_CHAT_REQUIRED_LABELS` |
| `weeklyCapacity` | 10 | 每周交付容量（迭代超载判定） | `GITEE_CHAT_WEEKLY_CAPACITY` |
| `trendWeeks` | 8 | 交付趋势回看周数 | `GITEE_CHAT_TREND_WEEKS` |
| `milestoneRiskDays` | 7 | 里程碑剩余天数小于它且尚有未完成 = 有风险 | `GITEE_CHAT_MILESTONE_RISK_DAYS` |

用户说「这条不该算停滞 / 标签数不对」时，先给出这张表的当前值，再问他要改成多少 —— 别直接改配置。
