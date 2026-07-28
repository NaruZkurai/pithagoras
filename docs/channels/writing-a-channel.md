# Writing a channel

A channel package is a normal npm package with a marker, a manifest, and a
`start()` that owns its transport. Publish it to a GitHub repo and it installs
straight into the portal.

The two packages in the repo's `channels/` directory are reference
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
| `ask(text, meta)` | Send to the agent; resolves with its reply. |
| `log(message)` | Surfaced in the channel's status. |
| `signal` | `AbortSignal`, aborted when the channel is disabled or the portal shuts down. |

`ask` is the entire interface to the agent. `meta` is free-form and travels with
the message so you can route the reply back where it came from.

```js
const reply = await ctx.ask("Deploy the staging branch", { from: "telegram:12345" });
await sendBack(reply);
```

Honour `ctx.signal`. A polling loop should check `signal.aborted` and pass the
signal to `fetch`, or disabling the channel will leave it running.

## Two shapes

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
- **`start()` is not called yet.** See [the note](/channels/#what-does-not-work-yet).
  Write against this contract; it is what the runtime will use.
