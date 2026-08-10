# GitHub Mirror

Mirrors Paperclip task state into GitHub issues, one way.

Paperclip stays the store of record. GitHub is a viewing surface: a place to glance at what
the agents are doing, and to see when something stalled. The plugin never reads GitHub state
back — comments and edits made on the GitHub side are not synced anywhere.

## What gets mirrored

| Paperclip event | Effect on GitHub |
|---|---|
| `issue.created` | Creates an issue titled `[IDENTIFIER] Title`, labelled `paperclip:<status>` |
| `issue.updated` | Only on an actual status change: updates title/body/label and comments the transition. Terminal states (`done`, `cancelled`) close the issue |
| `agent.run.failed` | Comments the failure, with the run id and truncated error |
| `budget.incident.opened` / `.resolved` | Comments a pause / resume — a budget stop is a valid observable state, not a failure |
| `escalation-raised` (from the escalation plugin) | Comments that the task was escalated and needs a human |

The escalation entry is plugin-to-plugin: the escalation plugin decides *when* a task needs a
human, this one only renders it. The mirror holds no escalation logic of its own.

An issue created before the mirror was configured is picked up on its next status change.

## Configuration

| Field | Meaning |
|---|---|
| `repository` | Target repo as `owner/repo` |
| `token` | Secret reference to a token with `issues:write` on that repo |
| `mirrorEnabled` | Turn mirroring off without uninstalling |

The token is a secret reference, resolved per call and never cached, logged, or written to
plugin state.

## Behaviour under failure

GitHub being down, rate-limiting, or rejecting the token must not stop Paperclip from
processing events. Every handler is wrapped: failures are logged and the worker keeps
running.

**Retry.** Each write is attempted up to three times, with a jittered 1s/4s backoff, when
GitHub asked us to back off (429, rate-limited 403), fell over (5xx), or the worker→host
call timed out without an answer. Everything else — 401, 404, 422 — fails on the first
attempt, because it will fail identically on the second. If GitHub named a wait via
`retry-after` or `x-ratelimit-reset`, that wait is used instead of the backoff.

**Timeouts.** The plugin does not set one, and cannot: `ctx.http.fetch` serializes only
method, headers and body, so an `AbortSignal` never reaches the host. It does not need to.
Each call is already bounded at 30s twice over — by the SDK's worker→host call timer and by
the host's own `AbortController` — and the retry budget is capped at that same 30s so three
attempts cannot occupy a handler for a minute and a half.

**Duplicate creates.** Mirroring is idempotent: the GitHub issue number is stored in plugin
state, so repeated events never create duplicates. Creating the issue is the one step that
cannot simply be repeated, so it is written down first — see below.

## The create outbox

Event delivery is fire-and-forget. The host pushes events as a JSON-RPC notification and
drops them outright when the worker is down; there is no replay. So if a create is
interrupted between the POST and the write that records its number, nothing would ever
mention it again — and the next event for that task would happily create a second GitHub
issue.

Before posting, the plugin upserts a `mirror-create` entity keyed `<companyId>:<issueId>`
with status `pending`. On success it stores the number in plugin state and flips the record
to `done`. A `pending` record therefore means exactly one thing: a create was attempted and
we do not know how it ended.

A scheduled job (`*/5 * * * *`) resolves those:

| Record | Becomes | Why |
|---|---|---|
| `pending`, number known (in the record or in plugin state) | `done` | The create demonstrably succeeded; only the closing write was lost |
| `pending`, no number, started under 2 minutes ago | unchanged | Could still be in flight |
| `pending`, no number, older than that | `uncertain` | Logged once, and never attempted again |

`uncertain` is terminal on purpose. The issue may or may not exist on GitHub, and finding
out would mean reading GitHub back — which this plugin does not do, at all, by design. So
it records the ambiguity where a human can see it instead of guessing. That trades a silent
duplicate for a task that is visibly not mirrored, which is the lesser of the two.

The outbox lives in `ctx.entities` rather than `ctx.state` because entities can be
enumerated. Plugin state cannot: the host's state store has a `list`, but it is not exposed
over the worker→host RPC, so a queue kept there could never find its own pending work.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test      # offline: the suite stubs ctx.http.fetch
pnpm build     # esbuild presets from @paperclipai/plugin-sdk/bundlers
pnpm dev       # watch builds
```

Note: the SDK test harness performs a **real** network fetch by default, so the tests
replace `ctx.http.fetch` with a recording stub to stay offline.

Worker-only plugin — no UI surface is declared or built.

## Install into Paperclip

```bash
paperclipai plugin install packages/plugins/paperclip-plugin-github-mirror
```
