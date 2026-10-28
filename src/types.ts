/**
 * dsh-gitee-chat 的线上类型（host ↔ client 共用，只走 JSON）。
 *
 * 这些类型描述的是 **gq 脚本产出的 payload** 与 **HTTP 路由的响应信封**，
 * 不是 Cordis/DSH 的活对象。卡片只消费这里声明的字段。
 *
 * @module dsh-gitee-chat/types
 */

/** 取数范围。 */
export type BoardScope = 'portfolio' | 'mywork'

/** 单条风险。 */
export interface RiskRow {
  /** overdue=逾期 / urgent=高优先级未完成 / unassigned=无人认领。 */
  kind: 'overdue' | 'urgent' | 'unassigned'
  /** 视觉级别。 */
  level: 'high' | 'mid' | 'low'
  ident: string
  title: string
  owner: string
  programId: number
  detail: string
}

/** 一个项目的聚合行。 */
export interface ProgramRow {
  id: number
  name: string
  ident: string
  category: string
  status: number
  assignee: string
  reposCount: number
  usersCount: number
  updatedAt: string
  total: number
  done: number
  overdue: number
  progressing: number
  /** 完成率 0-100。 */
  progress: number
}

/** 工作项状态分布的一项。 */
export interface DistributionRow {
  state: string
  count: number
}

/** 看板 KPI。 */
export interface BoardKpi {
  programs: number
  issues: number
  progressing: number
  done: number
  overdue: number
  unassigned: number
}

/** 项目健康度（固定分析）。 */
export interface ProgramHealth {
  programId: number
  name: string
  score: number
  level: 'good' | 'warn' | 'bad'
  total: number
  open: number
  overdue: number
  unassigned: number
  stalled: number
  completionRate: number
}

/** 成员负载（固定分析）。 */
export interface OwnerLoad {
  name: string
  open: number
  progressing: number
  overdue: number
  highPriority: number
  level: 'ok' | 'at-risk' | 'overloaded'
}

/** 延期项。 */
export interface SlipRow {
  ident: string
  title: string
  owner: string
  programId: number
  programName: string
  overdueDays: number
  priorityHuman: string
}

/** 停滞项（进行中但很久没动）。 */
export interface StalledRow {
  ident: string
  title: string
  owner: string
  programId: number
  programName: string
  idleDays: number
  state: string
}

/** 规范体检项（缺负责人/截止/计划时间，或标签数不符）。 */
export interface ComplianceRow {
  ident: string
  title: string
  owner: string
  programId: number
  programName: string
  problems: string[]
}

/** 进度偏差：计划 vs 实际（E-07）。 */
export interface ProgressRow {
  ident: string
  title: string
  owner: string
  programId: number
  programName: string
  state: string
  open: boolean
  /** 是否有截止日期（有计划）。 */
  hasPlan: boolean
  planStartedAt: string
  startedAt: string
  deadline: string
  finishedAt: string
  /** 实际开始 − 计划开始（天，正数=晚开工）；缺任一时间为 null。 */
  startDelayDays: number | null
  /** 实际完成 − 截止日期（天，正数=晚交付）；未完成为 null。 */
  finishDelayDays: number | null
  /** 截止日期 − 现在（天，负数=已逾期）。 */
  remainingDays: number | null
  lateStart: boolean
}

/** 逐项目的进度偏差汇总。 */
export interface ProgressProjectRow {
  programId: number
  name: string
  measured: number
  lateStarts: number
  avgStartDelay: number | null
  onTimeStartRate: number | null
  finishedMeasured: number
  finishedLate: number
  avgFinishDelay: number | null
  openWithoutPlan: number
}

/** E-07 进度偏差分析。 */
export interface ProgressAnalysis {
  totals: {
    measured: number
    lateStarts: number
    onTimeStartRate: number | null
    avgStartDelay: number | null
    finishedMeasured: number
    finishedLate: number
    avgFinishDelay: number | null
    openWithoutPlan: number
  }
  projects: ProgressProjectRow[]
  worst: ProgressRow[]
}

/** 交付容量的一周（E-08）。 */
export interface CapacityWeekRow {
  weekStart: string
  weekEnd: string
  /** 该周截止的未完成项数。 */
  planned: number
  /** 其中已经逾期的。 */
  overdue: number
  estimatedMinutes: number
  byProgram: Record<string, number>
  /** 相对本周的偏移：0=本周，负数=已过去。 */
  weeksAgo: number
  capacity: number
  /** planned − capacity。 */
  overflow: number
  overloaded: boolean
  topProgram: string
}

/** E-08 迭代容量分析。 */
export interface CapacityAnalysis {
  weeklyCapacity: number
  /** 是否有工作项登记了预估工时 —— 决定能不能按工时（而不只是项数）谈容量。 */
  hoursTracked: boolean
  estimatedHours: number
  registeredHours: number
  noDeadline: number
  rows: CapacityWeekRow[]
  totals: {
    plannedAhead: number
    weeksAhead: number
    avgPerWeekAhead: number
    overloadedWeeks: number
    carryOver: number
  }
}

/** 里程碑（E-09）。 */
export interface MilestoneRow {
  id: number
  title: string
  state: string
  startDate: string
  dueDate: string
  programId: number
  programName: string
  total: number
  done: number
  open: number
  overdue: number
  daysLeft: number | null
  verdict: 'achieved' | 'missed' | 'at-risk' | 'on-track'
  rate: number
}

/** E-09 里程碑达成分析。 */
export interface MilestoneAnalysis {
  rows: MilestoneRow[]
  totals: {
    count: number
    achieved: number
    missed: number
    atRisk: number
    coveredIssues: number
    totalIssues: number
  }
}

/** 交付趋势的一周（E-10）。 */
export interface DeliveryWeek {
  weekStart: string
  label: string
  created: number
  finished: number
  net: number
  /** 该周末的累计未完成（积压）。 */
  openEnd: number
}

/** E-10 交付趋势分析。 */
export interface DeliveryAnalysis {
  weeks: number
  series: DeliveryWeek[]
  totals: {
    created: number
    finished: number
    net: number
    velocityTrend: number | null
    avgFinishedPerWeek: number
  }
}

/**
 * 固定分析：全部由脚本计算，**不需要 AI 参与**。
 * 同一输入永远得到同一输出（可在冒烟里断言）。
 */
export interface BoardAnalysis {
  thresholds: {
    stallDays: number
    overloadOpen: number
    overloadOverdue: number
    requiredLabels: number
    weeklyCapacity: number
    trendWeeks: number
    milestoneRiskDays: number
  }
  health: ProgramHealth[]
  workload: OwnerLoad[]
  slips: SlipRow[]
  stalled: StalledRow[]
  compliance: ComplianceRow[]
  totals: {
    open: number
    overdue: number
    unassigned: number
    stalled: number
    nonCompliant: number
    overloadedOwners: number
  }
  /** 第二批（E-07 ~ E-10）：同样零额外调用。 */
  progress?: ProgressAnalysis
  capacity?: CapacityAnalysis
  milestones?: MilestoneAnalysis
  delivery?: DeliveryAnalysis
}

// ── 工作项详情（F-09）───────────────────────────────────────────────────────

/** 描述模板里的一段（## 标题 + 正文）。 */
export interface TemplateSection {
  title: string
  body: string
  items: string[]
}

/** 前置依赖里的一项。 */
export interface DependencyRow {
  /** 描述里写的引用原文（Gitee 编号 `IK90004`，或 WBS 编码 `ME-02`）。 */
  ref: string
  /** 引用写法：ident=工作项编号；wbs=WBS 编码（靠标题前缀反查）。 */
  kind: 'ident' | 'wbs'
  /** 描述里跟在引用后面的说明文字（反查不到时至少还能显示它）。 */
  label: string
  /** 反查到的 Gitee 工作项编号（没反查到为空串）。 */
  ident: string
  title: string
  state: string
  owner: string
  /** 能否反查到具体工作项。 */
  known: boolean
  /** 该依赖是否已完成。 */
  done: boolean
  /** 是否指向它自己（描述里的引用写错了）。 */
  self: boolean
}

/** 一条评论。 */
export interface IssueCommentRow {
  id: number
  type: string
  author: string
  authorId: number
  createdAt: string
  updatedAt: string
  content: string
  truncated: boolean
}

/** 工作项详情（`gq issue` 的产出）。 */
export interface IssueDetailPayload {
  ok: true
  generatedAt: string
  enterpriseId: number
  detail: {
    ident: string
    id: number
    title: string
    state: string
    stateId: number
    stateTitle: string
    stateColor: string
    priority: number
    priorityHuman: string
    typeId: number
    typeTitle: string
    programId: number
    programName: string
    owner: string
    ownerId: number
    author: string
    collaborators: string[]
    parentIdent: string
    parentTitle: string
    rootId: number
    createdAt: string
    updatedAt: string
    planStartedAt: string
    startedAt: string
    deadline: string
    finishedAt: string
    estimatedMinutes: number
    registeredMinutes: number
    labels: { name: string; color: string }[]
    milestone: { id: number; title: string; state: string; startDate: string; dueDate: string } | null
    url: string
    description: string
    descriptionType: string
  }
  template: { sections: TemplateSection[]; hasTemplate: boolean }
  dependencies: DependencyRow[]
  /** 依赖里尚未完成的那些 —— 真正卡住本项的东西。 */
  blockers: DependencyRow[]
  comments: IssueCommentRow[]
  commentsTotal: number
}

/** 某个工作项类型下的一个状态（改状态的选项）。 */
export interface IssueStateRow {
  id: number
  title: string
  color: string
  serial: number
}

/** 项目成员（改派候选人）。 */
export interface ProgramMemberRow {
  id: number
  name: string
  username: string
}

// ── 知识库文档（I 层；见 DOCS.md）──────────────────────────────────────────

/**
 * 附件在本地缓存里的状态。
 *
 * 比文档少两态（`local-dirty` / `conflict`）：**附件不可变**，我们从不改本地附件，
 * 所以不存在"两边都改"。剩下要回答的只有一个问题 —— 远端那份还是不是我下的那份。
 */
export type AttachStateView = 'not-cached' | 'missing' | 'synced' | 'remote-ahead'

/** 文档页在本地缓存里的状态（四态 + 未缓存/缺失）。 */
export type DocPageStateView = 'not-cached' | 'missing' | 'synced' | 'remote-ahead' | 'local-dirty' | 'conflict'

/** 一个文档（列表用）。 */
export interface DocRow {
  documentId: number
  documentNodeId: number
  name: string
  filePath: string
  programId: number | null
  programName: string
  updatedAt: string
  /** 本地的整体状态（页状态取最严重者；没缓存过为 not-cached）。 */
  state: DocPageStateView
  /** 本地是否已有这篇的缓存目录。 */
  cached: boolean
}

// ── 知识库节点树（本企业知识库的真实形态；见 DOCS.md）──────────────────────

/**
 * 知识库树里的一个节点。
 *
 * 实测（2026-09-15）：企业/项目知识库 = `DocDirectory`（文件夹）+
 * `AttachFile`（上传的 .md/.docx/.pdf/.png…）组成的树。
 * **不是** `WikiInfo` 文档 —— 所以列表源必须是 `list_doc_nodes`，
 * 而不是 `list_enterprise_documents`（后者在本企业恒为 0）。
 */
export interface DocNodeRow {
  nodeId: number
  parentId: number
  name: string
  /** `DocDirectory` | `AttachFile` | … */
  fileType: string
  /**
   * 附件/文档内容 id —— 读内容用它（`download_attach_file`）。
   * 目录节点为 0；**不是**节点 id。
   */
  fileId: number
  filePath: string
  /**
   * 附件字节数（`attach_file.size`）。**0 = 未知**（目录节点，或接口没给）。
   * 与 `updatedAt` 一起构成"缓存有没有过期"的判据。
   */
  size: number
  /** 本地缓存状态（A1）。目录节点恒为 `not-cached`（不参与缓存）。 */
  state: AttachStateView
  programId: number | null
  createdAt: string
  updatedAt: string
  /** 由文件名推出的扩展名（小写；无扩展名为空串）。 */
  ext: string
  /** 是否文件夹（可展开）。 */
  directory: boolean
  /**
   * 内容能不能读。
   *
   * P0′ 阶段恒为 false 并写明原因 —— **诚实标注**比给一个点了没反应的入口好。
   * P1′ 给 fork 加上 `download_attach_file` 之后，附件这里才会变 true。
   */
  readable: boolean
  /** 不可读时的原因（给界面直接显示）。 */
  unreadableReason?: string
}

/** 一个范围（企业级公共 / 某个项目）的知识库根。 */
export interface DocScopeRoot {
  programId: number | null
  programName: string
  /** 该范围的顶层节点。 */
  nodes: DocNodeRow[]
}

/** 知识库节点树响应。 */
export interface DocTreeResponse {
  ok: true
  enterpriseId: number
  /** 本次列了哪些范围（企业级公共 + 各项目）。 */
  roots: DocScopeRoot[]
  /** 节点总数（不含未展开的子层）。 */
  total: number
  cacheRoot: string
  generatedAt: string
  /** 内容读取能力是否已就绪（false = 只能看结构与文件名）。 */
  contentReadable: boolean
  /** 能力未就绪时的一句话说明。 */
  notice?: string
}

/** 读取一个附件节点内容的结果。 */
export interface DocAttachmentResponse {
  ok: true
  nodeId: number
  fileId: number
  name: string
  /** 本地缓存路径（就是"缓存"这件事的产物）。 */
  savedPath: string
  bytes: number
  contentType: string
  ext: string
  /** 文本类（md/txt/json/csv…）才有正文；二进制类为 null。 */
  content: string | null
  /** 正文是否被截断。 */
  truncated: boolean
  /** 是否是可直接预览的文本类型。 */
  previewable: boolean
  /** 缓存目录（给界面显示）。 */
  cacheDir: string
  /** 本次的本地状态（A1）。 */
  state: AttachStateView
  /**
   * 正文是否**直接读的本地缓存**（true = 没有调 MCP 下载）。
   *
   * 这是"按需缓存"真正生效的证据：`synced` 时点开不再重下。
   */
  fromCache: boolean
  /**
   * 工作区软链接下的绝对路径（`<cwd>/.dsh/gitee-docs/…`）。
   *
   * 侧边栏的文件围栏按**会话 cwd** 判定，而缓存根在工作区之外 —— 所以要把
   * 这条路径交给侧边栏（`betterSidebar.openFile`），否则会被围栏拒绝。
   * 拿不到会话 cwd 时为 null（界面回落成只给绝对路径）。
   */
  workspacePath: string | null
  generatedAt: string
}

/** 文档列表响应。 */
export interface DocListResponse {  ok: true
  /** 企业 id（界面提示用）。 */
  enterpriseId: number
  /** portfolio=企业级公共文档；program=某个项目。 */
  scope: 'common' | 'program'
  programId: number | null
  total: number
  documents: DocRow[]
  /** 本地缓存根（展示用）。 */
  cacheRoot: string
  /** 取数时间。 */
  generatedAt: string
}

/** 页树里的一项。 */
export interface DocPageRow {
  pageId: number
  parentPageId: number
  name: string
  type: string
  /** 远程权威版本（界面上显示短码）。 */
  version: string
  lastEditTime: string
  contentType: string
  /** 本地状态。 */
  state: DocPageStateView
  /** 相对文档目录的落盘路径。 */
  path: string
}

/** 文档详情（页树 + 本地状态）。 */
export interface DocDetailResponse {
  ok: true
  documentId: number
  documentNodeId: number
  name: string
  programId: number | null
  /** 本地缓存目录（绝对路径）。 */
  localDir: string
  /** 是否在本地有缓存目录。 */
  cached: boolean
  /** 上次核对时间（未核对为空串）。 */
  checkedAt: string
  /** 文档整体状态。 */
  state: DocPageStateView
  pages: DocPageRow[]
  /** 本次核对里"需要拉取"的页（远程更新或本地缺失）。 */
  pending: number[]
  generatedAt: string
}

/** 一页正文。 */
export interface DocPageResponse {
  ok: true
  documentId: number
  pageId: number
  name: string
  version: string
  lastEditTime: string
  contentType: string
  content: string
  /** 正文被截断（必须显式告知，见 F-19）。 */
  truncated: boolean
  /** 本次正文来自 local 缓存还是 remote（MCP）。 */
  source: 'local' | 'remote'
  state: DocPageStateView
}

/** 核对/拉取结果。 */
export interface DocSyncResponse {
  ok: true
  documentId: number
  /** check=只核对；pull=核对并拉取变化的页。 */
  mode: 'check' | 'pull'
  state: DocPageStateView
  /** 拉取前判定的待拉页。 */
  pending: number[]
  /** 本次真正拉下来的页。 */
  pulled: number[]
  /** 因本地有未推送改动而跳过的页（绝不覆盖）。 */
  skippedDirty: number[]
  checkedAt: string
  generatedAt: string
}

/** 搜索命中（企业级；**不能按项目过滤**，见 DOCS.md §1.2）。 */
export interface DocSearchRow {
  documentId: number
  documentNodeId: number
  documentName: string
  documentPath: string
  pageId: number
  pageName: string
  contentPreview: string
  updatedAt: string
}

/** 搜索响应。 */
export interface DocSearchResponse {
  ok: true
  query: string
  /** 恒为 true —— 让界面能明确提示"搜索是企业级的"。 */
  enterpriseWide: true
  hits: DocSearchRow[]
  generatedAt: string
}

// ── 仓库与其 WIKI（J 层；见 DOCS.md §14）────────────────────────────────────

/**
 * 仓库在界面上的形状（由 MCP `list_enterprise_repositories` 裁剪而来）。
 *
 * ⚠️ `name` 与 `path` **经常不一样**，拼 WIKI 地址必须用 `path`：
 * 实测 `name=demo-docs` 而 `path=docs`、`name=demo-server` 而 `path=demoserver`。
 * 用 name 拼会 404。
 */
export interface RepoRow {
  repoId: number
  name: string
  /** URL 路径段 —— 拼 `{path_with_namespace}.wiki.git` 必须用它。 */
  path: string
  pathWithNamespace: string
  description: string
  /** `public` 原始值：0=私有，2=企业内部开源。 */
  public: number
  /** 由 public 推出的中文可见性。 */
  visibility: string
  defaultBranch: string
  membersCount: number
  lastPushAt: string
  repoSize: number
  outsourced: boolean
  statusName: string
  /**
   * 该仓库的 WIKI **有内容**（Gitee 的 `wiki_enabled_with_content`）。
   *
   * 这是"要不要去克隆 WIKI"的唯一判据：仓库 WIKI 没有 HTTP 列表接口，
   * 只有 `{path_with_namespace}.wiki.git` 这个 git 仓库（DOCS.md §14.1）。
   */
  wiki: boolean
}

/** 仓库列表响应。 */
/** 仓库的一条分支（`GET /repo/branches` 的 `items[]`）。 */
export interface RepoBranch {
  name: string
  /** 仓库默认分支（建 PR 时目标分支的默认值）。 */
  isDefault: boolean
  protected: boolean
  commit: { id: string; shortId: string; title: string }
}

/** `GET /repo/branches` 的响应（新建 PR 的源/目标分支下拉靠它）。 */
export interface RepoBranchesResponse {
  ok: true
  generatedAt: string
  repoId: number
  total: number
  /** 没有分支时为空串。 */
  defaultBranch: string
  items: RepoBranch[]
}

export interface RepoListResponse {
  ok: true
  enterpriseId: number
  /**
   * 取数口径。
   *   - `project` —— 选中了项目，列**该项目下的**仓库（`program_id` 过滤）
   *   - `internal-open` —— 没选项目，只列**企业内部开源**的仓库（`scope=internal-open`）
   */
  mode: 'project' | 'internal-open'
  programId: number | null
  programName: string
  total: number
  repos: RepoRow[]
  generatedAt: string
  /** 口径说明（界面直接显示，避免"为什么只有这几个仓库"的疑问）。 */
  notice: string
}

/** WIKI 里的一页（就是一个 .md 文件）。 */
export interface WikiPageRow {
  /** 相对 WIKI 根目录的路径（含子目录）。 */
  path: string
  name: string
  /** 去掉扩展名的标题。 */
  title: string
  bytes: number
  updatedAt: string
}

/** 一个仓库的 WIKI 树。 */
export interface WikiTreeResponse {
  ok: true
  repoId: number
  repoName: string
  /** URL 路径段（展示与诊断用）。 */
  repoPath: string
  /** git HEAD（WIKI 仓库的 commit id）—— 刷新后对比它就知道有没有变。 */
  head: string
  /** 本地 WIKI 缓存目录（绝对路径）。 */
  localDir: string
  /**
   * 会话工作区里**可见**的软链接路径（`<cwd>/.dsh/gitee-docs/wiki/<repo>`）。
   *
   * 侧边栏的文件围栏按**会话 cwd**判定，缓存根在工作区之外 —— 所以要用这条
   * 软链接路径去调 `openFile`。取不到会话 cwd 时为 null（界面回落成只给绝对路径）。
   */
  workspaceDir: string | null
  pages: WikiPageRow[]
  /** 本次是否真的 fetch 了（false = 命中本地缓存且未过期）。 */
  fetched: boolean
  fetchedAt: string
  /** WIKI 取不回来时的一句话说明（此时 pages 为空，但 ok 仍为 true）。 */
  notice?: string
}

/** WIKI 一页的正文。 */
export interface WikiPageResponse {
  ok: true
  repoId: number
  repoName: string
  path: string
  name: string
  title: string
  content: string
  /** 正文超长被截断（必须显式告知）。 */
  truncated: boolean
  bytes: number
  /** 本地绝对路径。 */
  localPath: string
  /** 工作区软链接下的绝对路径（交给侧边栏 / 编辑器打开）。找不到会话 cwd 时为 null。 */
  workspacePath: string | null
}

// ── 写通道（G-05 / F-10）────────────────────────────────────────────────────

/**
 * 写操作请求。
 *
 * UI 只允许这四种；`doc-page-update` 同样走这一条路（**唯一写入口**），
 * 由 host 委派 MCP 的 `update_enterprise_document_page`，
 * 而不是让插件自己去拼文档端点（见 DOCS.md §7）。
 */
export interface IssueWriteRequest {
  op: 'set-state' | 'comment' | 'assign' | 'doc-page-update'
  /** 工作项编号（前三种 op 必填）。 */
  ident: string
  stateId?: number
  body?: string
  assigneeId?: number
  /**
   * 发起写的会话。
   *
   * 0.5.4 起**不再用它做模式判定**（曾经要求「必须是 Gitee 会话」才放行，
   * 让「任何模式都能用」卡死过）；现在只留作审计与文档写的作用域。
   */
  sessionId?: string
  /** doc-page-update：文档 id。 */
  documentId?: number
  /** doc-page-update：页 id。 */
  pageId?: number
  /** doc-page-update：**整页替换**的内容。 */
  content?: string
  /** doc-page-update：期望版本（清单里的值）—— 乐观锁靠它。 */
  expectedVersion?: string
  /** doc-page-update：提交说明（必填，Gitee 历史里留痕）。 */
  commitMessage?: string
  /** doc-page-update：可选改名。 */
  pageName?: string
}

/**
 * 新建工作项。
 *
 * 归属：`programId`（项目）与 `repoId`（仓库）至少给一个 —— 仓库详情页的
 * 「新建工作项」会带上 repoId，这样工作项就挂在仓库下面。
 * `typeId` 选任务/需求/缺陷（来自 `/issue-types`），不传由服务端给默认类型。
 */
export interface IssueCreateRequest {
  title: string
  programId?: number
  repoId?: number
  typeId?: number
  description?: string
  assigneeId?: number
  priority?: number
  /**
   * 任务时间（截止日），`YYYY-MM-DD`。
   * 用户口径（2026-10-26）：「关键属性 任务时间、优先级、负责人这三个必须填写」，
   * 面板侧三个都必填，host 只做透传（`gq create-issue --deadline`）。
   */
  /** 计划开始日（YYYY-MM-DD，可选）。 */
  planStartedAt?: string
  /** 计划结束日 / 截止日（YYYY-MM-DD）。 */
  deadline?: string
}

/** `/issue-types` 的一项：任务 / 需求 / 缺陷。 */
export interface IssueTypeRow {
  id: number
  ident: string
  title: string
  category: string
  color: string
  system: boolean
}

/** 仓库维度的一行工作项（与 `/issues` 的行同形，供仓库详情页「工作项」页签用）。 */
export interface RepoIssueRow {
  id: number
  ident: string
  title: string
  state: string
  priority: number
  priorityHuman: string
  programId: number
  assignee: string
  assigneeId: number
  deadline: string
  createdAt: string
  updatedAt: string
  typeTitle: string
  typeId: number
  commentsCount: number
  overdue: boolean
  overdueDays: number
}

/** `/repo/issues` 的返回：仓库维度工作项清单。 */
export interface RepoIssueResponse {
  repoId: number
  total: number
  truncated: boolean
  issues: RepoIssueRow[]
  distribution: Array<{ state: string; count: number }>
}

/** 写操作结果。 */
export interface IssueWriteResult {
  ok: true
  op: 'set-state' | 'comment' | 'assign' | 'doc-page-update'
  ident: string
  stateId?: number
  state?: string
  stateTitle?: string
  noteId?: number
  assigneeId?: number
  owner?: string
  /** doc-page-update：写入后的新版本与时间。 */
  documentId?: number
  pageId?: number
  version?: string
  lastEditTime?: string
}

/** 「我的工作项」一行：负责人或协作者是我。 */
export interface MyIssueRow {
  id: number
  ident: string
  title: string
  programId: number
  programName: string
  state: string
  priorityHuman: string
  deadline: string
  overdue: boolean
  /** owner=我是负责人；collaborator=我是协作者。 */
  role: 'owner' | 'collaborator'
}

/** 一次取数的完整结果（卡片渲染用；**不进入模型上下文**）。 */
export interface BoardPayload {
  ok: true
  scope: BoardScope | string
  /** live=实时拉取；fixture=样例数据（无 token 时的渲染自检）。 */
  source: 'live' | 'fixture'
  /** 生成时间（人类可读）。 */
  generatedAt: string
  enterprise: { id: number; name: string }
  me: { id: number; name: string } | null
  /** true = 工作项超过翻页上限被截断（所有统计只覆盖已取到的部分）。 */
  truncated?: boolean
  kpi: BoardKpi
  distribution: DistributionRow[]
  programs: ProgramRow[]
  risks: RiskRow[]
  /** 固定分析（脚本计算，无需 AI）。 */
  analysis?: BoardAnalysis
  /**
   * 「我的工作项」页签：负责人或协作者是我的工作项。
   *
   * 由脚本在**已经取到的那批工作项**上过滤得出，不打额外接口（见
   * `scripts/gitee/gq.mjs` 的 `finalize`）。老版本脚本没有这个字段 → 客户端要判空。
   */
  myIssues?: MyIssueRow[]
  /** 给模型看的紧凑摘要——唯一进入上下文的部分。 */
  summary: string
}

/** 路由成功响应。 */
export interface PayloadResponse {
  ok: true
  payload: BoardPayload
  /** 命中宿主缓存（未重新执行脚本）。 */
  cached: boolean
  /** 降级为样例数据（未配置 token 且允许降级）。 */
  degraded: boolean
  /**
   * 数据时效（提醒义务，用户口径 m02223）。
   *
   * 界面据此显示「数据 N 秒前」并在超过 `ttlSeconds` 时标黄；
   * AI 侧由 `gitee_board` / `gitee_board_snapshot` 输出同一组数字。
   */
  freshness?: Freshness
}

/** 一份数据的时效元信息（界面与 AI 共用同一组数字）。 */
export interface Freshness {
  /** 抓取时刻（epoch ms）。 */
  fetchedAt: number
  /** 距今多少秒。 */
  ageSeconds: number
  /** 是否已超过新鲜期（`true` = 可能不是最新，需要刷新）。 */
  stale: boolean
  /** 当前生效的新鲜期（秒；0 = 不做缓存）。 */
  ttlSeconds: number
  /** 数据来自哪一层。 */
  source: 'remote' | 'memory' | 'disk'
}

/** 路由失败响应。 */
export interface ErrorResponse {
  ok: false
  code: 'no-token' | 'script-failed' | 'timeout' | 'bad-request' | 'forbidden'
  message: string
}

/** 环境自检结果（gq health 的透传）。 */
export interface HealthResponse {
  ok: boolean
  stage: string
  tokenSource?: string
  enterprise?: { id: number; name: string }
  programsSeen?: number
  apiBase?: string
  message?: string
  candidates?: string[]
}

/** 人格：只有两种——管理者 / 项目执行。 */
export type PersonaKey = 'manager' | 'executor'

/** 能力档（「项目执行」内部按是否项目负责人再分两档）。 */
export type PersonaTier = 'manager' | 'project' | 'exec'

/** 那一个开关的取值：auto=由身份推导，其余为人工强制。 */
export type PersonaMode = 'auto' | PersonaTier

/** 身份与人格解析结果（gq role 的产出）。 */
export interface RolePayload {
  ok: true
  generatedAt: string
  /** 本次解析使用的模式（auto/manager/project/exec）。 */
  mode: PersonaMode
  /** 能力档：manager / project（负责人档）/ exec（执行档）。 */
  tier: PersonaTier
  enterprise: { id: number }
  me: { id: number; name: string; login: string } | null
  /** 企业角色 ident，如 member / admin / enterprise_owner；未知时为空串。 */
  enterpriseRole: string
  /** 我以负责人身份管理的项目（这个列表就是「开关」的适用范围）。 */
  managedPrograms: { id: number; name: string; why: string }[]
  /** 同上，保留旧名以便兼容。 */
  ownedPrograms: { id: number; name: string }[]
  /** 当前 token 用户名下的工作项数。 */
  ownedIssueCount: number
  /** **那个开关**：true=开启项目管理与分析功能。 */
  canManageProject: boolean
  /** 本档可用的 MCP 原始工具名（门禁与 --enabled-toolsets 共用这一份）。 */
  tools: string[]
  /**
   * 本档里**会改 Gitee 上东西**的那些工具（`tools` 的子集）。
   *
   * 只读部署（`allowWrites=false`）时门禁按它硬拦。之所以要单独一份：`allowWrites`
   * 原本只管界面写按钮与 `/write` 路由，管不到 MCP 通道 —— 而 preset 的
   * `--enabled-toolsets` 是静态的、不随部署变，于是"只读"这个承诺在 MCP 那侧是空的。
   * 导出类工具（`download_enterprise_document`）不在此列：它只写本地磁盘。
   */
  writes: string[]
  persona: PersonaKey
  /** 判定依据（中文，用于向用户解释「为什么是这个人格」）。 */
  reason: string
  /** 注入 `systemPrompt.context` 的紧凑上下文块。 */
  contextText: string
  /** 给人看的 Markdown 摘要。 */
  summary: string
}

/* ───────────────────────────── 0.5.4 · 合并请求（PR） ───────────────────────────── */

/** PR 生命周期状态（Gitee v8 `state`）。 */
export type PrState = 'opened' | 'merged' | 'closed'

/** 审查状态：0 无需审查 · 1 待审查 · 2 审查已通过。 */
export type PrCheckState = 0 | 1 | 2
/** 测试状态：0 无需测试 · 1 待测试 · 2 测试已通过。 */
export type PrTestState = 0 | 1 | 2

/** 列表里的一个人（审查人 / 测试人）：0 待处理 · 1 已通过 · 2 已驳回。 */
export interface PrPerson {
  id: number
  name: string
  username: string
  state: 0 | 1 | 2
}

/** 当前 token 对某个 PR 的真实权限（来自 `get_enterprise_pull_auth`，**不猜**）。 */
export interface PrAuth {
  read: boolean
  createNote: boolean
  update: boolean
  canCheck: boolean
  canTest: boolean
  canMerge: boolean
  forceChecked: boolean
  forceTested: boolean
  canClose: boolean
  canReopen: boolean
  canDeleteSource: boolean
}

/** 变更文件（`list_enterprise_pull_files` 的形状，已把 `patch.diff` 摊平）。 */
export interface PrFile {
  filename: string
  oldPath: string
  newPath: string
  status: 'added' | 'renamed' | 'deleted' | 'modified'
  additions: number
  deletions: number
  diff: string
}

/** PR 评论。 */
export interface PrComment {
  id: number
  body: string
  author: PrPerson
  createdAt: string
}

/** 列表行。 */
export interface PrSummary {
  /** 全局 id（`18905991`）。 */
  id: number
  /** 仓库内序号（`!12` 的那个 12）。 */
  iid: number
  title: string
  state: PrState
  draft: boolean
  repoId: number
  repoPath: string
  sourceBranch: string
  targetBranch: string
  author: PrPerson
  checkState: PrCheckState
  testState: PrTestState
  prAssignNum: number
  prTestNum: number
  /** 已通过审查人数（前端画「待审查 1/2」用）。 */
  checkPassed: number
  /** 已通过测试人数。 */
  testPassed: number
  /** `canMerge && checkState===2 && testState===2` —— 界面上「可合并」的唯一口径。 */
  mergeable: boolean
  updatedAt: string
  url: string
}

/** 详情：列表行 + 正文 + 人 + 权限 + 文件 + 评论。 */
export interface PrDetail extends PrSummary {
  body: string
  bodyHtml: string
  assignees: PrPerson[]
  testers: PrPerson[]
  /** 取不到（403 / 非审查人）时为 null —— 界面显示「权限未知」，**不许**用角色推断。 */
  auth: PrAuth | null
  /** 权限取失败时的白话原因。 */
  authHint: string
  files: PrFile[]
  comments: PrComment[]
  commitsCount: number
  canChangeAssigner: boolean
  canChangeTester: boolean
}

/** 列表响应的分类计数（4 张卡的数字，全局口径）。 */
export interface PrCounts {
  review: number
  test: number
  mine: number
  mergeable: number
}

/** `GET /pr/list` 响应。 */
export interface PrListResponse {
  items: PrSummary[]
  total: number
  page: number
  counts: PrCounts
  /** 本次实际用的视角（回显筛选条）。 */
  scope: 'assign' | 'test' | 'create' | 'all'
  state: 'opened' | 'merged' | 'closed' | 'all'
}

/** 模板元信息。 */
export interface PrTemplateMeta {
  name: string
  path: string
  source: 'builtin' | 'user'
  repoPath?: string | null
  /** 保存/绑定时只作用于哪一种模板（不是「两个都管」）。 */
  kind?: 'review' | 'test' | 'pr' | 'prGuide'
  updatedAt?: string
}

/** `GET /pr/templates` 响应。 */
export interface PrTemplatesResponse {
  items: PrTemplateMeta[]
  /**
   * 当前生效的模板正文。
   * `pr` = 干净骨架（套用模板用）；`prGuide` = 带每节说明的版本（「写什么？」与 AI 起草用）。
   */
  active: { review: string; test: string; pr?: string; prGuide?: string }
  /** 当前生效模板的名字（仓库级覆盖时不是内置名）。 */
  activeName: { review: string; test: string; pr?: string; prGuide?: string }
}

/**
 * 新建 PR 的请求体（`POST /pr/create`）。
 *
 * 两条建 PR 路径共用宿主这层：UI 对话框填这个，agent 也可以直接调
 * `create_enterprise_repo_pull`（等价）。**分支名只能手输** —— MCP 没有
 * 列分支的工具，`targetBranch` 默认值取仓库当前默认分支。
 */
export interface PrCreateRequest {
  repoId: number
  /** 仓库 path_with_namespace，仅用于拼 PR 链接与回显。 */
  repoPath?: string
  sourceBranch: string
  targetBranch: string
  title: string
  body?: string
  /** 最小审查人数（Gitee 侧 `pr_assign_num`）。 */
  prAssignNum?: number
  /** 最小测试人数（Gitee 侧 `pr_test_num`）。 */
  prTestNum?: number
  draft?: boolean
}

/** `POST /pr/create` 的结果。 */
export interface PrCreateResult {
  iid: number
  url: string
  title: string
}

/** 写动作的请求体（`POST /pr/action`）。 */
export type PrActionRequest =
  | { action: 'check'; repoId: number; iid: number; mode: 'accept' | 'reject' | 'reset'; comment?: string }
  | { action: 'test'; repoId: number; iid: number; comment?: string }
  | { action: 'merge'; repoId: number; iid: number; method: 'merge' | 'squash' | 'rebase' }
  | { action: 'comment'; repoId: number; iid: number; body: string }
  | { action: 'state'; repoId: number; iid: number; event: 'close' | 'reopen' }
  | { action: 'openCheck'; repoId: number; iid: number }
  | { action: 'openTest'; repoId: number; iid: number }

/** `POST /pr/action` 响应。 */
export interface PrActionResponse {
  detail: PrDetail
}

/** `POST /pr/ai-review` 请求体。 */
export interface PrAiReviewRequest {
  repoId: number
  iid: number
  template: 'review' | 'test'
  scope: 'full' | 'code-only' | 'files'
  files?: string[]
  autoApprove: boolean
}

/** `POST /pr/ai-review` 响应：只表示「已投递给会话」，结论由子智能体自己写回 PR。 */
export interface PrAiReviewResponse {
  dispatched: boolean
  promptPreview: string
  autoApprove: boolean
}
