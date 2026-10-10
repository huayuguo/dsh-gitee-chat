/**
 * 「仓库」面板 —— 整屏 Gitee 项目视图里与 项目 / 固定分析 / 知识库 并列的分段。
 *
 * ## 两个口径（需求原话）
 *
 *   - **选中了项目** → 只列**该项目下的**仓库（host 用 `program_id` 过滤）；
 *   - **没选项目** → 只列**企业内部开源**的仓库（`scope=internal-open`）。
 *
 * 两种都是 Gitee 自己的过滤参数，插件不自己筛。
 *
 * ## WIKI 为什么挂在仓库下面
 *
 * Gitee 的仓库 WIKI 是**仓库的一个子功能**（`/projects` 上的
 * `wiki_enabled_with_content` 就是它），不是企业/项目知识库那一套 `doc_nodes`
 * —— 后者是企业级或项目级，跟仓库没有从属关系（实测传仓库 id 返回 0）。
 * 所以"仓库下面展示 WIKI"是**唯一**符合 Gitee 数据模型的位置。
 *
 * ## 预览分工（与知识库面板一致）
 *
 * 装了 `dsh-better-sidebar` 就点一下交给它；没装则只内联预览 `.md`。
 * 见 `client/sidebar.ts`。
 *
 * @module dsh-gitee-chat/client/RepoPanel
 */
/** 面板入参。 */
export interface RepoPanelProps {
    /** 当前会话 id（host 靠它解析 agent 作用域）。 */
    sessionId: string;
    /** 当前选中的项目（null = 只列企业内部开源仓库）。 */
    programId: number | null;
    /** 项目名。 */
    programName: string;
}
/**
 * 仓库面板（左列表 + 右 WIKI）。
 * @param props - 会话与当前项目。
 */
export declare function RepoPanel(props: RepoPanelProps): import("react").DetailedReactHTMLElement<null, HTMLElement>;
