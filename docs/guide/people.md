# People

The agent can talk to your team without treating everyone as its owner.

Settings → **People** is the roster: everyone who has ever messaged a channel,
including the ones the agent turned away — that is what the list is for.

## Who someone is

Identity comes from the platform's own id — a Telegram user id, a Slack user id
— scoped by channel, so `telegram:5544570917` and `slack:U04AB` never collide.
Never from a display name, which is whatever the sender set it to this morning.

Note the difference between a **conversation** and a **person**. A group chat is
one conversation with many senders. The portal tracks both, because capability
follows the person while context follows the conversation.

## Roles

| Role | Can |
| --- | --- |
| **Primary** | Everything. You. |
| **Colleague** | Read, search, explain. No commands, edits, pushes or scheduling. |
| **Guest** | Answers what they ask, volunteers nothing. |
| **Blocked** | Never reaches the agent. |

A sender nobody has classified is refused *before a session exists*, so there is
nothing for them to talk the agent into, and you get one message telling you
they turned up. One message, not one per attempt.

::: tip The gate opens itself until you name a primary
With nobody marked primary, the portal has no basis for deciding who is a
stranger, so it lets everyone through and just records them. Name yourself
primary and the gate closes. This is also why enabling this on an existing
deployment does not lock you out of your own agent.
:::

## What a colleague cannot do

An allowlist — `read`, `grep`, `find`, `ls` — enforced per tool call rather than
fixed when the session starts. That matters in a group: the sender changes
between messages, and a launch-time allowlist would freeze capability to
whoever happened to speak first.

Refusals are enforced, not requested. The agent usually declines before even
reaching for a tool, because it is told who it is speaking to; if it tries
anyway — talked round, or fed a convincing story — the call is blocked and it is
told to say so rather than look for another route.

## What they can see

Context files split at the same boundary:

| File | Loaded for |
| --- | --- |
| `SOUL.md` | Everyone — it is who the agent is |
| `TEAM.md` | Everyone — the shared half |
| `PrimaryUser.md` | You only |
| `MEMORY.md` | You only |

A conversation takes the **lowest** role it has ever served and never recovers.
A group where a guest once spoke keeps serving guest-level context even when the
next message is yours — the alternative is a conversation that quietly widens
what it knows partway through.

Because the running process has already loaded its context, a conversation being
downgraded restarts it before the next turn rather than after.

## Impersonation

Trust here is exactly as good as the platform's identity. A Telegram or Slack id
is solid. A webhook's `from` field is not — the secret authenticates the caller,
not the person it claims to speak for, so anything holding that secret can say
it is anyone. Give the secret out accordingly.
