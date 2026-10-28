# MCP 怎么用（Gitee 企业版 · 55 工具）

> 本文件只在需要“具体调哪个工具、参数叫什么、报错怎么翻”时读；日常看 `SKILL.md` 就够了。

## 2.1 你的会话是哪一种入口，别搞混

| 会话 | 模型看到的入口 | 工具数 |
|---|---|---|
| 用了 Gitee preset（「Gitee 项目管理」） | 原生工具 `mcp__gitee_ent__<tool>` | 55（`presets/gitee.patch.yml` 的 `--enabled-toolsets`） |
| 其它 preset | 一个两级入口工具 `gitee_ent`（`src/host/gateway.ts`） | 目录里 55 个，按需调 |

拿不准就先 `{"op":"list"}`。**不要凭记忆拼工具名** —— 55 个里有 `review_enterprise_pull` 这类
容易被想成 `update_enterprise_pull_assign` 的名字。

## 2.2 纪律：list → schema → call（不要再跳步）

```json
{"op":"list"}                                        // 目录：名字 + 一句话 + ✎ 是否写操作
{"op":"schema","name":"create_enterprise_repo_pull"} // 这个工具的完整参数表
{"op":"call","name":"create_enterprise_repo_pull","args":{…}}
```

参数表**只信 `op:schema` 与 Go 源码**（`../dsh-mcp-gitee-ent/operations/**/*.go` 的 `mcp.NewTool`），
不信任何手册（包括本文件）里抄的形状。

## 2.3 工具地图（55 个）

| 域 | 工具 | 读/写 |
|---|---|---|
| 企业 / 身份 | `list_enterprises`、`get_user_info` | 读 |
| 项目 | `list_programs`、`create_program` | 读 / 写（管理者） |
| 工作项 | `list_enterprise_issues`、`get_enterprise_issue_detail`、`list_enterprise_issue_comments`、`list_issue_types`、`list_issue_type_states`、`list_enterprise_labels`、`create_enterprise_issue`、`update_enterprise_issue`、`comment_enterprise_issue` | 读 / 写 |
| 仓库 | `list_enterprise_repositories`、`get_enterprise_repo_tree`、`get_enterprise_repository_file_content`、`create_enterprise_repository`、`list_enterprise_repo_releases`、`create_enterprise_repo_release` | 读 / 写 |
| 合并请求 | 见 §2.5（12 个） | 读 / 写 |
| 成员 / 团队 / 迭代 | `list_enterprise_members`、`list_enterprise_groups`、`list_scrum_sprints`、`list_scrum_versions`、`create_scrum_sprint` | 读 / 写 |
| 文档 / 知识库 | `list_doc_nodes`、`list_program_doc_nodes`、`list_enterprise_documents`、`list_enterprise_document_pages`、`get_enterprise_document_page`、`download_enterprise_document`、`download_attach_file`、`create_doc_node`、`create_enterprise_document`、`create_enterprise_document_node`、`create_wiki`、`attach_doc_file`、`update_enterprise_document_page`、`upload_enterprise_document_files`、`rename_enterprise_document_folder`、`move_doc_node`、`set_doc_node_auth`、`recycle_doc_node`、`delete_doc_node` | 读 / 写 |

文档写回两条硬约束：`update_enterprise_document_page` 必须带 `expected_version`（乐观锁，过期就重新读）；
文件类工具（`download_enterprise_document` / `upload_*` / `attach_doc_file`）必须带 `workspace`，
且 `output_directory` **必须已存在**（`mkdir` 一下再传）。

## 2.4 人格三档：谁该调哪些

工具**都挂得上**（55 个），但按人格收敛用法；只有写通道是**硬拦**的。

| 档 | 人格 | 工具视野 | 写动作 |
|---|---|---|---|
| `manager` | 企业拥有者 / 超管 / 管理员 | 55 | 全 25 个写工具：建项目、建仓库、**合并 PR**、建 Release、知识库权限/回收/删除 |
| `project` | 某项目负责人 | 48 | exec 14 个 + 建迭代、建知识库、移动/改名文档节点 |
| `exec` | 只负责工作项 | 40 | 14 个：建/改/评论工作项，**建 PR**、评论 PR、改 PR、审查通过/驳回/撤销、测试通过，文档在可写目录内建/改 |

- 只读部署（配置 `allowWrites: false`）会把**全部 25 个写工具**硬拦（`src/generated/tierWrites.ts` 的 `WRITE_TOOLS`），
  报错不是「没权限」而是明确的「写通道已关闭」。此时审查/测试/合并按钮也会明确报错。
- 合并属于 **manager 档**：执行档的 AI 想合并要在界面上点，或让管理者来调。

## 2.5 PR 工具参数表（逐个对过 Go 源码）

| 工具 | 必填 | 关键选填 | 备注 |
|---|---|---|---|
| `create_enterprise_repo_pull` | `enterprise_id`、`project_id`、`source_branch`、`target_branch`、`title` | `body`、`assignee_id`/`tester_id`（逗号分隔）、`pr_assign_num`、`pr_test_num`、`draft`（**字符串** `"true"`/`"false"`）、`label_ids`、`source_repo` | `project_id` 收仓库 id **或** `path_with_namespace` |
| `update_enterprise_pull` | `enterprise_id`、`project_id`、`pull_request_iid` | `title`、`body`、`target_branch`、`state_event`(close/reopen)、`assignee_id`、`tester_id`、`pr_assign_num`、`pr_test_num`、`check_state`(0/1)、`test_state`(0/1)、`draft`（**布尔**）、`priority`(0–4)、`milestone_id`、`related_issue_id`、`label_ids` | 改判/改指派/开启审查测试都走它 |
| `merge_enterprise_pull` | 同上三个 | `merge_method`(merge/squash/rebase，默认 merge)、`title`、`description` | 合并前先看 `get_enterprise_pull_auth` |
| `comment_enterprise_pull` | 同上三个 + `body` | `reply_id` | 结论写回用这个 |
| `list_enterprise_pull_comments` | 同上三个 | `page`、`per_page` | |
| `list_enterprise_pull_files` | 同上三个 | `page`、`per_page`(≤100)、`w`(1=隐藏空白)、`head_sha`、`base_sha` | 返回 `{is_overflow,total_count,real_count,data[]}` |
| `get_enterprise_pull_auth` | 同上三个 | — | 返回 `can_check`/`can_test`/`can_merge`/`can_close`/`can_reopen` 等布尔 |
| `review_enterprise_pull` | 同上三个 | `action`(accept/reject/reset，默认 accept)、`force_accept`(1/0) | 审查结论 |
| `test_enterprise_pull` | 同上三个 | `force_accept`(1/0) | **只能通过**，没有「测试不通过」 |
| `get_enterprise_pull_detail` | 同上三个 | — | |
| `get_enterprise_pull_diff` | 同上三个 | — | 整份 diff 文本 |
| `list_enterprise_pulls` | `enterprise_id` | `state`(opened/closed/merged)、`scope`(assign/test/create/…)、`search`、`sort`、`direction`、`labels`、`can_be_merged`(0/1)、`target_branch`、`source_branch`、`project_id`(**Number**)、`page`、`per_page` | 视角口径见 §3.2 |

`pull_request_iid` 一律是**仓库内 IID**（界面上显示的 `!12`），不是全局 `id`。

## 2.6 六个口径坑（踩过一次就够）

1. **`draft` 两种类型**：`create_*` 要字符串 `"true"`/`"false"`，`update_*` 要布尔 `true`/`false`。
2. **`project_id` 两种口径**：建 PR 时收 id 或 `path_with_namespace`；`list_enterprise_pulls` 的 `project_id` 是 Number。
3. **没有「列分支」工具**。整个后端只给仓库的 `default_branch` 字段。所以源分支只能人/模型给，
   目标分支默认取仓库默认分支（`src/client/PrCreateDialog.tsx` 里 `target.trim()===''` 就回落默认分支）。
4. **建 PR 不能顺手开启审查/测试**：`check_state`/`test_state` 不在 create 的参数里，
   要建完再 `update_enterprise_pull`（界面上是详情抽屉的「开启审核流程…」/「开启测试流程…」）。
5. **驳回后改判要先撤销**：已标「不通过」再直接 accept 会被 Gitee 拒（`already-reviewed`），
   先 `action=reset` 再 accept。撤销一个本来就没有结论的审查会回「目标不存在或状态错误」—— 正常，不是故障。
6. **审查 ≠ 测试**：`review_enterprise_pull` 有 accept/reject/reset；`test_enterprise_pull` 只有通过。
   界面上「审核+测试通过」是按顺序打这两枪，任一步失败就停在原地。

## 2.7 错误怎么翻

| 原文（工具返回/日志） | 人话 | 处置 |
|---|---|---|
| `[param_error] Invalid parameter: enterprise_id (parameter is required)` | 没带企业 id | 先 `list_enterprises` 拿 id；单企业可留空让服务端回落 |
| `401 … 企业未授权此应用进行访问` | 企业 id 是 0 / 选错企业 / token 不属于这家企业 | 切企业（设置页或 `gitee_enterprises {use:<id>}`），别猜 |
| `Only For MCP Gitee Enterprise Application` | 用 curl 直接打了企业版端点（UA/应用门禁） | 这条通道**只给 MCP 进程**用；诊断要加 `User-Agent: mcp-gitee-ent …` 也只是排障，不要拿它做集成 |
| `Access token is wrong type` | 把企业 token 拿去调标准 `api/v5` | 企业 token 不能跨用；v5 要另配个人 token |
| `已对该pr标记了…` → `already-reviewed` | 之前标过「不通过」 | 先 `review_enterprise_pull action=reset` 再 accept |
| `目标不存在或状态错误` → `nothing-to-reset` | 没有可撤销的结论 | 不需要撤销；要开启流程用 `update_enterprise_pull check_state=1` |
| `审查失败 …` → `check-failed` | 不是该 PR 的审查人 / PR 已关闭 / 已标过结论 | 看 `get_enterprise_pull_auth` 的 `can_check` |
| `测试没有成功 …` → `test-failed` | 不是测试人，或测试流程没开 | 先「开启测试流程」（`test_state=1`） |
| `没有找到企业 token。` → `no-token` | 三处都没配 | 见 `references/install.md` 的 token 一节 |
| `403` / `404` | 云端角色不够，或对象不存在/不属于你 | 换有权限的人做；别改用例绕 |

## 2.8 数据时效：缓存、快照工具、新鲜期

看板数据不是每次都现拉：宿主把结果放在**三层**里，命中即省一次「4 页工作项 + 成员 + PR」往返。

| 层 | 来源标记 | 什么时候有 | 重启后还在吗 |
|---|---|---|---|
| 进程内 | `source=memory` | 刚拉过、且没超过新鲜期 | ❌ |
| 落盘快照 | `source=disk` | 上次拉过并写了盘（`cache.persist`，默认开） | ✅ |
| 现拉 | `source=remote` | 缓存没有/过期，或 `refresh=true` | — |

新鲜期默认 **60 秒**，在「设置 → Gitee 企业项目 → 缓存与后台刷新」里改（写本地覆盖，保存即生效）：
`cache.ttlSeconds`（最小 10，0 = 关缓存）、`cache.persist`（是否落盘）、
`cache.agentReadable`（关掉 = 会话里读不到快照，只能现拉）。
另有 `autoRefresh.enabled`（默认关）/ `autoRefresh.intervalSeconds`（默认 60，最小 10）/
`autoRefresh.idleMinutes`（默认 30：这么久没人用面板就不再后台刷）。

**两个工具的分工**：

- `gitee_board`：必要时联网（缓存过期就现拉），输出摘要 + 时效行。
- `gitee_board_snapshot`：**绝不联网**，只读缓存/落盘；`format=compact`（默认，计数 + 时效）或 `full`（带项目与我的工作项明细）。

**提醒义务**（用户明确要求）：看到时效行就要在回答里带上「数据抓取于 N 秒前」；
`stale: true` 时必须说明「可能不是最新」并建议刷新。不要根据 `generatedAt` 自己猜新旧。

## 2.9 企业 token 的边界（一条红线）

- `GITEE_ENT_MCP_ACCESS_TOKEN` **只给 MCP 用**。直接 `curl https://api.gitee.com/enterprises/...` 会 401
  `Only For MCP Gitee Enterprise Application`；拿它调标准 `api/v5` 会 `Access token is wrong type`。
- 所以「用 curl 验证一下」这类排障动作**没有意义**，别写进方案里。要验证就用 `gitee_chat_health` 或 `op=call`。
