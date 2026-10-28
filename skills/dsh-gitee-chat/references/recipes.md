# 怎么干活（场景 → 动作 → 命令）

> 本文件只照“这个场景具体怎么一步步做完”时读。

## 4.1 场景 → 动作

| 用户说 | 谁来做 | 动作 |
|---|---|---|
| 看项目 / 谁逾期了 / 生成周报 | AI | `gitee_board`（`scope: portfolio` / `mywork`，`refresh` 强制重拉） |
| 看某个项目细节 | 人 | 面板「项目」分段 |
| 建 PR | 人 **或** AI | §4.2 / §4.3（两条路） |
| 审核这个 PR | AI 起草 + 人确认 | §4.4；结论用 `comment_enterprise_pull` 写回 |
| 测试通过 / 合并 | 人点（或 manager 档 AI） | §3.3；合并前先 `get_enterprise_pull_auth` |
| 改工作项状态 / 指派 / 评论 | 人 **或** AI | §3.5 / §4.5 |
| 阈值不对 | 人确认 + 改配置 | §3.8 表 + `references/install.md` |
| 取不到数据 | AI 先自检 | §4.6 |

## 4.2 路 1：UI 手动建 PR

1. 合并请求页 → 右上「＋ 新建 PR」（或从仓库卡片的「合并请求」tab 进）。
2. 填表（`PrCreateDialog.tsx`）：

| 字段 | 必填 | 默认 / 说明 |
|---|---|---|
| 仓库 | ✓ | 下拉，来自当前项目的仓库清单；从仓库详情进入时预选 |
| 源分支 | ✓ | **下拉**，默认取「第一个非默认分支」；只有默认分支时会禁用并提示先推分支 |
| 目标分支 | ✓ | **下拉**，默认 = 仓库默认分支 |
| 标题 | ✓ | 建议 `feat: …` / `fix: …` |
| 描述 | — | 文本域 + 三个按钮：「套用模板」填干净骨架 `pr.md`；「✨ AI 起草」按真实 diff 生成标题+正文；「写什么？」展开 `pr-guide.md` 填写说明 |
| 审查 / 测试人数 | — | 各默认 1；0 = 不要求 |
| 草稿 | — | 勾了就建成 draft |

3. 「创建」→ `POST /pr/create` → 成功后关闭对话框、刷新列表、**直接打开新 PR 详情**；
   失败按返回的 `code` 显示可行动提示（`bad-request` 最常见：源=目标、标题空、没选仓库）。
4. 建完要开始评审：到详情抽屉点「开启审核流程…」/「开启测试流程…」——
   这两个开关**不在建 PR 的参数里**，别指望一步到位。

## 4.3 路 2：AI 调 MCP 建 PR

最小可用参数（`op: schema` 确认后再调）：

```json
{"op":"call","name":"create_enterprise_repo_pull","args":{
  "enterprise_id": 11111111,
  "project_id": "group/repo",
  "source_branch": "feature/login",
  "target_branch": "master",
  "title": "feat: 登录页支持扫码",
  "body": "<按 templates/pr.md 的分节写>",
  "pr_assign_num": 1,
  "pr_test_num": 1,
  "draft": "false"
}}
```

要点：

- `project_id` 收仓库 id 或 `path_with_namespace`；`draft` 是**字符串**（`update_enterprise_pull` 里是布尔）。
- 正文按 `templates/pr.md` 的分节（背景 / 改动点 / 怎么验证 / 风险与回滚 / 关联工作项）写，别写成一坨。
- 分支名必须自己知道。**没有工具能列分支** —— 不知道就问用户，或从 `get_enterprise_repo_tree` /
  本地 `git branch -r` 侧证，绝不编一个分支名去试。
- 建完用返回的 `iid` 继续：`update_enterprise_pull`（`check_state`/`test_state`=1）、`comment_enterprise_pull`（补自检结果）。

## 4.4 审核 / 测试 / 合并（AI 侧）

1. `get_enterprise_pull_detail` + `list_enterprise_pull_files`（或 `get_enterprise_pull_diff`）看清改动。
2. 按 `templates/review.md` 出结论（每条带 `文件:行`，分级 blocker/major/minor/nit），
   用 `comment_enterprise_pull` 发到 PR。
3. 只有「没有 blocker」且用户明确要求时才 `review_enterprise_pull action=accept`；先看 `get_enterprise_pull_auth`
   的 `can_check`，别撞 `check-failed`。测试同理：`test_enterprise_pull`（只能通过），结论按 `templates/test.md` 写。
4. 合并：`merge_enterprise_pull`（`merge_method` 默认 merge）。**合并不可逆** ——
   先确认 `can_merge`、审查与测试都过、用户明确说要合。

## 4.5 工作项写回（AI 侧）

- 改状态：先 `list_issue_type_states` 拿 `state_id`，再 `update_enterprise_issue`。
- 改派：先 `list_enterprise_members` 拿成员 id。
- 评论：`comment_enterprise_issue`。
- 只在用户明确要求时改；一次改一项，改完读回来确认（不要连发三条让人替你验）。

## 4.6 取不到数据：排查顺序（别跳）

1. `gitee_chat_health` —— token 有没有、企业能不能解析、API 通不通、MCP 后端是不是随包版（`matchesManifest`）。
2. `gitee_enterprises` —— 多家企业却没指定时**必然**报错（插件绝不替你挑一家）。
3. `gitee_role` —— 人格不对会导致「这个按钮点了没反应 / 写动作被拒」。
4. 面板 `/api/gitee-chat/ping` —— `scriptExists: false` 是路径病；`mcp.manifest.toolCount` 不是 55 说明二进制被换过。
5. 仍然不行 → `references/install.md` 的排障表。
