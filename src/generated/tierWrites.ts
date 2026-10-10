/**
 * 本文件由 scripts/gen-capabilities.mjs 从 scripts/gitee/gq.mjs 的 TIERS 生成，请勿手改。
 *
 * 用途：host 半的公开 gateway（`gitee_ent`）在只读部署下必须硬拦写工具，
 * 而那个判定不能依赖「身份已经解析出来」——`role.current()` 可能是 null。
 */

/** 三档写工具名的并集（= 只读部署必须硬拦的全部工具）。 */
export const WRITE_TOOLS: readonly string[] = [
  "attach_doc_file",
  "comment_enterprise_issue",
  "comment_enterprise_pull",
  "create_doc_node",
  "create_enterprise_issue",
  "create_enterprise_repo_pull",
  "create_enterprise_repo_release",
  "create_enterprise_repository",
  "create_program",
  "create_scrum_sprint",
  "create_wiki",
  "delete_doc_node",
  "merge_enterprise_pull",
  "move_doc_node",
  "recycle_doc_node",
  "set_doc_node_auth",
  "update_enterprise_document_page",
  "update_enterprise_issue",
  "update_enterprise_pull",
  "upload_enterprise_document_files"
]

/** 各档自己的写工具（exec ⊂ project ⊂ manager）。 */
export const WRITE_TOOLS_BY_TIER: Readonly<Record<'exec' | 'project' | 'manager', readonly string[]>> = {
  "exec": [
    "create_enterprise_issue",
    "update_enterprise_issue",
    "comment_enterprise_issue",
    "create_enterprise_repo_pull",
    "comment_enterprise_pull",
    "update_enterprise_pull",
    "create_doc_node",
    "attach_doc_file",
    "update_enterprise_document_page",
    "upload_enterprise_document_files"
  ],
  "project": [
    "create_enterprise_issue",
    "update_enterprise_issue",
    "comment_enterprise_issue",
    "create_enterprise_repo_pull",
    "comment_enterprise_pull",
    "update_enterprise_pull",
    "create_doc_node",
    "attach_doc_file",
    "update_enterprise_document_page",
    "upload_enterprise_document_files",
    "create_scrum_sprint",
    "create_wiki",
    "move_doc_node"
  ],
  "manager": [
    "create_enterprise_issue",
    "update_enterprise_issue",
    "comment_enterprise_issue",
    "create_enterprise_repo_pull",
    "comment_enterprise_pull",
    "update_enterprise_pull",
    "create_doc_node",
    "attach_doc_file",
    "update_enterprise_document_page",
    "upload_enterprise_document_files",
    "create_scrum_sprint",
    "create_wiki",
    "move_doc_node",
    "create_program",
    "create_enterprise_repository",
    "merge_enterprise_pull",
    "create_enterprise_repo_release",
    "set_doc_node_auth",
    "recycle_doc_node",
    "delete_doc_node"
  ]
}
