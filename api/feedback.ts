import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchDiscordUser } from './_discord.js';

// Player feedback from the in-game "Send feedback" form. Posts each note to a Discord
// channel via an incoming webhook (DISCORD_FEEDBACK_WEBHOOK_URL — a channel webhook the
// dev makes in their own server; no bot/app involved). The form is open, so we gate on a
// real Discord token (identity via /users/@me, same as /api/score) to keep out drive-by
// posts and to tag who sent it. The browser never sees the webhook URL; that stays here.

const MAX_LEN = 2000; // Discord embed description limit
const CATEGORIES = ['Bug', 'Idea', 'Other'];
const COLOR: Record<string, number> = { Bug: 0xe06c75, Idea: 0xf9df6d, Other: 0xb0c4ef };
const EMOJI: Record<string, string> = { Bug: '🐛', Idea: '💡', Other: '💬' };

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const webhook = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
    if (!webhook) {
      // Not configured (e.g. local without the env var); the form falls back to its
      // local thank-you when this isn't a success.
      res.status(503).json({ error: 'feedback not configured' });
      return;
    }
    const body = req.body ?? {};

    // Real Discord user only — also gives us a name to tag the note with.
    const user = await fetchDiscordUser(body.accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'empty' });
      return;
    }
    const category = CATEGORIES.includes(body.category) ? (body.category as string) : 'Other';
    const puzzle = Number.isInteger(body.puzzle) ? (body.puzzle as number) : null;

    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Connections feedback',
        // Never let feedback text ping anyone (@everyone, roles, users).
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: `${EMOJI[category]} ${category}`,
            description: text.slice(0, MAX_LEN),
            color: COLOR[category],
            fields: [
              { name: 'From', value: `${user.name} (${user.id})`, inline: true },
              ...(puzzle != null
                ? [{ name: 'Puzzle', value: `No. ${puzzle}`, inline: true }]
                : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!r.ok) {
      res.status(502).json({ error: 'webhook rejected' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
