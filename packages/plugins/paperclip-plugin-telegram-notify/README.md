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
| `run-ended-unfinished` | **Waiting for you** — task key, what to do | The completion check parked a task |

The spec allowed three and said a fourth needs an argument. The argument for the fourth: every
loop in this kit that produces work for the owner terminates in a parked task — the completion
check parks an abandoned one, a reviewer that will not merge parks a finished one. Without this
message, the output of an overnight run is invisible until somebody opens the board, which is the
exact failure the notifier exists to prevent. It is a filter on an event that already exists, and
it can be switched off on its own.

**Two events are plugin-to-plugin and their names are namespaced**:
`plugin.paperclip-plugin-escalation.escalation-raised` and
`plugin.paperclip-plugin-run-completion.run-ended-unfinished`. The emitter passes the bare name;
every subscriber must use the prefixed one. Subscribing to the bare name compiles, runs, and
silently receives nothing for ever.

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

Replay is handled for the parked-task message: the last run id per issue is kept in plugin state,
so a re-delivered event does not buzz the phone twice.

## Tests

```bash
pnpm test        # 30, offline — no board, no network, fetch stubbed
pnpm typecheck
```

The allowlist, the config parsing and every message renderer are pure functions, so the whole
"what does the phone actually say" surface is asserted without a network.
