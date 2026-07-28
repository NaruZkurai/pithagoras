# Channel packages

A channel is a two-way link into the agent: messages arrive through it, and the
agent's replies go back out the same way. Every channel talks to the same
agent session, so they are different doors into one conversation.

Channels are packages. The ones in this directory are loaded by default; any
other package following this convention can be installed from npm, a git URL or
a GitHub repo, and is treated identically — there is nothing special about the
builtins beyond where they happen to live.

## Installing a third-party channel

From the Channels tab in settings, or:

```
POST /api/channel-packages  { "spec": "user/repo" }
```

`spec` is anything npm understands — `user/repo`, `github:user/repo#v2`,
`https://github.com/user/repo`, a git URL, or an npm package name. Packages are
installed under `CHANNELS_DIR` (default `/data/channels`) and survive restarts.

## What a package looks like

```
my-channel/
  package.json
  index.js
```

`package.json` must carry the marker, or the loader will not consider it:

```json
{
  "name": "pithagoras-channel-my-thing",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "pithagoras": { "channel": true }
}
```

`index.js` exports a manifest and a `start` function:

```js
export const manifest = {
  id: "my-thing",              // unique; collides are rejected at load time
  label: "My Thing",
  blurb: "One line shown under the name in settings.",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "room",   label: "Room",    hint: "Optional" },
  ],
};

export async function start(ctx) {
  // ctx.config   — the configured field values, secrets included
  // ctx.ask      — (text, meta) => Promise<string>; sends to the agent,
  //                resolves with its reply
  // ctx.log      — (message) => void; surfaced in the channel's status
  // ctx.signal   — AbortSignal, aborted when the channel is disabled or the
  //                portal shuts down
  //
  // Do your own transport here: poll, open a socket, whatever fits.

  return {
    async stop() {
      // release anything start() acquired
    },
  };
}
```

### Fields

Each entry generates one input in settings.

| key         | meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `key`       | property name in `ctx.config`                                    |
| `label`     | shown above the input                                            |
| `secret`    | stored server-side and never sent to the browser                 |
| `required`  | refuses to save the channel without it                           |
| `hint`      | small print under the input                                      |
| `placeholder` | placeholder text                                               |

A `secret` field is write-only from the browser's point of view: the UI is told
only whether a value is set, and saving a blank one keeps what is stored, so
editing an unrelated field cannot wipe a token.

### Talking to the agent

`ctx.ask(text, meta)` is the whole interface. `meta` is free-form and travels
with the message so a reply can be routed back — for Telegram that is the chat
id, for a webhook it is the request. The promise resolves with the agent's
reply text.

```js
const reply = await ctx.ask("Deploy the staging branch", { from: "telegram:12345" });
await sendBack(reply);
```

## Status

The loader, the installer and the settings UI are in place. The runtime that
calls `start()` is not — it needs the agent session, which does not exist yet,
so `start()` is currently defined but never invoked and channels report
"not connected". Write against this contract now; it is what the runtime will
call.
