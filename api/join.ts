import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, mergePlayer, renderRoster, shouldRepost } from './_card.js';
import { fetchDiscordUser, fetchUserGuildIds } from './_discord.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { PLAY_CUSTOM_ID } from './_recap.js';

// Registers a player on the room's "who's playing today" card when they open the
// Activity. Identity is resolved from the Discord token (not the body), and a guild
// board is only touched after confirming membership (same gate as /api/score). The
// roster is append-only — opening adds you, leaving never removes you. The card is
// posted/edited on the room's incoming webhook (the one /api/discord-callback stored),
// so there's no bot in the guild. A fresh card is posted at most once per cooldown
// (earlier ones stay as a timeline of who was playing when); rapid joins between bumps
// edit the latest card in place. Best-effort: any failure just means no card.

// Send the card as a multipart message (image attachment). method = POST to create,
// PATCH to edit an existing message. Returns the raw Response.
async function sendCard(url: string, payload: object, png: Buffer, method: 'POST' | 'PATCH'): Promise<Response> {
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  form.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'card.png');
  return fetch(url, { method, body: form });
}

function cardPayload(count: number, puzzleNo?: number): object {
  return {
    embeds: [
      {
        title: `Connections${puzzleNo ? ` #${puzzleNo}` : ''}`,
        description: `${count} ${count === 1 ? 'player' : 'players'} playing today`,
        image: { url: 'attachment://card.png' },
        color: 0x5865f2,
      },
    ],
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: 'Play today', custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'card.png' }],
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.body ?? {};

    // Authoritative identity (never the body).
    const user = await fetchDiscordUser(body.accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // The card lives on a guild channel's webhook, so only g: scopes get one.
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const scope = canonicalScope(guildId, channelId);
    if (!scope || !scope.startsWith('g:') || !guildId) {
      res.status(200).json({ ok: false, reason: 'no-guild' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    // No webhook → the room never installed recaps; nothing to post to.
    const { data: chan } = await db
      .from('recap_channels')
      .select('webhook_url')
      .eq('scope_id', scope)
      .maybeSingle();
    const webhookUrl = chan?.webhook_url as string | null | undefined;
    if (!webhookUrl) {
      res.status(200).json({ ok: false, reason: 'no-webhook' });
      return;
    }

    const date = todayET();
    const { data: card } = await db
      .from('live_cards')
      .select('players, message_id, posted_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .maybeSingle();
    const existing: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];

    // Already on today's card → nothing to do (skip the membership round-trip too).
    if (existing.some((p) => p.id === user.id)) {
      res.status(200).json({ ok: true, changed: false });
      return;
    }

    // New addition: authorize the guild before writing its card (guild ids are public).
    const guilds = await fetchUserGuildIds(body.accessToken);
    if (!guilds || !guilds.includes(guildId)) {
      res.status(403).json({ ok: false, reason: 'not-a-member' });
      return;
    }

    const { players } = mergePlayer(existing, {
      id: user.id,
      name: user.name,
      avatar: user.avatar ?? null,
    });

    let puzzleNo: number | undefined;
    try {
      puzzleNo = (await fetchPuzzle(date)).id;
    } catch {
      /* title falls back to no number */
    }

    const png = await renderRoster(players, { puzzleNo });
    const payload = cardPayload(players.length, puzzleNo);

    // The webhook token is in the URL, so no auth header. with_components renders the
    // Play button on the (app-owned) webhook message.
    const clearDeadWebhook = () =>
      db.from('recap_channels').update({ webhook_url: null, webhook_id: null }).eq('scope_id', scope);
    const postFresh = () => sendCard(`${webhookUrl}?wait=true&with_components=true`, payload, png, 'POST');

    let messageId = (card?.message_id as string | null | undefined) ?? null;
    const lastPostedAt = card?.posted_at ? Date.parse(card.posted_at as string) : null;
    let postedAt = (card?.posted_at as string | null | undefined) ?? null;

    // Once the cooldown elapses, a new join posts a FRESH card and leaves the previous
    // one in place — the channel keeps a timeline of who was playing when. Between
    // bumps, rapid joins just edit the latest card. (No card yet → always post.)
    if (!messageId || shouldRepost(lastPostedAt, Date.now())) {
      const r = await postFresh();
      if (r.ok) {
        messageId = ((await r.json()) as { id?: string }).id ?? null;
        postedAt = new Date().toISOString();
      } else {
        if (r.status === 404 || r.status === 401) await clearDeadWebhook();
        res.status(200).json({ ok: false, reason: 'post-failed', status: r.status });
        return;
      }
    } else {
      let r = await sendCard(`${webhookUrl}/messages/${messageId}?with_components=true`, payload, png, 'PATCH');
      if (r.status === 404) {
        // The latest card was deleted; start a fresh one (becomes the new timeline tip).
        r = await postFresh();
        if (r.ok) {
          messageId = ((await r.json()) as { id?: string }).id ?? null;
          postedAt = new Date().toISOString();
        }
      }
      if (!r.ok) {
        if (r.status === 404 || r.status === 401) await clearDeadWebhook();
        res.status(200).json({ ok: false, reason: 'edit-failed', status: r.status });
        return;
      }
    }

    await db.from('live_cards').upsert(
      {
        scope_id: scope,
        puzzle_date: date,
        players,
        message_id: messageId,
        posted_at: postedAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'scope_id,puzzle_date' },
    );
    res.status(200).json({ ok: true, changed: true, players: players.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
