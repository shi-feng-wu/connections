// Bot DM to a player when the dev replies to their feedback ticket (api/chat.ts). Delivers the
// full reply plus the message it answers, so the player reads it in Discord without reopening the
// activity — the in-app inbox (chat_threads/chat_messages) is still the system of record, and its
// unread badge is the guaranteed fallback whenever this DM can't land. Two bot-token calls: open
// the 1:1 DM channel, then post into it. Best-effort: a player who shares no server with the bot
// (user-install, no mutual guild) or who blocks DMs from non-friends returns 403 — we swallow it.
// Never throws into the request: the reply is already persisted by the time we get here. Leading
// underscore keeps Vercel from treating this file as a route.
//
// The wording lives in src/discord-copy.md → reply-dm.* and the card layout (a Components V2
// container, like /share) in src/discord-messages.ts replyDm() — shared with the offline preview
// (#messages), so what you preview is what the bot sends. This file is only the transport:
// resolve the icon base URL, open the DM channel, post.

import { replyDm } from '../src/discord-messages.js';

const API = 'https://discord.com/api/v10';

export type ReplyDM = {
  recipientId: string; // the player's Discord user id (chat_threads.user_id)
  subject: string | null; // the ticket title, heading the card
  replyText: string; // the dev's full reply
  contextText: string | null; // the player message this reply answers (quoted below it)
};

// Open (or reuse) the 1:1 DM channel with a user. Returns the channel id, or null when Discord
// won't let the bot DM them (no mutual guild / DMs closed → 403) or on any error.
async function openDmChannel(recipientId: string, botToken: string): Promise<string | null> {
  try {
    const r = await fetch(`${API}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: recipientId }),
    });
    if (!r.ok) return null;
    const c = (await r.json()) as { id?: string };
    return typeof c.id === 'string' ? c.id : null;
  } catch {
    return null;
  }
}

// DM the player a dev reply. Returns whether the message landed.
export async function sendReplyDM(dm: ReplyDM): Promise<boolean> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return false;
  if (!dm.replyText.trim() || !dm.recipientId) return false;

  const channelId = await openDmChannel(dm.recipientId, botToken);
  if (!channelId) return false;

  const card = replyDm({
    subject: dm.subject,
    replyText: dm.replyText,
    contextText: dm.contextText,
  });

  try {
    const r = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // A Components V2 card (flags + components; no content/embeds allowed). Card text never
        // pings, but deny all mentions anyway for safety.
        ...card,
        allowed_mentions: { parse: [] },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
