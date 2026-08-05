# Run completion check

Catches the run that ends without finishing its task and without saying it could not. The task is
parked as `blocked`, labelled for a human, and given an unblock action — instead of the board
quietly claiming work that nobody stands behind.

## The failure it exists for

A reviewer agent merged a pull request, failed to update the board, and said so in its final
message. The board went on showing the task as active for hours. Nothing was broken, no error was
logged, no run failed: the work was done and the record was wrong, which is the one state that
looks exactly like progress.

Both halves matter. A run that fails is visible. A run that succeeds and records nothing is not.

## The rule

On `agent.run.finished`, a task is parked when **all** of these hold:

| Condition | Why |
|---|---|
| the run named an issue | `payload.issueId`; a run without one has no task to judge |
| the run reported a start time | without a window there is nothing to compare, and guessing would park tasks on no evidence |
| the task is not `done` or `cancelled` | finished work is finished |
| the task is not already `blocked` | somebody — an agent, escalation, a human — already parked it |
| the task does not already carry the label | idempotence, for the moment two runs end together |
| the task has not changed since before the run began | **this is the actual test** |

Comments and documents deliberately do not count as "changed". That is not an oversight: the
core's own agent contract calls them "evidence, not valid liveness paths by themselves", and a run
that only commented is precisely the case this catches.

> **The event is `agent.run.finished`.** There is no `agent.run.succeeded` — the core maps a
> succeeded run to `finished` (see `server/src/services/heartbeat.ts`). A plugin subscribed to the
> wrong name never fires and never complains, which has already cost this project a week once.
> `entityId` is the **run**; the issue is in `payload.issueId`.

## What it does

One write, not three:

```
status:              blocked
labelIds:            <existing> + human-review
unblockDescriptor:   { owner: {userId} | "board", action: "..." }
```

The label is what separates the two kinds of `blocked`: one where an agent named a real blocker,
and one where this check caught a silent stop. Then a comment explaining the run window, and a
`run-ended-unfinished` event for other plugins — the GitHub mirror listens and surfaces it there;
this plugin knows nothing about GitHub.

Status, label and descriptor land in a single update on purpose. Two runs can finish in the same
moment, and the status is what the second one reads to stand down.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `completionCheckEnabled` | `true` | Off switch |
| `humanReviewLabelId` | — | Id of the `human-review` label. Create it on the board, then `GET /api/companies/<id>/labels` to read the id. Empty: the task is still parked, it just carries no label |
| `unblockOwnerUserId` | — | Recorded as the unblock owner. Empty: the owner is `board`, meaning anyone |

## Tests

```bash
pnpm test        # 16, offline — no board, no network
pnpm typecheck
```

The rule lives in `src/detect.ts` as a pure function returning a named reason for every decision,
so "why did it do nothing" is answerable without a debugger.
