# Writing a channel

A channel package is a normal npm package with a marker, a manifest, and a
`start()` that owns its transport. Publish it to a GitHub repo and it installs
straight into the portal.

The four packages in the repo's `channels/` directory are reference
implementations of exactly this format — read them alongside this page.

## Layout

```
my-channel/
  package.json
  index.js
```

### package.json

The marker is what the loader looks for. Without it the package is ignored, so
an ordinary dependency in the same directory is never mistaken for a channel.

```json
{
  "name": "pithagoras-channel-my-thing",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "pithagoras": { "channel": true }
}
```

A name starting `pithagoras-channel-` also counts, but the explicit marker is
clearer.

### index.js

```js
export const manifest = {
  id: "my-thing",
  label: "My Thing",
  blurb: "One line shown under the name in settings.",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "room", label: "Room", hint: "Optional" },
  ],
};

export async function start(ctx) {
  // set up your transport here
  return {
    async stop() {
      // release whatever start() acquired
    },
  };
}
```

## The manifest

| Key | Meaning |
| --- | --- |
| `id` | Unique across all loaded packages. A clash is rejected at load time. |
| `label` | Shown in settings. |
| `blurb` | One line under the name. |
| `fields` | Generates the configuration form. |

Validation is strict and the error is surfaced in the UI, so a typo shows up as
a red row naming your package rather than a channel that silently never appears.

### Fields

| Key | Meaning |
| --- | --- |
| `key` | Property name in `ctx.config`. Must be a valid identifier. |
| `label` | Shown above the input. |
| `secret` | Stored server-side, never sent to the browser. |
| `required` | The channel cannot be saved without it. |
| `hint` | Small print under the input. |
| `placeholder` | Placeholder text. |

Mark anything credential-shaped as `secret`. The browser is told only whether a
value is set, and a blank secret on save means "keep the stored one" — so a user
editing an unrelated field cannot wipe your token.

## start(ctx)

Called once when the channel is enabled. Return an object with `stop()`.

| `ctx` | |
| --- | --- |
| `config` | The configured values, secrets included. |
| `ask(text, meta)` | Send to the agent; resolves with its reply. `meta.session` is required. |
| `log(message)` | Surfaced in the channel's status. |
| `signal` | `AbortSignal`, aborted when the channel is disabled or the portal shuts down. |

`ask` is the entire interface to the agent.

### The session key

**`meta.session` is required, and picking it well is your main design decision.**

Each distinct key gets its own session — its own conversation, its own memory.
Your job is to decide what counts as one conversation on your platform; the
portal turns each key into an isolated session and keeps them apart.

```js
const reply = await ctx.ask(text, {
  session: `chat:${chatId}`,   // one conversation
  title: "Engineering",        // human label, used the first time only
  chatId,                      // anything else you need to route the reply
});
```

Get it wrong in one direction and a group chat and your DM share a memory; get
it wrong in the other and the agent forgets everything between messages. What
the builtins settled on:

| Package | Key | Why |
| --- | --- | --- |
| Telegram | `chat:<chat id>` | A DM and a group have different chat ids, so they separate for free. |
| Slack | `channel:<channel>` | Per channel, not per thread — a thread is a digression inside one conversation. |
| Discord | `channel:<channel id>` | A DM is a channel too, so servers and DMs separate for free. |
| Webhook | whatever the caller sends, else `default` | Only the caller knows what a conversation is. |

Your key is prefixed with the channel's slug before it is stored, so two
channels both choosing `general` stay separate without either knowing about the
other. Slugs are stable across a channel being deleted and recreated, which ids
are not — see [the note](/channels/#one-session-per-conversation).

Anything else in `meta` is yours — it travels with the message so you can route
the reply back where it came from.

Honour `ctx.signal`. A polling loop should check `signal.aborted` and pass the
signal to `fetch`, or disabling the channel will leave it running.

You do not handle the channel's [instructions](/channels/#per-channel-instructions).
They are configured in the portal and attached on its side of `ask()`, so your
package gets the feature without doing anything.

## Three shapes

**Polling**, from the Telegram package. Outbound only, which is what makes it
work on a machine with no inbound route:

```js
while (running && !ctx.signal.aborted) {
  const updates = await getUpdates({ offset, timeout: 50 }, ctx.signal);
  for (const update of updates) {
    const reply = await ctx.ask(update.text, { chatId: update.chatId });
    await send(update.chatId, reply);
  }
}
```

**A socket**, from the Slack and Discord packages. `WebSocket` is a global on
Node 22, so this needs no dependency either. Reconnect on close unless you are
being stopped, and honour whatever keepalive the service demands — Discord drops
a connection that misses its heartbeats:

```js
const connect = () => {
  if (stopped || ctx.signal.aborted) return;
  const socket = new WebSocket(url);
  socket.addEventListener("message", async (frame) => {
    const { text, channel } = parse(frame.data);
    await send(channel, await ctx.ask(text, { channel }));
  });
  socket.addEventListener("close", () => {
    if (!stopped && !ctx.signal.aborted) setTimeout(connect, 3000);
  });
};
```

**Listening**, from the webhook package. Needs a reachable port, and you should
authenticate every request:

```js
const server = createServer(async (req, res) => {
  if (!validSecret(req)) return unauthorized(res);
  const { message } = JSON.parse(await readBody(req));
  const reply = await ctx.ask(message, { from: "webhook" });
  res.end(JSON.stringify({ reply }));
});
```

## Installing yours

Push it to GitHub, then from Settings → Channels:

```
user/repo
```

Or via the API:

```bash
curl -X POST http://portal:4100/api/channel-packages \
  -H 'content-type: application/json' \
  -d '{"spec":"user/repo"}'
```

Anything npm understands works: `user/repo`, `github:user/repo#v2`, a git URL,
an https tarball, or a published npm name. The loader picks it up immediately —
a reinstall of the same version is cache-busted, so you do not need a restart to
see a change.

## Things to know

- **Dependencies work.** `npm install` runs normally, so a package that needs a
  library gets one. Keep it light — it loads in the portal's process.
- **Ids must be unique.** Two packages claiming `telegram` and the second is
  rejected, named in the UI.
- **Uninstalling keeps configured channels.** Removing a package does not
  discard credentials; those channels report the missing package until it is
  reinstalled or deleted.
- **A key is mandatory.** `ask` without `meta.session` throws rather than
  quietly lumping everything into one conversation.
- **`start()` is not called yet.** See [the note](/channels/#what-does-not-work-yet).
  Write against this contract; it is what the runtime will use.
