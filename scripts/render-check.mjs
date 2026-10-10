/**
 * 渲染确定性检查（零浏览器）。
 *
 * 为什么需要它：项目的主题是「图表由插件在会话里画」，而这件事以前只能靠
 * 肉眼看浏览器。这里把**纯展示层**（`BoardView` 卡片 / `AnalysisCards` 固定分析
 * / `IssueDetail` 详情面板 / `GiteeProjectView` 整屏视图）用 react-dom/server
 * 渲染成 HTML，再用真实 gq 脚本产出的 payload 断言内容——于是「界面长什么样」
 * 变成可回归的检查，而不是一次性的人工确认。
 *
 * 用法：
 *   node scripts/render-check.mjs          # 断言 + 打印文本预览
 *   node scripts/render-check.mjs --html   # 同时打印原始 HTML
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const showHtml = process.argv.includes('--html')

/** 与 build.mjs 一致的 CSS Modules 内联插件（否则组件里的 css 映射是空的）。 */
const cssInlinePlugin = {
  name: 'css-inline',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8')
      const keys = [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))]
      const map = Object.fromEntries(keys.map((k) => [k, `GiteeChat_${k}`]))
      return {
        contents: `export default ${JSON.stringify(map)}\nexport const CSS_TEXT = ""\n`,
        loader: 'js',
      }
    })
  },
}

/** 把展示层打成可在 node 里 import 的临时模块。
 *  产物必须落在**包内**（不能放 /tmp）：否则 `react` 这个 external 无法解析。 */
async function buildView() {
  const dir = await mkdtemp(join(root, 'node_modules/.gq-render-'))
  const outfile = join(dir, 'view.mjs')
  const entry = join(dir, 'entry.tsx')
  await writeFile(entry, [
    "export { BoardView } from '" + join(root, 'src/client/BoardView.tsx').replace(/\\/g, '/') + "'",
    "export { AnalysisCards } from '" + join(root, 'src/client/AnalysisCards.tsx').replace(/\\/g, '/') + "'",
    "export { IssueDetail } from '" + join(root, 'src/client/IssueDetail.tsx').replace(/\\/g, '/') + "'",
    "export { GiteeProjectView, GiteeModeNotice } from '" + join(root, 'src/client/GiteeProjectView.tsx').replace(/\\/g, '/') + "'",
    "export { GiteeSettingsSection, TokenForm } from '" + join(root, 'src/client/TokenSettings.tsx').replace(/\\/g, '/') + "'",
    "export { RepoPanel } from '" + join(root, 'src/client/RepoPanel.tsx').replace(/\\/g, '/') + "'",
    "export { DocPanel } from '" + join(root, 'src/client/DocPanel.tsx').replace(/\\/g, '/') + "'",
  ].join('\n') + '\n')
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    outfile,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [cssInlinePlugin],
    logLevel: 'silent',
  })
  return outfile
}

/** 用真实脚本产出 payload（--fixture：无 token 也能跑通同一条数据路径）。 */
async function realPayload() {
  const { stdout } = await run(process.execPath, [join(root, 'scripts/gitee/gq.mjs'), 'portfolio', '--fixture', '--json'], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** 调一次 gq 子命令（fixture 模式）并解析 JSON。 */
async function gqJson(args) {
  const { stdout } = await run(process.execPath, [join(root, 'scripts/gitee/gq.mjs'), ...args, '--fixture', '--json'], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** 把 HTML 变成便于肉眼审阅的纯文本预览。 */
function toText(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, ' [SVG 柱状图] ')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(div|span|button|svg)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

async function main() {
  console.log('▶ 看板渲染检查')

  const viewModule = await import(pathToFileURL(await buildView()).href)
  const { BoardView } = viewModule
  assert.equal(typeof BoardView, 'function', 'BoardView 必须是组件函数')
  console.log('  ✓ 展示层打包成功（CSS Modules 映射已注入）')

  const payload = await realPayload()
  assert.equal(payload.ok, true)
  console.log(`  ✓ payload：${payload.kpi.programs} 项目 / ${payload.kpi.issues} 工作项 / ${payload.risks.length} 风险`)

  // 用 createElement 而不是直接调用函数：整屏视图/详情面板里有 hooks，
  // 直接调用会绕开 React 的调和器并抛 "Invalid hook call"。
  const html = renderToStaticMarkup(h(BoardView, { payload, cached: false, degraded: true }))

  // ── 内容断言：卡片必须真的把关键信息画出来 ──────────────────────────────
  assert.ok(html.includes('Gitee 项目看板'), '缺少卡片标题')
  assert.ok(html.includes('样例数据'), 'fixture 来源应显示样例标记')
  assert.ok(html.includes('企业全景'), '缺少范围标记')
  assert.ok(html.includes('工作项状态分布'), '缺少状态分布区块')
  assert.ok(html.includes('项目健康度'), '缺少项目健康度区块')
  assert.ok(html.includes('风险清单'), '缺少风险清单区块')
  assert.ok(html.includes('<svg'), '缺少 SVG 图表——这正是「插件画图」的产物')

  // KPI 数字必须出现
  for (const value of [String(payload.kpi.programs), String(payload.kpi.issues), String(payload.kpi.overdue)]) {
    assert.ok(html.includes(`>${value}<`), `KPI 值 ${value} 未渲染`)
  }
  // 项目名与风险 ident 必须出现
  assert.ok(html.includes(payload.programs[0].name), '缺少项目名')
  assert.ok(html.includes(payload.risks[0].ident), '缺少风险编号')
  // 进度条宽度应反映真实完成率
  assert.ok(html.includes(`width:${payload.programs[0].progress}%`), '进度条宽度与完成率不一致')

  console.log('  ✓ 内容断言全部通过（标题/KPI/分布/柱状图/项目行/风险）')

  // ── 边界：全空数据不得崩，且要给出可读空态 ──────────────────────────────
  const empty = renderToStaticMarkup(h(BoardView, {
    payload: {
      ...payload,
      kpi: { programs: 0, issues: 0, progressing: 0, done: 0, overdue: 0, unassigned: 0 },
      programs: [],
      risks: [],
      distribution: [],
    },
    degraded: false,
  }))
  assert.ok(empty.includes('暂无工作项数据'), '空数据应显示空态文案')
  console.log('  ✓ 空数据空态正常（不崩、有文案）')

  // ── 固定分析卡片（E-01 ~ E-10）────────────────────────────────────────────
  const analysis = payload.analysis
  assert.ok(analysis !== undefined, 'payload 必须带固定分析（analysis）')
  const { AnalysisCards, IssueDetail, GiteeProjectView, GiteeModeNotice, RepoPanel, DocPanel,
    GiteeSettingsSection, TokenForm } = viewModule
  assert.equal(typeof AnalysisCards, 'function', 'AnalysisCards 必须是组件函数')
  assert.equal(typeof IssueDetail, 'function', 'IssueDetail 必须是组件函数')
  assert.equal(typeof GiteeProjectView, 'function', 'GiteeProjectView 必须是组件函数')
  assert.equal(typeof GiteeModeNotice, 'function', 'GiteeModeNotice 必须是组件函数')
  assert.equal(typeof RepoPanel, 'function', 'RepoPanel 必须是组件函数')
  assert.equal(typeof DocPanel, 'function', 'DocPanel 必须是组件函数')
  assert.equal(typeof GiteeSettingsSection, 'function', 'GiteeSettingsSection（设置分节）必须是组件函数')
  assert.equal(typeof TokenForm, 'function', 'TokenForm 必须是组件函数')

  const analysisHtml = renderToStaticMarkup(h(AnalysisCards, { analysis, managementEnabled: true }))
  for (const label of ['① 项目健康度', '② 成员负载', '③ 延期清单', '④ 停滞', '⑤ 规范体检', '⑥ 进度偏差', '⑦ 交付容量', '⑧ 里程碑达成', '⑨ 交付趋势']) {
    assert.ok(analysisHtml.includes(label), `固定分析缺少「${label}」卡片`)
  }
  // 脚本结论必须原样落到界面（不许界面自己再算一遍）
  assert.ok(analysisHtml.includes(String(analysis.thresholds.weeklyCapacity)), '容量阈值未随数据下发到界面')
  assert.ok(analysisHtml.includes(String(analysis.progress.totals.measured)), '进度偏差样本数未渲染')
  assert.ok(analysisHtml.includes(analysis.milestones.rows[0].title), '里程碑标题未渲染')
  assert.ok(analysisHtml.includes(String(analysis.capacity.noDeadline)), '容量「无截止」计数未渲染')
  assert.ok(analysisHtml.includes('未经模型推断'), '缺少「脚本计算」的口径声明')
  console.log('  ✓ 固定分析 9 张卡片全部渲染，且数字来自脚本')

  // ── 工作项详情（F-09：描述 / 前置依赖 / 评论讨论）──────────────────────
  const detailPayload = await gqJson(['issue', '--ident', 'DM0001'])
  const states = (await gqJson(['states', '--type', '100'])).states
  const members = (await gqJson(['members', '--program', '1001'])).members
  assert.ok(detailPayload.detail.description.includes('## 前置依赖'), '详情必须带描述原文')
  assert.ok(detailPayload.comments.length > 0, '详情必须带评论')

  const detailHtml = renderToStaticMarkup(h(IssueDetail, {
    sessionId: 'render-check',
    ident: detailPayload.detail.ident,
    writesEnabled: true,
    preload: { detail: detailPayload, states, members },
  }))
  for (const label of ['描述', '前置依赖', '评论中的讨论', '操作', '发布评论', '改派', '里程碑']) {
    assert.ok(detailHtml.includes(label), `详情面板缺少「${label}」区块`)
  }
  assert.ok(detailHtml.includes(detailPayload.dependencies[0].ref), '前置依赖引用未渲染')
  assert.ok(detailHtml.includes('WBS'), '界面上必须说明引用有两种写法（编号 / WBS 编码）')
  assert.ok(detailHtml.includes(detailPayload.comments[0].author), '评论作者未渲染')
  assert.ok(detailHtml.includes(detailPayload.comments[0].content.slice(0, 12)), '评论正文未渲染')
  assert.ok(detailHtml.includes('阻塞'), '存在未完成前置项时必须给出阻塞提示')
  // 描述里的「## 前置依赖」段必须被抽走（它在上面的依赖区单独展示，不重复占版面）
  assert.ok(!detailHtml.includes('>前置依赖</h2>'), '描述里的前置依赖段应被抽到依赖区，不应重复渲染')
  for (const section of ['目标', '交付物', '验收标准']) {
    assert.ok(detailHtml.includes(`>${section}</h2>`), `描述里的「${section}」分段应原样渲染`)
  }
  // 状态选项来自脚本，不是内置的兜底表
  assert.ok(detailHtml.includes(states[0].title), '状态选项未渲染')
  console.log('  ✓ 详情面板：描述 / 前置依赖 / 评论讨论 / 写回入口全部渲染')

  // 只读部署：写通道关闭时必须明确说明，而不是给一堆点了会失败的按钮
  const roHtml = renderToStaticMarkup(h(IssueDetail, {
    sessionId: 'render-check', ident: detailPayload.detail.ident, writesEnabled: false,
    preload: { detail: detailPayload, states, members },
  }))
  assert.ok(roHtml.includes('关闭了写通道'), '只读部署必须说明写通道关闭')
  assert.ok(!roHtml.includes('发布评论'), '只读部署不应出现发布评论按钮')
  console.log('  ✓ 只读部署（allowWrites=false）正确降级')

  // ── 整屏视图（conversation.view）───────────────────────────────────────
  const issuesPayload = await gqJson(['issues', '--program', '1001'])
  const viewHtml = renderToStaticMarkup(h(GiteeProjectView, {
    sessionId: 'render-check',
    preload: { board: payload, issues: issuesPayload },
  }))
  for (const label of ['Gitee 项目', '项目', '仓库', '固定分析', '知识库', '刷新', '工作项', '未完成', '逾期', '全部']) {
    assert.ok(viewHtml.includes(label), `整屏视图缺少「${label}」`)
  }
  // 页签必须**与标题分行**（需求要求"这一行下面再作一行"）：页签容器在
  // 标题卡片之后、且带 gqVBanner 那行样式，不能再挤在 CardTitle 的 right 里。
  assert.ok(viewHtml.indexOf('项目') > viewHtml.indexOf('Gitee 项目'),
    '页签应排在标题之后（分行）')
  assert.ok(viewHtml.includes('刷新'), '页签行必须带刷新按钮')
  assert.ok(viewHtml.includes(payload.programs[0].name), '整屏视图缺少左侧项目名')
  assert.ok(viewHtml.includes(issuesPayload.issues[0].ident), '整屏视图缺少工作项编号')
  assert.ok(viewHtml.includes('data-gq-root'), '整屏视图根节点必须带 data-gq-root（用于隐藏宽度拖拽把手）')
  // 会话未启用 Gitee 模式时（gitee=null）必须只给提示，不渲染任何数据
  // 非 Gitee 会话的降级界面：唯一会出现在无关会话里的东西，必须能单独审阅
  const noticeHtml = renderToStaticMarkup(h(GiteeModeNotice, { preset: 'ptc' }))
  assert.ok(noticeHtml.includes('本会话未使用 Gitee 模式'), '非 Gitee 会话必须只显示提示')
  assert.ok(noticeHtml.includes('ptc'), '提示里应写明实际 preset')
  assert.ok(!noticeHtml.includes('项目健康度'), '非 Gitee 会话不得渲染任何项目数据')
  const disabledHtml = renderToStaticMarkup(h(GiteeProjectView, { sessionId: '' }))
  assert.ok(disabledHtml.includes('正在拉取'), '未注入种子数据时应显示加载态而不是崩')
  console.log('  ✓ 整屏视图：项目列表 / 工作项表 / 页签 / 刷新全部渲染；非 Gitee 会话正确降级')

  // ── 设置分节：「设置 → Gitee 企业项目」（0.4.1 的 token 配置**唯一**入口）──
  //
  // 它是**机器级**的配置入口，与当前会话无关：使用者不知道 token 写哪儿时，
  // 第一眼就该在应用设置里找到它。SSR 不跑 effect（不拉状态），所以这里断言的是
  // "首屏不崩 + 该说的话都在"。
  const sectionHtml = renderToStaticMarkup(h(GiteeSettingsSection, {}))
  assert.ok(sectionHtml.includes('Gitee 企业版 Token'), '设置分节缺少标题')
  assert.ok(sectionHtml.includes('.gitee-chat/token'), '设置分节必须写明 token 存到哪个文件')
  assert.ok(sectionHtml.includes('Gitee 企业项目管理') && sectionHtml.includes('Gitee 项目执行'),
    '设置分节必须告诉使用者配好之后选哪个预设')
  assert.ok(sectionHtml.includes('保存'), '设置分节里必须有保存按钮')
  assert.ok(sectionHtml.includes('当前企业'), '设置分节必须有企业选择入口（配好 token 之后直接选企业）')
  assert.ok(sectionHtml.includes('读取中'), '企业列表 SSR 首屏应是加载态，不能崩')
  assert.ok(!/position:\s*fixed/.test(sectionHtml), '设置分节是页面内容，不是浮层')
  console.log('  ✓ 设置分节：token 路径 / 企业选择器 / 预设指引 / 保存按钮齐备')

  // 🔴 反向守卫：配置入口**不许**再回到「Gitee 项目」标签页里。
  // 那里不能放 `⚙ 设置` 弹窗：那个标签页只在 Gitee 模式的会话里才有内容，
  // 把配置放进去等于"先有 token 才能找到配 token 的地方"。
  const tabViewSrc = readFileSync(join(root, 'src/client/GiteeProjectView.tsx'), 'utf8')
  assert.ok(!/TokenSettings|TokenForm|粘贴企业版 access token/.test(tabViewSrc),
    '「Gitee 项目」标签页里不得再有 token 配置代码 —— 配置入口只有应用「设置 → Gitee 企业项目」')
  const viewErrHtml = renderToStaticMarkup(h(GiteeProjectView, { sessionId: '' }))
  assert.ok(!viewErrHtml.includes('粘贴企业版 access token'), '标签页首屏不得出现 token 输入框')
  assert.ok(!viewErrHtml.includes('⚙ 设置'), '标签页不该再有「⚙ 设置」按钮')
  console.log('  ✓ 标签页不再自带 token 配置（错误代码已删；入口只有应用设置）')

  // ── J 层：仓库面板与知识库面板（SSR 不跑 effect，断言的是"首屏不崩 + 口径写清楚"）──
  const repoHtml = renderToStaticMarkup(h(RepoPanel, { sessionId: 'render-check', programId: 1001, programName: '示例项目' }))
  assert.ok(repoHtml.includes('仓库'), '仓库面板缺少标题')
  assert.ok(repoHtml.includes('企业内部开源'), '仓库面板必须写明第二种口径（不选项目时只看企业内部开源）')
  assert.ok(repoHtml.includes('WIKI'), '仓库面板必须说明 WIKI 挂在仓库下面')
  assert.ok(repoHtml.includes('正在拉取仓库列表'), '首屏应是加载态')
  const repoNoProject = renderToStaticMarkup(h(RepoPanel, { sessionId: 'render-check', programId: null, programName: '' }))
  assert.ok(repoNoProject.includes('企业内部开源'), '没有选中项目时默认就是企业内部开源口径')
  console.log('  ✓ J 层仓库面板：首屏不崩 · 两种口径写明 · 没有项目时默认内部开源')

  const docHtml = renderToStaticMarkup(h(DocPanel, { sessionId: 'render-check', programId: 1001, programName: '示例项目' }))
  assert.ok(docHtml.includes('知识库'), '知识库面板缺少标题')
  assert.ok(docHtml.includes('正在拉取知识库结构'), '首屏应是加载态')
  // 预览分工必须写在界面上（需求：只内联 .md，其余交给侧边栏）
  assert.ok(/预览分工/.test(docHtml), '必须写明预览分工（本插件只内联 .md）')
  assert.ok(/侧边栏|dsh-better-sidebar/.test(docHtml), '必须说明侧边栏接管其它类型')
  // A2：缓存管理入口必须首屏就在（不然 `forget`/`scopePath` 又变成没有出口的死代码）
  assert.ok(docHtml.includes('清本范围缓存'), '知识库面板必须有"清本范围缓存"入口')
  // A3：查找入口，且必须**如实说明只过滤已展开的层**（子层是按需拉的）
  assert.ok(docHtml.includes('按文件名过滤'), '知识库面板必须有过滤入口')
  assert.ok(docHtml.includes('只过滤已展开的层'), '必须写明过滤范围，否则使用者会以为搜的是整棵树')
  // 仓库面板的 WIKI 过滤只有在**选中一个仓库之后**才出现（首屏没有选中项），
  // 所以这条只能查源码，不能查 SSR 的 DOM —— 写成 DOM 断言就是在断言一个
  // 本来就不该存在的元素。
  assert.match(await readFile(join(root, 'src/client/RepoPanel.tsx'), 'utf8'), /按路径\/文件名过滤/,
    '仓库面板的 WIKI 必须有过滤入口')
  console.log('  ✓ 知识库面板：首屏不崩 · 预览分工写明 · 缓存管理入口在 · 过滤如实写明范围')

  // 主题令牌自检：不得出现硬编码颜色
  const hardcoded = /(?:color|background|border-color)\s*:\s*(?:#[0-9a-fA-F]{3,8}|rgb|hsl)/.exec(
    analysisHtml + detailHtml + viewHtml,
  )
  assert.equal(hardcoded, null, `界面不得硬编码颜色，发现：${hardcoded?.[0] ?? ''}`)
  console.log('  ✓ 界面颜色全部走主题令牌（无硬编码色值）')

  // ── 文本预览：让人一眼看到卡片实际呈现的内容 ─────────────────────────────
  console.log('\n──── 卡片实际渲染内容预览（文本化）────')
  console.log(toText(html))
  console.log('──── 预览结束 ────\n')

  // ── 自包含 HTML 预览：可直接用浏览器打开看真实观感 ───────────────────────
  const cssText = await readFile(join(root, 'src/client/board.module.css'), 'utf8')
  const previewPath = join(root, 'preview/board-preview.html')
  await mkdir(dirname(previewPath), { recursive: true })
  await writeFile(previewPath, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-gitee-chat 看板卡片预览</title>
<style>
  body { margin: 0; padding: 24px; background: #f6f7f9; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  .note { font-size: 12px; color: #666; margin-bottom: 12px; line-height: 1.6; }
  /* 主题令牌：此处给出浅色默认值；真实运行时由 DSH 主题注入，自动跟随明暗 */
  :root {
    --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #ffffff; --dsw-alias-bg-layer-2: #f2f3f5;
    --dsw-alias-bg-overlay: #ffffff; --dsw-alias-border-l1: #e5e6eb; --dsw-alias-border-l2: #c9cdd4;
    --dsw-alias-brand-primary: #4d6bfe; --dsw-alias-label-primary: #1d2129; --dsw-alias-label-secondary: #86909c;
    --dsw-alias-state-error-primary: #f53f3f; --dsw-alias-state-success-primary: #00b42a; --dsw-alias-state-warn-primary: #ff7d00;
  }
  ${cssText.replace(/\.([a-zA-Z][\w-]*)/g, (_m, name) => `.GiteeChat_${name}`)}
</style></head>
<body><div class="wrap">
  <div class="note">这是 <code>BoardView</code> 的真实渲染输出（react-dom/server），数据来自 <code>gq.mjs --fixture</code>。
  运行时同一份 DOM 由 DSH 主题令牌着色，因此自动跟随明暗主题。</div>
  <h2 style="font-size:14px;margin:24px 0 8px">① 工具调用卡片（BoardView）</h2>
  ${html}
  <h2 style="font-size:14px;margin:28px 0 8px">② 整屏「Gitee 项目」标签页</h2>
  ${viewHtml}
  <h2 style="font-size:14px;margin:28px 0 8px">③ 固定分析（9 张卡片）</h2>
  ${analysisHtml}
  <h2 style="font-size:14px;margin:28px 0 8px">④ 工作项详情（描述 / 前置依赖 / 评论讨论 + 写回）</h2>
  ${detailHtml}
  <h2 style="font-size:14px;margin:28px 0 8px">⑤ 非 Gitee 会话的降级提示</h2>
  ${noticeHtml}
</div></body></html>
`)
  console.log(`  ✓ 自包含预览已写出：${previewPath}`)

  if (showHtml) {
    console.log(html)
  }
  console.log('全部通过 ✅')
}

main().catch((error) => {
  console.error('\n渲染检查失败 ❌')
  console.error(error)
  process.exit(1)
})
