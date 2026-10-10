/**
 * 仓库 WIKI 的取数与缓存（host 平面）。
 *
 * ## 为什么这里出现了 git —— 以及它为什么**不是**越界
 *
 * 本层守一条纪律：**MCP 是文档能力的唯一实现**，插件不拼任何 Gitee 端点。
 * 仓库 WIKI 是这条纪律的**唯一例外**，理由是可验证的事实，不是偏好：
 *
 * 实测（2026-09-15）穷举了两侧：
 *   - `api.gitee.com/enterprises/{eid}/projects/{id}/{wikis,wiki,wiki_trees,docs,…}`
 *     —— 全部 404；
 *   - `gitee.com/api/v5/repos/{owner}/{repo}/wikis` —— **405 Not Allowed**
 *     （网关层面就没有这个路由）；
 *   - `doc_nodes` 只有**企业级**与**项目（program）级**两个维度，传仓库 id 返回 0；
 *     且全企业 `is_wiki=true` 的节点为 0 篇。
 *
 * 而仓库 WIKI 确实存在（`/projects` 的 `wiki_enabled_with_content` 有 6 个为 true），
 * 它的**唯一形态是 git 仓库**：
 *
 *     https://gitee.com/{path_with_namespace}.wiki.git   →  一棵 .md 文件树
 *
 * 所以这一段是"补 MCP 补不了的那一格"，不是"重写 MCP 已有的能力"。
 * 集中在这一个文件里，就是为了将来若要把它挪进 fork（做成 MCP 工具），
 * 替换面只有这一个模块。
 *
 * ## 两个实测坑（别踩回去）
 *
 * 1. **必须用 `path_with_namespace`，不能用 `name`**：同一个仓库两者经常不同
 *    （`name=demo-docs` / `path=docs`；`name=demo-server` / `path=demoserver`），
 *    用 name 拼会 404。
 * 2. **token 不进命令行**：`https://oauth2:TOKEN@…` 会出现在 `ps` 里。
 *    这里用 `credential.helper` 从**环境变量**读密码，argv 里只有仓库地址。
 *
 * @module dsh-gitee-chat/host/wiki-cache
 */

import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 工作区里放软链接的目录名。
 *
 * 用 `.dsh/`：这是 DSH 自己的"每工作区状态"约定目录，不会被当成项目源码；
 * 且我们只往里放**一个软链接**，不写任何实体文件。
 */
export const WORKSPACE_LINK_DIR = '.dsh'

/** 软链接名（`<cwd>/.dsh/gitee-docs` → 缓存根）。 */
export const WORKSPACE_LINK_NAME = 'gitee-docs'

/** 一次 git 命令的超时（毫秒）。WIKI 都很小，60s 足够。 */
const GIT_TIMEOUT_MS = 60_000

/** WIKI 页列表里最多列多少个文件（防御异常大的仓库）。 */
const MAX_PAGES = 500

/** 单页正文读取上限（字符）。 */
export const DEFAULT_MAX_PAGE_CHARS = 200_000

/** wiki 缓存的依赖。 */
export interface WikiCacheDeps {
  /** 缓存根（与附件同一个根：`$DSH_HOME/gitee/docs`）。 */
  readonly cacheRoot: string
  /**
   * 取 Gitee 访问令牌（**必须每次现取**，不要缓存到闭包里：
   * 令牌轮换后闭包会一直用旧的）。
   */
  readonly token: () => string
  /** git 可执行文件（默认 `git`，走 PATH）。 */
  readonly git?: string
  /** 单次 git 超时。 */
  readonly timeoutMs?: number
  /** 诊断日志（只记命令名与结果，**绝不记 token**）。 */
  readonly log?: (message: string) => void
}

/** 一次取数的结果。 */
export interface WikiFetchResult {
  /** 本地克隆目录。 */
  dir: string
  /** 本次是否真的跑了 git（false = 复用已有克隆）。 */
  fetched: boolean
  /** HEAD commit（空仓为空串）。 */
  head: string
  /** 取不回来时的一句话说明（此时 head 为空、pages 为空）。 */
  notice?: string
}

/** WIKI 里的一页（一个文件）。 */
export interface WikiFile {
  path: string
  name: string
  title: string
  bytes: number
  updatedAt: string
}

/**
 * 把仓库路径段转成一个安全的目录名。
 * `example-org/docs` → `example-org__docs`（`/` 不能进单个目录名）。
 */
export function safeRepoSegment(pathWithNamespace: string): string {
  return pathWithNamespace.replace(/[\\/]+/g, '__').replace(/[^\w.@-]/g, '_')
}

/** 摘掉最后一个扩展名（`设备参数.md` → `设备参数`）。 */
function stripExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * 计算一条绝对缓存路径在**会话工作区里可见**的路径。
 *
 * 侧边栏的文件围栏（`workspaceFence`）按**会话 cwd 的 realpath** 判定，
 * 而缓存根在工作区之外 —— 所以必须经由 `<cwd>/.dsh/gitee-docs` 这条软链接
 * 才能让侧边栏读到。
 *
 * @param link - `<cwd>/.dsh/gitee-docs`（软链接绝对路径）。
 * @param cacheRoot - 缓存根绝对路径。
 * @param absolute - 缓存里某个文件的绝对路径。
 * @returns 工作区里可用的绝对路径；`absolute` 不在 `cacheRoot` 下时返回 null。
 */
export function toWorkspacePath(link: string, cacheRoot: string, absolute: string): string | null {
  const rel = relative(resolve(cacheRoot), resolve(absolute))
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  return join(link, rel)
}

/**
 * 创建 WIKI / 附件的取数与缓存。
 * @param deps - 缓存根、令牌来源、git 位置。
 */
export function createWikiCache(deps: WikiCacheDeps) {
  const { cacheRoot } = deps
  const git = deps.git ?? 'git'
  const timeoutMs = deps.timeoutMs ?? GIT_TIMEOUT_MS
  const log = deps.log ?? (() => {})

  /**
   * 跑一条 git 命令。
   *
   * 凭据经 `credential.helper` 从**环境**读：argv 里不出现 token，
   * 于是 `ps` / 进程列表看不到它。
   * @param args - git 参数。
   * @param cwd - 工作目录。
   */
  async function gitRun(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const token = deps.token()
    if (token === '') {
      return { ok: false, stdout: '', stderr: '没有可用的 Gitee 访问令牌（环境变量 GITEE_ENT_MCP_ACCESS_TOKEN / GITEE_ACCESS_TOKEN / GITEE_TOKEN，或设置界面写入的 $DSH_HOME/.gitee-chat/token 都没配）。' }
    }
    try {
      const { stdout, stderr } = await run(git, [
        // 先清空继承来的 helper，再挂一个只认本次令牌的 —— 避免用到用户 ~/.git-credentials 里别的账号。
        '-c', 'credential.helper=',
        '-c', 'credential.helper=!f() { echo username=oauth2; echo "password=$GITEE_WIKI_TOKEN"; }; f',
        ...args,
      ], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GITEE_WIKI_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
      })
      return { ok: true, stdout: String(stdout), stderr: String(stderr) }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
      const stderr = String(e.stderr ?? '') || String(e.message ?? '')
      if (e.killed === true) {
        return { ok: false, stdout: String(e.stdout ?? ''), stderr: `git ${args[0]} 超时（${timeoutMs}ms）。` }
      }
      return { ok: false, stdout: String(e.stdout ?? ''), stderr }
    }
  }

  /** 一个仓库的本地克隆目录。 */
  function dirOf(repo: { pathWithNamespace: string; repoId: number }): string {
    const seg = safeRepoSegment(repo.pathWithNamespace) || `repo-${repo.repoId}`
    return join(cacheRoot, 'wiki', seg)
  }

  /** 克隆地址（**用 path_with_namespace，不是 name**）。 */
  function cloneUrl(repo: { pathWithNamespace: string }): string {
    return `https://gitee.com/${repo.pathWithNamespace}.wiki.git`
  }

  /** 取当前 HEAD（空仓/失败返回空串）。 */
  async function headOf(dir: string): Promise<string> {
    const r = await gitRun(['rev-parse', 'HEAD'], dir)
    return r.ok ? r.stdout.trim() : ''
  }

  /**
   * 确保一个仓库的 WIKI 已在本地，并（可选）拉到最新。
   *
   * 语义对齐附件那条路：**按需**（点开哪个仓库才拉哪个），**不预拉**。
   * 已经克隆过就只做一次 `fetch --depth 1` + `reset --hard` —— 绝不 `pull`，
   * 因为 WIKI 是只读镜像，本地不应该有提交。
   *
   * @param repo - 仓库定位信息（`pathWithNamespace` 决定克隆地址与目录名）。
   * @param refresh - true = 强制 fetch；false = 已有克隆就直接用。
   */
  async function ensure(repo: { repoId: number; name: string; pathWithNamespace: string }, refresh = false): Promise<WikiFetchResult> {
    const dir = dirOf(repo)
    const cloned = existsSync(join(dir, '.git'))

    if (cloned && !refresh) {
      return { dir, fetched: false, head: await headOf(dir) }
    }

    if (!cloned) {
      mkdirSync(dirname(dir), { recursive: true })
      // 有过一次失败的克隆会留下半个目录，而 git 拒绝往非空目录里克隆
      // （"destination path already exists and is not an empty directory"）——
      // 于是重试报的是另一个错，永远回不到真正的失败原因。先清干净。
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      const r = await gitRun(['clone', '--depth', '1', '--single-branch', cloneUrl(repo), dir])
      if (!r.ok) {
        rmSync(dir, { recursive: true, force: true })
        return {
          dir,
          fetched: false,
          head: '',
          notice: `克隆 WIKI 失败：${firstLine(r.stderr)}`,
        }
      }
      const head = await headOf(dir)
      log(`[gitee-chat] 已克隆 WIKI ${repo.pathWithNamespace}（head=${head.slice(0, 8) || '空仓'}）`)
      return { dir, fetched: true, head }
    }

    // 已有克隆：fetch + reset。失败不致命 —— 用本地那份继续（离线也能看）。
    const f = await gitRun(['fetch', '--depth', '1', 'origin'], dir)
    if (!f.ok) {
      return {
        dir,
        fetched: false,
        head: await headOf(dir),
        notice: `WIKI 远端刷新失败（用的是本地那份）：${firstLine(f.stderr)}`,
      }
    }
    await gitRun(['reset', '--hard', 'FETCH_HEAD'], dir)
    const head = await headOf(dir)
    log(`[gitee-chat] 已刷新 WIKI ${repo.pathWithNamespace}（head=${head.slice(0, 8) || '空仓'}）`)
    return { dir, fetched: true, head }
  }

  /**
   * 递归列出一个克隆目录里的文件（跳过 `.git`）。
   * @param dir - 克隆目录。
   */
  function files(dir: string): WikiFile[] {
    const out: WikiFile[] = []
    const walk = (current: string, prefix: string, depth: number): void => {
      if (out.length >= MAX_PAGES || depth > 8) return
      let entries: string[]
      try {
        entries = readdirSync(current)
      } catch {
        return
      }
      for (const entry of entries.sort()) {
        if (entry === '.git') continue
        const abs = join(current, entry)
        const rel = prefix === '' ? entry : `${prefix}/${entry}`
        let st
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(abs, rel, depth + 1)
          continue
        }
        if (!st.isFile()) continue
        out.push({
          path: rel,
          name: entry,
          title: stripExt(entry),
          bytes: st.size,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        })
        if (out.length >= MAX_PAGES) return
      }
    }
    walk(dir, '', 0)
    return out
  }

  /**
   * 读一页正文。
   * @param dir - 克隆目录。
   * @param relPath - 相对克隆根目录的路径。
   * @param maxChars - 截断上限。
   */
  function read(dir: string, relPath: string, maxChars = DEFAULT_MAX_PAGE_CHARS): { content: string; truncated: boolean; bytes: number; title: string; name: string } | undefined {
    // 路径穿越防护：把 `..` 挡在克隆目录之外（前端传来的 path 不可信）。
    const abs = resolve(dir, relPath)
    const rel = relative(resolve(dir), abs)
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) return undefined
    if (!existsSync(abs)) return undefined
    const st = statSync(abs)
    if (!st.isFile()) return undefined
    const text = readFileSync(abs, 'utf8')
    const truncated = text.length > maxChars
    const name = rel.split('/').pop() ?? rel
    return {
      content: truncated ? text.slice(0, maxChars) : text,
      truncated,
      bytes: st.size,
      title: stripExt(name),
      name,
    }
  }

  /**
   * 确保会话工作区里存在指向缓存根的软链接，并保证它被 git 忽略。
   *
   * 为什么需要它：侧边栏的文件围栏按**会话 cwd** 判定，缓存根在工作区之外，
   * 直接把缓存路径交给 `betterSidebar.openFile` 会被 403 拒绝。
   *
   * 忽略规则用 `<repo>/.git/info/exclude` 而不是 `.gitignore`：
   * 后者是**被跟踪的文件**，插件不该改用户仓库里的受版本控制内容。
   *
   * @param cwd - 会话工作目录（拿不到就返回 null）。
   * @returns 软链接绝对路径；无法安全创建时返回 null。
   */
  async function workspaceLink(cwd: string): Promise<string | null> {
    if (cwd === '' || !cwd.startsWith('/')) return null
    const dir = join(cwd, WORKSPACE_LINK_DIR)
    const link = join(dir, WORKSPACE_LINK_NAME)
    try {
      mkdirSync(dir, { recursive: true })
      let exists = true
      try {
        lstatSync(link)
      } catch {
        exists = false
      }
      if (!exists) {
        symlinkSync(cacheRoot, link, 'dir')
      } else {
        // 已存在：必须是"指向缓存根的软链接"，否则**绝不覆盖**（可能是用户自己的东西）。
        const st = lstatSync(link)
        if (!st.isSymbolicLink()) return null
        const target = resolve(dir, readlinkSync(link))
        if (target !== resolve(cacheRoot) && target !== resolve(cacheRoot, '.')) return null
      }
      await ignoreInGit(cwd)
      return link
    } catch {
      return null
    }
  }

  /**
   * 若 cwd 在一个 git 仓库里，把 `.dsh/` 加进该仓库的**本地**排除表。
   *
   * 只在"还没被忽略"时追加，幂等；任何失败都静默（忽略规则没写上不该让功能不可用）。
   * @param cwd - 会话工作目录。
   */
  async function ignoreInGit(cwd: string): Promise<void> {
    const top = await gitRun(['rev-parse', '--show-toplevel'], cwd)
    if (!top.ok) return
    const root = top.stdout.trim()
    if (root === '') return
    // `check-ignore -q <path>` 退出码 0 = 已被忽略。
    const ignored = await gitRun(['check-ignore', '-q', `${WORKSPACE_LINK_DIR}/`], cwd)
    if (ignored.ok) return
    const exclude = join(root, '.git', 'info', 'exclude')
    try {
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (current.split('\n').some((line) => line.trim() === `${WORKSPACE_LINK_DIR}/`)) return
      mkdirSync(dirname(exclude), { recursive: true })
      const next = `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}\n# dsh-gitee-chat：工作区里的知识库软链接（由插件创建，勿提交）\n${WORKSPACE_LINK_DIR}/\n`
      writeFileSync(exclude, next, 'utf8')
      log(`[gitee-chat] 已把 ${WORKSPACE_LINK_DIR}/ 加进 ${root}/.git/info/exclude`)
    } catch {
      // 忽略规则写不上不影响功能（软链接已经建好了）。
    }
  }

  return {
    cacheRoot,
    /** 仓库的本地克隆目录。 */
    dirOf,
    /** 克隆地址（诊断用；**不含 token**）。 */
    cloneUrl,
    ensure,
    files,
    read,
    workspaceLink,
  }
}

/**
 * 从 git 的 stderr 里挑出**真正的错误行**。
 *
 * 为什么不是"取第一行"：git 把进度信息也写 stderr，第一行往往是
 * `正克隆到 '...'`（Cloning into）—— 拿它当错误原因等于什么都没说。
 * 实测就是这么把 `仓库 … 未找到` 挡在后面的。
 * @param text - git 的 stderr。
 */
function firstLine(text: string): string {
  const noise = /^(正克隆到|Cloning into|remote:|warning:|注意：)/
  const lines = text.split('\n').map((s) => s.trim()).filter((s) => s !== '' && !noise.test(s))
  return (lines[0] ?? text.split('\n').map((s) => s.trim()).find((s) => s !== '') ?? '未知原因').slice(0, 300)
}

export type WikiCache = ReturnType<typeof createWikiCache>
