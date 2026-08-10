# Telegram notify

Pushes the few board events that actually need a human to Telegram. Outbound only: no webhook, no
inbound endpoint, no commands, no buttons. Phase 1 of
[`docs/telegram-spec.md`](https://github.com/elysosss/agent-company-kit/blob/main/docs/telegram-spec.md)
in the kit, and nothing beyond it.

## Why a plugin and not a bot process

The seam already existed. The escalation plugin emits a decision; the GitHub mirror renders it;
neither knows about the other. This makes Telegram the third consumer of the same bus, which is
the evidence that the plugin-per-surface split was worth having.

Four things come free that a standalone bot would have to reimplement: out-of-process isolation
(a wedged send cannot take the board down), `secret_ref` token handling (resolved per call, never
cached or logged), the mirror's failure discipline (every handler wrapped, failures logged with a
`retryable` flag, nothing propagated), and supervision by the same service.

## What it sends

| Event | Message | Why it earns a push |
|---|---|---|
| `escalation-raised` | **Needs a human** — task key, why, board link | The one event that means a human is required |
| `agent.run.failed` | **Run failed** — agent, run id, truncated error | A failed run still spends the day's cap, so this means today is over, not that it will retry |
| `budget.incident.opened` / `.resolved` | **Budget stopped work** / resolved | Money stopped, or restarted |
| `issue.updated` → `blocked` | **Waiting for you** — task key and the unblock action | A task became somebody's to decide |
| `issue.interaction.created` | **Waiting for you** — task key and what kind of answer is wanted | An agent asked a person directly and stopped |

The spec allowed three and said a fourth needs an argument. The argument for the fourth: every
loop in this kit that produces work for the owner terminates in a parked task — the completion
check parks an abandoned one, a reviewer that will not merge parks a finished one. Without this
message, the output of an overnight run is invisible until somebody opens the board, which is the
exact failure the notifier exists to prevent. It is a filter on an event that already exists, and
it can be switched off on its own.

**It watches the board state, not the completion check's event.** Subscribing to
`run-ended-unfinished` was the first design and it was wrong: that event only fires for a run that
*abandoned* a task, so every deliberate hand-off — a reviewer agent finishing its work and
refusing to merge — would have gone unannounced, and those are most of them. The rule is now the
transition into `blocked`, whoever caused it. Only the transition sends: an edit to a task that
was already parked is the board being edited, not news.

The message leads with the `unblockDescriptor.action` when there is one. "Merge or close PR #14"
is something you can act on from a phone; "blocked" is not. When the unblock owner is a named
user it says **Waiting for you**; when it is `board` — meaning anyone — it says **Task parked**.

**Watching the board state alone was still not enough.** An agent that wants a person to decide
something cannot park the task and name that person as the unblock owner: the board answers
`403 Agents may only name themselves as an unblock owner`. What it does instead is open an
issue-thread interaction — a confirmation, a question, a list of verdicts — and stop. The task's
status never moves, so the transition above never fires, and that hand-off reached no surface at
all ([kit #13](https://github.com/elysosss/agent-company-kit/issues/13)). `issue.interaction.created`
is the second path to the same message. Only interactions with no `addresseeAgentId` count: one
addressed to an agent is answered by the agent loop and is nobody's business on a phone. The
message names the interaction *kind*, not the question — the question stays on the board.

**One hand-off sends one message.** A task can produce both signals — an agent opens an
interaction, then somebody parks the task because of it — and they are the same event. Both paths
claim a single per-issue slot in plugin state before sending, and only the signal that claimed it
releases it: the board path when the task leaves `blocked`, the interaction path on
`issue.interaction.resolved`. A partial verdict submission resolves some items and leaves the
interaction pending; the slot stays held, because nobody is off the hook yet.

**The escalation event is plugin-to-plugin, and its name is namespaced**:
`plugin.paperclip-plugin-escalation.escalation-raised`. The emitter passes the bare name; every
subscriber must use the prefixed one. Subscribing to the bare name compiles, runs, and silently
receives nothing for ever.

## What it deliberately does not send

- **Task content.** Messages carry identifiers and links only. This is the one part of the kit
  that leaves the machine, and a task key is not the diff.
- **Runs remaining today**, which the spec asked for in the failure message. The daily cap lives
  in the agent's heartbeat config and the day's run count is on no read the plugin SDK exposes.
  A guessed number would be acted on, so the message says to check the board instead. If the SDK
  grows an agent-runtime read, this is the first thing to add.
- **A board link**, unless one is configured. The board answers on a LAN address that means
  nothing from a phone outside the house, and a dead link is worse than none.

## The security boundary

A Telegram bot is an open surface — anyone who learns its username can message it. There is no
login. So the entire authorisation model is one list:

> An allowlist of numeric chat ids, in configuration, checked before every send.

- **Empty allowlist means notify nobody.** Not "notify everyone", not "fall back to a default".
  `parseConfig` returns `null` and the handler returns. This is a test, not a convention.
- Malformed ids are dropped rather than coerced. All of them malformed is the same as none.
- The token is a `secret_ref`, resolved per call. Anyone holding it reads every notification ever
  sent.
- One chat rejecting the bot (403, blocked) must not silence the others, so each send is guarded
  on its own.

When this grows a `getUpdates` loop in phase 2, the same list has to be checked on **every**
update and on **every** `callback_data` — a button is a message the client sends later, and a
forwarded message carries its buttons. Checking at `/start` and trusting afterwards is not a
check.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `token` | — | Bot token from @BotFather, as a secret ref |
| `allowedChatIds` | `[]` | Numeric chat ids. **Empty means silent** |
| `boardBaseUrl` | — | Optional. Prefixes task links; must be absolute `http(s)` |
| `notifyEnabled` | `true` | Off switch for everything |
| `notifyEscalation` / `notifyRunFailed` / `notifyBudget` / `notifyWaitingForHuman` | `true` | Per-message switches |

To find your chat id: message the bot, then `curl https://api.telegram.org/bot<TOKEN>/getUpdates`
and read `result[].message.chat.id`. This is the only time the plugin's own token is used against
`getUpdates` — the plugin itself never polls.

## Failure handling

Every handler is wrapped. A send that fails logs the status and a `retryable` flag: 429 and 5xx
are Telegram asking for time (with `retry_after` when it says so), 400 and 403 are us — a bad
chat id, a blocked bot, malformed HTML — and retrying those repeats the same failure. Nothing is
retried in-process yet; a failed notification is lost and logged, which is the honest state of it.

Every send has a 10-second deadline. A hung connection to Telegram must not hold a handler open
for ever — that is the mirror's open bug ([kit #11](https://github.com/elysosss/agent-company-kit/issues/11))
and there was no reason to reproduce it here.

Replay is handled for the parked-task message: the last seen status per issue is kept in plugin
state, so a re-delivered `issue.updated` does not buzz the phone twice. The same state holds the
hand-off slot described above, which also makes a re-delivered `issue.interaction.created`
harmless.

## Tests

```bash
pnpm test        # 48, offline — no board, no network, fetch stubbed
pnpm typecheck
```

The allowlist, the config parsing and every message renderer are pure functions, so the whole
"what does the phone actually say" surface is asserted without a network.
