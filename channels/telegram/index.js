/**
 * Telegram, over long polling.
 *
 * Polling rather than webhooks on purpose: the portal is meant to run on a box
 * behind Tailscale with no inbound route from the internet, and getUpdates
 * needs only outbound HTTPS.
 */

export const manifest = {
  id: "telegram",
  label: "Telegram",
  blurb: "Message a bot; its replies come back in the same chat.",
  fields: [
    {
      key: "botToken",
      label: "Bot token",
      secret: true,
      required: true,
      hint: "From @BotFather",
      placeholder: "123456:ABC-DEF…",
    },
    {
      key: "allowedChatIds",
      label: "Allowed chat IDs",
      hint: "Comma separated. Leave empty and anyone who finds the bot can drive your agent.",
      placeholder: "12345678, -100987654321",
    },
  ],
};

const API = "https://api.telegram.org/bot";

async function call(token, method, body, signal) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `${method} failed`);
  return data.result;
}

export async function start(ctx) {
  const token = ctx.config.botToken;
  const allowed = String(ctx.config.allowedChatIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const me = await call(token, "getMe", {}, ctx.signal);
  ctx.log(`connected as @${me.username}`);
  if (!allowed.length) {
    ctx.log("no chat id restriction — anyone who finds this bot can drive the agent");
  }

  let offset = 0;
  let running = true;

  const loop = (async () => {
    while (running && !ctx.signal.aborted) {
      let updates;
      try {
        // Long poll: the request parks server-side until something arrives.
        updates = await call(
          token,
          "getUpdates",
          { offset, timeout: 50, allowed_updates: ["message"] },
          ctx.signal
        );
      } catch (e) {
        if (ctx.signal.aborted) break;
        ctx.log(`poll failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        const text = message?.text?.trim();
        if (!text) continue;

        const chatId = String(message.chat.id);
        if (allowed.length && !allowed.includes(chatId)) {
          ctx.log(`ignored a message from ${chatId}`);
          continue;
        }

        // Deliberately not awaited. A command that opens a menu blocks until
        // somebody answers it — and the answer is the next message, which this
        // loop has to keep polling to receive. Awaiting here meant the reply
        // could never arrive and the chat hung until the dialog timed out.
        //
        // Ordering is safe: the portal serialises messages per conversation,
        // and an answer to an open question jumps that queue.
        void handle(message, text, chatId);
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await loop.catch(() => {});
    },

    /**
     * Send without being asked — how a routine reports back.
     *
     * The target is the same conversation key handed to ctx.ask, so a
     * destination is picked from conversations that already exist rather than
     * by finding a chat id somewhere.
     */
    async send(target, text) {
      const chatId = String(target).replace(/^chat:/, "");
      for (const chunk of split(text, 4000)) {
        await call(token, "sendMessage", { chat_id: chatId, text: chunk }, ctx.signal);
      }
    },
  };

  async function handle(message, text, chatId) {
    const say = async (body) => {
      // Telegram rejects anything over 4096 characters outright.
      for (const chunk of split(body, 4000)) {
        await call(token, "sendMessage", { chat_id: chatId, text: chunk }, ctx.signal);
      }
    };

    try {
      await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, ctx.signal);
      // The chat id is the conversation: a DM and a group have different ones,
      // so each gets its own session without any special casing. onReply
      // relays what the agent says between tool calls, and any question an
      // extension asks along the way.
      const reply = await ctx.ask(text, {
        session: `chat:${chatId}`,
        title: chatTitle(message.chat),
        chatId,
        // The conversation is the chat; the sender is the person. In a group
        // those differ every message, and only the id is theirs to prove — a
        // display name is whatever they set it to this morning.
        from: message.from
          ? { id: String(message.from.id), name: personName(message.from) }
          : null,
        onReply: say,
      });
      // Non-empty only when the portal was not relaying as it went.
      if (reply) await say(reply);
    } catch (e) {
      ctx.log(`failed to answer ${chatId}: ${e.message}`);
      await say(`Something went wrong: ${e.message}`).catch(() => {});
    }
  }
}

/** Their name if they have one, their handle if not. */
function personName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || (user.username ? `@${user.username}` : `Telegram ${user.id}`);
}

/** Something recognisable in the session list rather than a bare number. */
function chatTitle(chat) {
  if (chat.title) return chat.title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  return name || (chat.username ? `@${chat.username}` : `Chat ${chat.id}`);
}

function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}
