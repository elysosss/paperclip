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
processing events. Every handler is wrapped: failures are logged with a `retryable` flag
(429, rate-limited 403, and 5xx are retryable; other 4xx are not) and the worker keeps
running.

Mirroring is idempotent — the GitHub issue number is stored in plugin state, so repeated
events never create duplicates.

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
