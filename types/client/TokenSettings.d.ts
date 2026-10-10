/**
 * Gitee 企业版 token 配置 —— **只有应用设置一个入口**：
 * `GiteeSettingsSection` 注册在槽位 `settings.section`（应用「设置 → Gitee 企业项目」，
 * 与「插件市场」并列）。不知道 token 该去哪配的人，第一眼就该在设置里找到它。
 *
 * ⚠️ **不要再把配置入口做进「Gitee 项目」标签页**（曾经有一个 `⚙ 设置` 弹窗，已删除）：
 * 那个标签页只在 Gitee 模式的会话里才有内容，而"能不能进 Gitee 模式"和"有没有 token"
 * 本来就可能互为前提 —— 把配置放进标签页，等于让使用者先有 token 才能找到配 token 的地方。
 * 机器级配置就该待在机器级的设置页里。
 *
 * `TokenForm` 干实际的事：状态行 + 输入 + 保存 →
 * `POST /api/gitee-chat/token` → 宿主写 `~/.dsh/.gitee-chat/token` → gq 脚本下次调用即读到。
 *
 * @module dsh-gitee-chat/client/TokenSettings
 */
/**
 * token 表单主体：配置状态行 + 输入框 + 保存按钮。
 *
 * @param props.onSaved - 保存成功后的回调。
 */
export declare function TokenForm(props: {
    onSaved?: () => void;
}): import("react").DetailedReactHTMLElement<null, HTMLElement>;
/**
 * 企业选择器 —— **配好 token 之后就在这里选企业**。
 *
 * 以前换企业只能「让 AI 跑 `gq enterprises --use <id>`」：那等于把一条机器级配置
 * 藏进一段对话里，还得先知道有这条命令。这里把它做成设置页的正规控件：
 * 列出 token 可见的企业、标出当前用的是哪家、选了立刻写入，并让宿主**同时**失效
 * 看板缓存与身份人格（见 `host/enterprise.ts`）—— 否则会出现「列表换了、卡片还是
 * 上一家」的静默错数据。
 *
 * 取不到列表时只显示一句提示，不弹错：它与 token 表单同节，顺序本就是先配 token。
 *
 * @param props.reloadKey - 外部（token 保存成功）触发的重新拉取信号。
 */
export declare function EnterprisePicker(props: {
    reloadKey?: number;
}): import("react").DetailedReactHTMLElement<{
    style: {
        marginTop: number;
    };
}, HTMLElement>;
/**
 * 「设置 → Gitee 企业项目」分节（正式入口）。
 *
 * 槽位 `settings.section` 传给分节的 owner props 只有 `close`，这里用不上 ——
 * 配好 token 之后提示使用者去新建 Gitee 模式的会话即可，不需要替他跳转。
 */
export declare function GiteeSettingsSection(_props: {
    close?: () => void;
}): import("react").DetailedReactHTMLElement<{
    style: {
        maxWidth: number;
        lineHeight: number;
    };
}, HTMLElement>;
