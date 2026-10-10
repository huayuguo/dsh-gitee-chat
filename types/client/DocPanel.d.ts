/**
 * 「知识库」面板 —— 整屏 Gitee 项目视图的第三个分段。
 *
 * ## 为什么这一版是"树"，而不是"文档列表"
 *
 * 实测（2026-09-15）发现：本企业的知识库**不是** `WikiInfo` 文档
 * （`list_enterprise_documents` 恒返回 0），而是
 * **`DocDirectory`（文件夹）+ `AttachFile`（上传的 .md/.docx/.pdf/.png…）组成的节点树**，
 * 只能从 `doc_nodes/level` 走。上一版把列表绑到 `list_enterprise_documents`，
 * 于是永远空白 —— 这个文件就是按真实形态重写的。
 *
 * ## 三条刻意的设计
 *
 * 1. **按需**：一次只列**一层**；展开哪个文件夹才拉哪个。不做全量遍历。
 * 2. **诚实**：附件内容目前**读不了**（MCP 还没有读取工具）。界面明确标注，
 *    而不是给一个点了没反应的入口 —— 空白界面比"看起来能用"更好排查。
 * 3. **不做假的缓存状态**：附件没有页级 version，硬套四态徽标就是骗人。
 *    等 P1′ 接上内容读取后，再按"节点 id + updated_at + size + 本地 sha256"做一致性。
 *
 * @module dsh-gitee-chat/client/DocPanel
 */
/** 面板入参。 */
export interface DocPanelProps {
    /** 当前会话 id（host 靠它解析 agent 作用域）。 */
    sessionId: string;
    /** 当前选中的项目（null = 只看公共知识库）。 */
    programId: number | null;
    /** 项目名。 */
    programName: string;
}
/**
 * 知识库面板（节点树 + 按需展开）。
 * @param props - 会话与当前项目。
 */
export declare function DocPanel(props: DocPanelProps): import("react").DetailedReactHTMLElement<null, HTMLElement>;
