# dsh-gitee-chat

Gitee project management inside a [DSH](https://github.com/deepseek-ai/deepseek-harness) session:
a full-page, clickable project workbench + a set of write-capable tools + 55 Gitee Enterprise MCP tools
bundled in.

- **The panel costs no context**: work items / merge requests / knowledge base data are fetched by the panel from the host, never through the model;
- **Tools return summaries only**: `gitee_board` gives the model a few dozen to a thousand tokens; the card asks the host routes for the full payload;
- **Writes stay bounded**: the UI only exposes the minimal write set (state / assignee / comment / new work item / PR actions); everything else goes through MCP.

![Gitee project panel: overview · project progress · risks and PR to-dos](assets/overview.png)

## What you get

"Gitee 项目" in the session header is a **full-page workbench** (rendered in the conversation body, it
neither takes over nor pushes out the right sidebar), with six tabs:

| Tab | Contents |
|---|---|
| Overview | Enterprise KPIs, risk reminders, recent activity |
| Projects | Project list on the left + repo cards + work-item table (open / done / overdue / all); a row opens details, a repo card drills into three columns (project / repo / repo resources) |
| My Work Items | Items where you are assignee **or** collaborator, with open / done / overdue filters |
| Merge Requests | Awaiting my review / awaiting my test / opened by me / all, plus state filters; a row opens the drawer |
| Knowledge Base | Project list + node tree with a draggable split; nodes expand on demand, attachments download on demand, previews prefer the sidebar |
| Fixed Analysis | Nine cards: project health / member load / overdue list / stalled / conventions / schedule variance / delivery capacity / milestones / delivery trend |

**Repo card drilldown**: clicking a repo card in project details opens three columns (projects | repos |
repo resources); the left column is draggable and remembered; the scope defaults to "this project" and
can switch to internal open-source, kept across projects; repo details have three tabs (work items /
merge requests / WIKI) in warm tints. Work items open in place, and new ones can be created from the
top right (attached to that repo).

**Merge request flow** (inside the drawer): overview · changed files · comments · AI review → approve /
reject → tests pass → merge. "＋ 新建 PR" supports manual entry (repo / branches / title / description /
reviewer count / tester count / draft / template) and posts to the host route `POST /pr/create`, which
is equivalent to the MCP tool `create_enterprise_repo_pull`.

**AI review**: the review job is dispatched to a **subagent under the session you pick** (no user
message is injected into the main conversation); the panel polls the conclusion and offers one-click
follow-ups (comment + reject / approve). Review and test templates are bound separately and editable in
the panel (stored as your copy); the PR description template is applied when creating a PR. Failure
reasons are mapped to plain language (not-reviewer / nothing-to-reset / nothing-to-merge).

**Work items**: create (title / assignee / priority / schedule are required, the dialog mirrors the
Gitee web UI), change state, reassign, comment; states use four colored pills. Writes do not reload the
page: data is refetched in the background and updated in place. Details show the description,
prerequisites (both Gitee identifiers and WBS codes) and the comment thread.

**Capability tiers**: there is exactly one agent preset, "Gitee 项目管理". The tier is not selected but
derived on every fetch from **the token's role and project relationships in Gitee Cloud**: enterprise
owner / super-admin / admin = manager (55 MCP tools, cross-project analysis); a project assignee =
project tier (48); everyone else = exec tier (40, own work items only). Switching enterprise or token
changes the tier immediately.

## Install

Requires DSH `^0.2.0-rc.2`, Node `^22.19 || >=24`.

<!-- parity:install:begin —— 两条线只在这一段分叉（装法），其余正文逐字一致 -->
```sh
# install from the official npm registry (recommended)
dsh plugin --profile desktop add dsh-gitee-chat
```

| Source | Command | When to use |
|---|---|---|
| **npm registry** | `dsh plugin --profile desktop add dsh-gitee-chat` | Default |
| GitHub Release asset | `dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.4/dsh-gitee-chat-0.5.4.tgz"` | When npm is unreachable |
| Direct from git | `dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.4"` | Pin a tag |

**From source** (development, code changes):

```sh
npm install --legacy-peer-deps
npm run build
dsh plugin --profile desktop add "file:$(pwd)"
```
<!-- parity:install:end -->

You can also use "Settings → Plugins → Add plugin" in the app and enter `file:<absolute path>`.

- **Get the profile right**: a wrong profile fails silently — nothing shows up and no error is reported.
- On desktop use the **bundled** `dsh` (`<app dir>\resources\runtime\cli\bin\dsh.cmd`); a globally installed one rejects `--profile desktop`.
- **Upgrade = `remove` then `add`** (the installed copy never auto-updates). Coming from 0.5.3, the profile may
  still hold the old preset rows (`preset-gitee-exec` / `preset-gitee-manager`) — delete them to avoid two Gitee entries.
- npm publishes only to the official registry (`registry.npmjs.org`); mirrors sync automatically, never publish to a mirror.
- After installing, fill the enterprise access token in **Settings → Gitee 企业项目**.
- Only runtime scripts ship (`scripts/setup.mjs`, `scripts/check-presets.mjs`, `scripts/gitee/`); build and
  self-check scripts stay in the repo (used by `npm run check`); the npm package ships `lib/` (including
  `lib/types/`) and no longer ships `src`.
- Let an AI do it end to end: this package bundles `skills/dsh-gitee-chat/SKILL.md`, so "install this Gitee plugin, ask me for config" is enough.

## Configuration

"Settings → Gitee 企业项目" covers everything and **takes effect immediately, no restart**:

| Item | Description |
|---|---|
| Enterprise token | Stored in `$DSH_HOME/.gitee-chat/token`; the fetch script and the MCP child process read the same file |
| Current enterprise | Pick one when the token sees several, to avoid "wrong company's data" |
| Session AI may read the board snapshot | On by default: `gitee_board_snapshot` returns a snapshot (with freshness) instead of refetching pages |
| Persist snapshots | On by default: cache is written to `$DSH_HOME/.gitee-chat/cache/` and survives restarts |
| Freshness (seconds) | Default 60, minimum 10, `0` disables caching |
| Background refresh | Off by default; when on, the board is prefetched at the interval below so opening the panel is warm |
| Refresh interval (seconds) | Default 60, minimum 10 |
| Idle pause (minutes) | Default 30: no refresh while nobody uses the panel, avoiding idle load and rate limits |

Local overrides live in `$DSH_HOME/.gitee-chat/config.json` and take precedence over the static config in
the plugin patch.

Token resolution order: env `GITEE_ENT_MCP_ACCESS_TOKEN` / `GITEE_ACCESS_TOKEN` / `GITEE_TOKEN` →
`$DSH_HOME/.gitee-chat/token` → `$DSH_HOME/gitee-chat-token` → `~/.gitee-token`.
The desktop app started from the menu **does not inherit shell exports**, so prefer the settings page.

## Tools

| Tool | Purpose |
|---|---|
| `gitee_board` | Board summary (the model sees the summary, the panel sees the full payload) |
| `gitee_board_snapshot` | Reads the cached snapshot directly, returning `fetchedAt / ageSeconds / stale / ttlSeconds` |
| `gitee_role` | Identity, persona and capability tier of the current token |
| `gitee_enterprises` | List / switch the current enterprise |
| `gitee_chat_health` | Fetch-environment self-check (token / enterprise / connectivity) |
| `gitee_ent` | **Public gateway**: `op:"list"` → `op:"schema"` → `op:"call"`, exposing the 55 enterprise MCP tools outside the Gitee preset |

Inside the Gitee preset session `gitee_ent` is deliberately hidden (to prevent bypassing tier gating);
use the native `mcp__gitee_ent__*` tools (trimmed per tier) instead. In a read-only deployment
(`allowWrites: false`) write tools are blocked outright; the real boundary is always the token's role in
Gitee Cloud.

## Bundled MCP

`vendor/mcp-gitee-ent/` ships the `mcp-gitee-ent` binary (Linux / Windows amd64, upstream baseline
**v0.2.5**, 55 tools). It is installed into a user-level bin on setup (Linux/macOS `~/.local/bin`,
Windows `%USERPROFILE%\.local\bin`), so `go install` is not needed; on other platforms point
`MCP_GITEE_ENT_BIN` at your own binary. MCP is a process-level direct connection with **no session-mode
gate**: any session can fetch data, and writes still depend on the cloud token. PR sub-resource parameters
are uniformly `pull_request_iid` (0.5.3 and earlier used `pull_request_id`); the fork's four own PR tools
(accept / reject / reset / test) were renamed accordingly; attachment downloads fall back automatically on 404.

## Fetching and caching

- One fetch is "spawn a Node script → HTTPS to the Gitee Enterprise API"; a single round trip is ~0.4s;
- Read routes cache for 30s, the runner memoizes results for another 60s, with single-flight concurrency
  (the same request is issued once); writes clear both layers, so repeated clicks take <10ms;
- Hovering a work-item row prefetches its details, so a click hits the cache;
- Board pagination now probes pages concurrently: 307 work items 2.6s → 1.6s; work-item details 1.8s →
  0.5s (details and comments in parallel, no index fetch when there are no prerequisites);
- Opening the panel renders the previous snapshot first and refreshes in the background (fresh within 60s
  by default); sessions can read the same snapshot via `gitee_board_snapshot`;
- Slow requests log `[gitee-chat][slow]`; `GITEE_CHAT_TRACE=1` logs everything.

## Development

```sh
npm install --legacy-peer-deps
npm run build        # lib/*.js + lib/types/ (host / agent / panel)
npm run check        # types + smoke + render assertions + capability matrix + preset delivery + MCP binary check
npm run doctor       # portability check (preset / plugin rows / artifacts / token / enterprise)
npm pack             # produces the installable tgz (only files listed in package.json `files`)
```

`src/index.ts` is the host half (routes, caches, write endpoints, settings), `src/agent.ts` the agent half
(tools and persona), `src/client/` the panel components (`GiteeProjectView.tsx` is the full-page entry),
and `scripts/gitee/gq.mjs` the fetch script.

## Docs

| Doc | Audience |
|---|---|
| [`USAGE.md`](./USAGE.md) | Users: how the UI works, what to do when something breaks |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | AI: install / configure / diagnose / MCP usage (index layer, details in `references/{mcp,panel,recipes,install}.md`) |

Design notes, decision records, the feature list and the capability matrix are **internal material** and
are not distributed with the repo (`node scripts/gen-capabilities.mjs` regenerates the capability matrix).

中文: [README.md](./README.md)

## License

[MIT](./LICENSE) © 2026 保定多普康智能科技有限公司 · jackxiao (xd20260413@outlook.com)
