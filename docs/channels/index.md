# Agent and channels

Sessions are per-task: one workspace, one job, its own conversation. The **agent**
is the opposite — a single long-lived pi session rooted at a fixed directory,
`agentHome`, that you talk to continuously.

A **channel** is a two-way link into that agent. Messages arrive through it and
the agent's replies go back out the same way. Every channel points at the same
session, so they are different doors into one conversation rather than separate
agents with separate memories. Message it from Telegram on the way to work,
follow up over a webhook from a cron job, and it is the same thread.

```
Telegram ─┐
Webhook  ─┼──▶  agent session (agentHome)  ──▶  replies back out the same door
your own ─┘
```

## Channel types are packages

Nothing about Telegram is hardcoded. A channel type is a package with a
manifest and a `start()`, and the ones that ship in the repo are ordinary
examples of the format rather than privileged cases. Install another from a
GitHub repo and it behaves identically.

Four ship in the repo, between them covering every shape a transport takes:

| Package | Shape | Notes |
| --- | --- | --- |
| `pithagoras-channel-telegram` | Long polling | Outbound only. The Bot API has no socket — see below. |
| `pithagoras-channel-slack` | WebSocket | Socket Mode, which exists so an app needs no public URL. |
| `pithagoras-channel-discord` | WebSocket | The Gateway, with the heartbeat it demands. |
| `pithagoras-channel-webhook` | A listener | POST a message, the reply comes back in the response. |

None of them needs a dependency: `fetch` and `WebSocket` are both globals on
Node 22, which the portal requires anyway.

::: tip Why Telegram polls and the others do not
Telegram's Bot API offers two delivery modes — `getUpdates`, or a webhook it
POSTs to. There is no Socket Mode equivalent. Since the portal is meant to run
somewhere with no inbound route, polling is what is left.

It is *long* polling, though: the request parks on Telegram's servers for up to
50 seconds and returns the instant a message arrives. One mostly-idle held
connection, not a request every second — close enough to a socket that you will
not notice.
:::

Builtins ship inside the image and cannot be uninstalled. Everything else
installs to `CHANNELS_DIR` on the data volume and survives image rebuilds.

## Setting one up

Settings → Channels.

1. **Install a package**, if you need a type that is not already there. Any spec
   npm understands: `user/repo`, `github:user/repo#v2`, a git URL, an npm name.
2. **Add a channel** of that type and fill in its fields. Required fields are
   enforced server-side.
3. **Enable it** with the toggle.

Secret fields are write-only from the browser's side. The stored value is never
sent back — the UI is told only that one exists — and saving a blank secret
keeps what is stored, so editing an unrelated field cannot wipe a token you
cannot see.

A package that fails to load is listed with its error rather than disappearing,
and two packages claiming the same channel id are rejected at load time instead
of one silently shadowing the other.

## What does not work yet

::: warning No runtime
The loader, the installer, validation, storage and the settings UI are all real.
The thing that calls `start()` is not — it needs the agent session, which does
not exist yet.

Channels report **not connected**. Nothing arrives, nothing is sent. The
`start()` implementations in the builtin packages are written against the
contract below and have never been executed.
:::

When the runtime lands it will own the agent session and pass each channel an
`ask()` that prompts it and resolves with the reply. The contract in
[Writing a channel](/channels/writing-a-channel) is what it will call, so a
package written now will work then.
