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
manifest and a `start()`, and the two that ship in the repo are ordinary
examples of the format rather than privileged cases. Install another from a
GitHub repo and it behaves identically.

The builtins are chosen to demonstrate both shapes:

| Package | Shape |
| --- | --- |
| `pithagoras-channel-telegram` | Long polling — outbound only, so it works behind Tailscale with no inbound route |
| `pithagoras-channel-webhook` | A listener — POST a message, the reply comes back in the response |

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
