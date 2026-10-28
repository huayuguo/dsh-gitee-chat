# dsh-gitee-chat

Gitee Enterprise project management inside a [DSH](https://github.com/deepseek-ai/deepseek-harness)
conversation: a full-page project workbench, a set of write tools, and 55 bundled Gitee Enterprise
MCP tools.

- **The panel never eats context**: work items, merge requests and the knowledge base are fetched by the
  panel itself from the host, so data volume never reaches the model;
- **Tools return summaries only**: `gitee_board` hands the model a few dozen to a thousand tokens of
  summary, while the card asks the host routes for the full payload;
- **Writing is bounded on purpose**: the UI exposes only the smallest write set (state / assignee /
  comment / create work item / PR actions); everything else goes through MCP.

![Gitee project panel: overview, project progress, risks and pending PRs](assets/overview.png)

## What you get

The **Gitee Project** entry in the session header is a **full-page workbench** (it renders in the
conversation body and does not take over or push out the right sidebar). Six tabs:

| Tab | Contents |
|---|---|
| Overview | Enterprise KPIs, risk reminders, recent activity |
| Projects | Project list + repo cards + work-item table (open / done / overdue / all); a row opens the detail, a repo card drills into three columns (project / repo / repo resources) |
| My Work Items | Items where you are **assignee or collaborator**, with open / done / overdue filters |
| Merge Requests | Awaiting my review / awaiting my test / opened by me / all, plus a state filter; a row opens the drawer |
| Knowledge Base | Project list + node tree with a draggable split; nodes expand on demand, attachments download on demand, previews prefer the sidebar |
| Fixed Analysis | Nine cards: project health / member load / overdue list / stalled / conventions / schedule variance / capacity / milestones / delivery trend |

**Repo card drilldown**: a repo card in the project detail opens three columns (project list | repo list |
repo resources); the left column is draggable and remembered; scope defaults to "this project" and can
switch to "internal open source", kept across projects; the repo page's three tabs (work items / merge
requests / WIKI) are told apart with warm tints. Work items open in place and can be created from the
top right (attached to that repo).

**Full merge-request flow** (inside the drawer): overview · changed files · comments · AI review →
approve / reject → tests pass → merge. "＋ New PR" supports a manual form (repo / branches / title /
description / reviewer count / tester count / draft / apply template) and posts to the host route
`POST /pr/create`, equivalent to the MCP tool `create_enterprise_repo_pull`.

**AI review**: the review job is dispatched to a **subagent under the main session you pick** (no user
message is injected into the main conversation); the panel polls the verdict and offers actions you can
land in one click (submit comment + reject / approve). Review and test templates are bound separately and
editable in the panel (saved as user copies); the PR description template is applied when creating a PR.
Failure reasons are mapped to plain language (`not-reviewer` / `nothing-to-reset` / `nothing-to-merge`).

**Work items**: create (title / assignee / priority / schedule required, mirroring the Gitee web form),
change state, reassign, comment; states use four-color pills. Writes do not reload the whole page: the
panel refetches in the background and updates in place. The detail pane shows the description,
prerequisites (both Gitee IDs and WBS codes) and the comment thread.

**Capability tiers**: there is exactly one agent preset, "Gitee 项目管理". The tier is not selected — it
is derived on every fetch from **the token's role and project relationships in Gitee Cloud**: enterprise
owner / super-admin / admin = manager (55 MCP tools, cross-project analysis); a project assignee = project
tier (48); everyone else = exec tier (40, own work items only). Switching enterprise or token changes the
tier immediately.

## Install

Requires DSH `^0.2.0-rc.2` and Node `^22.19 || >=24`.

```sh
# from the official npm registry (recommended)
dsh plugin --profile desktop add dsh-gitee-chat
```

| Source | Command | When |
|---|---|---|
| **npm** | `dsh plugin --profile desktop add dsh-gitee-chat` | default |
| GitHub Release asset | `dsh plugin --profile desktop add "https://github.com/huayuguo/dsh-gitee-chat/releases/download/v0.5.4/dsh-gitee-chat-0.5.4.tgz"` | npm is slow / unreachable |
| git tag | `dsh plugin --profile desktop add "git+https://github.com/huayuguo/dsh-gitee-chat.git#v0.5.4"` | pin a tag |
| local source | see "Local source" below | development |

**Local source** (development, changing code):

```sh
# 1) build (lib/ is generated, not committed; lib/types/ ships with lib)
npm install --legacy-peer-deps
npm run build

# 2) install into a profile (desktop app: desktop, dsh web: web)
dsh plugin --profile desktop add "file:$(pwd)"
```

You can also use Settings → Plugins → Add plugin with `file:<absolute path>`.

- **Pick the right profile**: a wrong profile fails **silently** — the UI shows nothing and no error.
- On Windows use the app's own `dsh` (`<app>\resources\runtime\cli\bin\dsh.cmd`); a globally installed
  one refuses `--profile desktop`.
- **Upgrading means `remove` then `add`** (installs are copies, there is no auto-update). Coming from
  0.5.3, your profile may still contain the old preset rows (`preset-gitee-exec` /
  `preset-gitee-manager`); remove them so you don't end up with two Gitee entries.
- npm publishes to the official registry (`registry.npmjs.org`) only; mirrors sync automatically, do not
  publish to a mirror.
- After installing, open **Settings → Gitee Enterprise** and paste an enterprise access token.
- On the script side only runtime scripts ship (`scripts/setup.mjs`, `scripts/check-presets.mjs`,
  `scripts/gitee/`); build and self-check scripts stay in the repo (`npm run check` uses them). The npm
  package ships `lib/` (including `lib/types/`) and no longer ships `src`.
- To let an agent do it: the bundle ships `skills/dsh-gitee-chat/SKILL.md`; just say "install this Gitee
  plugin and ask me the config questions".

## Configuration

Everything lives on one page, **Settings → Gitee Enterprise**, and **saves take effect immediately**:

| Item | Meaning |
|---|---|
| Enterprise token | Stored in `$DSH_HOME/.gitee-chat/token`; the fetch script and the MCP child process read the same file |
| Current enterprise | Pick one when the token can see several, so you never read another company's data |
| Agents may read the board snapshot | On by default: `gitee_board_snapshot` returns a snapshot (with its age) instead of re-paging |
| Persist snapshots | On by default: cache written to `$DSH_HOME/.gitee-chat/cache/`, still hit after a restart |
| Freshness (seconds) | Default 60, minimum 10, `0` disables the cache |
| Background refresh | Off by default; when on, the board is pre-fetched on the interval below so the panel opens warm |
| Refresh interval (seconds) | Default 60, minimum 10 |
| Idle pause (minutes) | Default 30: nobody used the panel for that long → stop refreshing, avoiding idle load and rate limits |

Local overrides of those values live in `$DSH_HOME/.gitee-chat/config.json` and win over the static
values in the plugin patch.

Token resolution order: `GITEE_ENT_MCP_ACCESS_TOKEN` / `GITEE_ACCESS_TOKEN` / `GITEE_TOKEN` →
`$DSH_HOME/.gitee-chat/token` → `$DSH_HOME/gitee-chat-token` → `~/.gitee-token`. The desktop app started
from the menu does **not** inherit shell exports, so prefer the settings page.

## Tools

| Tool | Purpose |
|---|---|
| `gitee_board` | Board summary (the model reads the summary, the panel reads everything) |
| `gitee_board_snapshot` | Read the cached snapshot directly; returns `fetchedAt / ageSeconds / stale / ttlSeconds` |
| `gitee_role` | Identity, persona and capability tier of the current token |
| `gitee_enterprises` | List / switch the current enterprise |
| `gitee_chat_health` | Fetch-environment self-check (token / enterprise / connectivity) |
| `gitee_ent` | **Public gateway**: `op:"list"` → `op:"schema"` → `op:"call"`, reaching all 55 enterprise MCP tools outside a Gitee preset session |

In a Gitee preset session `gitee_ent` is hidden on purpose (so it cannot bypass the tier gate); use the
native `mcp__gitee_ent__*` tools instead (trimmed by tier). In a read-only deployment
(`allowWrites: false`) write tools are hard-blocked; the real boundary is always the token's role in
Gitee Cloud.

## Bundled MCP

`vendor/mcp-gitee-ent/` ships the `mcp-gitee-ent` binary (Linux / Windows amd64, upstream baseline
**v0.2.5**, 55 tools). Installation drops it into the user-level bin (Linux/macOS `~/.local/bin`,
Windows `%USERPROFILE%\.local\bin`), so no `go install` is needed; other platforms can point
`MCP_GITEE_ENT_BIN` at their own binary.

MCP is a process-level direct connection, **with no session-mode gate**: any session can fetch data, and
whether you can write still depends on the cloud token. PR sub-resource parameters are uniformly
`pull_request_iid` (it was `pull_request_id` up to 0.5.3); attachment downloads retry automatically on a
404.

## Fetching and caching

- One fetch means "start a Node script → HTTPS to the Gitee Enterprise API"; one round trip is ~0.4s;
- read routes keep a 30s cache, the runner keeps results for another 60s, both single-flight (one request
  in flight per key); writes clear both layers, so repeat clicks answer in <10ms;
- hovering a work-item row prefetches its detail, so clicking hits the cache;
- board paging probes concurrently: 307 work items went 2.6s → 1.6s; work-item detail went 1.8s → 0.5s
  (detail and comments in parallel, the dependency index is skipped when unused);
- the panel renders the previous snapshot first and refreshes in the background (fresh within 60s by
  default), and the session can read the same snapshot through `gitee_board_snapshot`;
- slow requests log a `[gitee-chat][slow]` line; `GITEE_CHAT_TRACE=1` logs everything.

## Development

```sh
npm install --legacy-peer-deps
npm run build        # lib/*.js + lib/types/ (host / agent / panel)
npm run check        # types + smoke + render assertions + capabilities + presets + MCP binary
npm run doctor       # portability check (presets / plugin row / artifacts / token / enterprise)
npm pack             # produce an installable tgz (only files listed in package.json `files`)
```

`src/index.ts` is the host half (routes, cache, write channel, settings), `src/agent.ts` is the agent half
(tools and persona), `src/client/` holds the panel components (`GiteeProjectView.tsx` is the full-page
entry) and `scripts/gitee/gq.mjs` is the fetch script.

## Docs

| Document | Audience |
|---|---|
| [`USAGE.md`](./USAGE.md) | Users: how the UI works, what to do when something breaks |
| [`skills/dsh-gitee-chat/SKILL.md`](./skills/dsh-gitee-chat/SKILL.md) | Agents: install / configure / diagnose / MCP usage (index level; details in `references/{mcp,panel,recipes,install}.md`) |

Design notes, decision records, the feature list and the capability matrix are **internal material** and
are not part of this repository.

Chinese: [README.md](./README.md)

## License

[MIT](./LICENSE) © 2026 Baoding Duopukang Intelligent Technology Co., Ltd. · jackxiao (xd20260413@outlook.com)
