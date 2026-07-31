# Escalation

Stops implementer/reviewer ping-pong. After a configurable number of reviewer returns, a task
is parked for a human instead of being handed back to the agents again.

## Why two counters

| Counter | Trigger | Escalates? |
|---|---|---|
| **A — gate failures** | `agent.run.failed` | No |
| **B — reviewer returns** | status goes `in_review` → `in_progress` | Yes, at the threshold |

A failing test is objective: the fix is known, and retrying is the right move. A reviewer
sending work back repeatedly is a judgement call, and after a few rounds it usually means a
disagreement about the spec that another automated round will not settle — it will just burn
quota. So only counter B escalates; counter A is recorded for context.

## What happens on escalation

1. The task is set to `blocked` — Paperclip has no dedicated "needs human" status, and
   `blocked` already means "parked, waiting on someone".
2. A comment is posted explaining the counts and what to do next.
3. A `escalation-raised` event is emitted for other plugins. The GitHub mirror listens for it
   and surfaces the escalation there; this plugin knows nothing about GitHub.

Escalation happens once per task. Reaching a terminal state (`done`, `cancelled`) clears the
counters, so a reopened task starts fresh.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `reviewReturnThreshold` | `3` | Reviewer returns allowed before escalating |
| `escalationEnabled` | `true` | Turn escalation off without uninstalling |

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Worker-only plugin — no UI surface is declared or built.
