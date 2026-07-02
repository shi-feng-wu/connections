// Discord webhook mirror for the player↔dev chat (api/chat.ts). Posts each message — both a
// player's note and our reply — to DISCORD_FEEDBACK_WEBHOOK_URL, the channel webhook the dev
// makes in their own server (no bot/app involved; the browser never sees the URL, it stays here).
// This used to be the whole feedback feature; now it's a notification mirror of a conversation
// whose system of record is chat_threads/chat_messages, so a reply still pings the dev's channel
// and the channel reads as the full back-and-forth. Best-effort: returns whether the post landed
// and never throws into the request (the message is already persisted by the time we post).
// Leading underscore keeps Vercel from treating this file as a route.

import { REPLY_COLOR } from '../src/discord-messages.js';

const MAX_LEN = 2000; // Discord embed description limit
export const CATEGORIES = ['Bug', 'Idea', 'Other'];
const COLOR: Record<string, number> = { Bug: 0xe06c75, Idea: 0xf9df6d, Other: 0xb0c4ef };
const EMOJI: Record<string, string> = { Bug: '🐛', Idea: '💡', Other: '💬' };
// Replies get their own hue (REPLY_COLOR, shared with the player DM) + arrow so the webhook
// channel reads as a conversation, not a pile of inbound notes.

export function isCategory(c: unknown): c is string {
  return typeof c === 'string' && CATEGORIES.includes(c);
}

export type FeedbackPost = {
  direction: 'in' | 'out'; // in = from the player, out = our reply
  authorName: string; // who wrote this message (the player, or the replying dev)
  authorId: string;
  text: string;
  // 'in' only: the category tag + puzzle context the opening message carried.
  category?: string | null;
  puzzle?: number | null;
  // 'out' only: the player this reply is going to (for the embed title).
  playerName?: string | null;
};

export async function postFeedbackWebhook(post: FeedbackPost): Promise<boolean> {
  const webhook = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!webhook) return false;
  const text = post.text.trim();
  if (!text) return false;

  const cat = isCategory(post.category) ? post.category : null;
  const inbound = post.direction === 'in';
  const title = inbound
    ? `${cat ? EMOJI[cat] : '💬'} ${cat ?? 'Message'}`
    : `↩︎ Reply → ${post.playerName ?? 'player'}`;
  const color = inbound ? (cat ? COLOR[cat] : COLOR.Other) : REPLY_COLOR;

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Connections feedback',
        // Never let a note ping anyone (@everyone, roles, users).
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title,
            description: text.slice(0, MAX_LEN),
            color,
            fields: [
              {
                name: inbound ? 'From' : 'Sent by',
                value: `${post.authorName} (${post.authorId})`,
                inline: true,
              },
              ...(post.puzzle != null
                ? [{ name: 'Puzzle', value: `No. ${post.puzzle}`, inline: true }]
                : []),
            ],
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
