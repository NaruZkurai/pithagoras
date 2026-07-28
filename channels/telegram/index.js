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

        try {
          await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, ctx.signal);
          // The chat id is the conversation: a DM and a group have different
          // ones, so each gets its own session without any special casing.
          const say = async (body) => {
            // Telegram rejects anything over 4096 characters outright.
            for (const chunk of split(body, 4000)) {
              await call(token, "sendMessage", { chat_id: chatId, text: chunk }, ctx.signal);
            }
          };
          // onReply relays what the agent says between tool calls, so a long
          // task shows progress instead of going silent for minutes.
          await ctx.ask(text, {
            session: `chat:${chatId}`,
            title: chatTitle(message.chat),
            chatId,
            onReply: say,
          });
        } catch (e) {
          ctx.log(`failed to answer ${chatId}: ${e.message}`);
          await call(token, "sendMessage", {
            chat_id: chatId,
            text: `Something went wrong: ${e.message}`,
          }).catch(() => {});
        }
      }
    }
  })();

  return {
    async stop() {
      running = false;
      await loop.catch(() => {});
    },
  };
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
