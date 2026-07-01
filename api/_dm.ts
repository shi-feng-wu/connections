// Bot DM to a player when the dev replies to their feedback ticket (api/chat.ts). Delivers the
// full reply plus the message it answers, so the player reads it in Discord without reopening the
// activity — the in-app inbox (chat_threads/chat_messages) is still the system of record, and its
// unread badge is the guaranteed fallback whenever this DM can't land. Two bot-token calls: open
// the 1:1 DM channel, then post into it. Best-effort: a player who shares no server with the bot
// (user-install, no mutual guild) or who blocks DMs from non-friends returns 403 — we swallow it.
// Never throws into the request: the reply is already persisted by the time we get here. Leading
// underscore keeps Vercel from treating this file as a route.
//
// The wording (heading / subject prefix / footer) lives in src/discord-copy.md → reply-dm.* like
// every other message the bot posts; edit it there and run `npm run gen:copy`. Only the layout
// (quote the player's note above the reply) is here — the player's note and the reply are data.

import { COPY } from '../src/discord-copy.js';
import { fill } from '../src/copy-util.js';

const API = 'https://discord.com/api/v10';

const MAX_REPLY = 2000; // matches the chat message cap (insertMessage already slices to this)
const MAX_CONTEXT = 600; // the quoted "what you wrote" snippet — enough to anchor the reply
const REPLY_COLOR = 0x7fc8a9; // KEEP IN SYNC with api/_feedback.ts REPLY_COLOR (the webhook hue)

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Prefix every line so a multi-line player message renders as one Discord blockquote — a single
// "> " quotes only its own line.
function blockquote(s: string): string {
  return s
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

export type ReplyDM = {
  recipientId: string; // the player's Discord user id (chat_threads.user_id)
  subject: string | null; // the ticket title, for the embed header
  replyText: string; // the dev's full reply
  contextText: string | null; // the player message this reply answers (quoted above it)
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
  const reply = truncate(dm.replyText, MAX_REPLY);
  if (!reply || !dm.recipientId) return false;

  const channelId = await openDmChannel(dm.recipientId, botToken);
  if (!channelId) return false;

  // Description reads top-to-bottom as "here's what you wrote" (quoted) then the reply.
  const context = dm.contextText ? truncate(dm.contextText, MAX_CONTEXT) : '';
  const description = context ? `${blockquote(context)}\n\n${reply}` : reply;

  try {
    const r = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The reply lives in the embed; the content lead line is what a push notification previews,
        // so it names what happened. Embeds never ping, but deny all mentions anyway for safety.
        content: COPY['reply-dm.heading'],
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: dm.subject
              ? truncate(fill(COPY['reply-dm.subject'], { subject: dm.subject }), 256)
              : COPY['reply-dm.subject-blank'],
            description,
            color: REPLY_COLOR,
            footer: { text: COPY['reply-dm.footer'] },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
