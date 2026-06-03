// Manually post/edit the "who's playing today" card to a Discord webhook — the real
// message (embed + image + Play button), without playing through the Activity.
//
// Run with .env loaded so admin()/Supabase and the webhook lookup work:
//   node --env-file=.env --import tsx scripts/card-send.mts --scope g:<guildId>
//
// Modes:
//   --scope g:<id>     look up the room's stored webhook + today's real roster
//   --webhook <url>    post to an explicit webhook instead (e.g. a throwaway one)
//   --sample           use a fabricated roster + grids (no roster in the DB yet)
//   --edit             PATCH an existing card instead of POST (live-refresh test)
//   --message-id <id>  which message --edit targets (default: live_cards.message_id)
//   --no-button        drop the Play button (a user-made webhook can't send components)
//   --dry              render to /tmp/card-send.png and print the payload; no network
//
// Examples:
//   ... --scope g:123 --sample            # post a fake roster to the room's webhook
//   ... --webhook https://discord.com/api/webhooks/.. --sample --no-button
//   ... --scope g:123 --sample --edit --message-id 456   # edit that message in place
import { writeFileSync } from 'node:fs';
import { admin } from '../api/_admin.ts';
import { renderRoster, type CardPlayer } from '../api/_card.ts';
import { cardPayload, sendCard, withGrids } from '../api/_livecard.ts';
import { fetchPuzzle, todayET } from '../api/_nyt.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const scope = opt('--scope');
const webhookOverride = opt('--webhook');
const useSample = flag('--sample');
const doEdit = flag('--edit');
const noButton = flag('--no-button');
const dry = flag('--dry');

// A fabricated roster with a few grid states (each row = four group-levels 0..3).
const sampleRoster: CardPlayer[] = [
  { id: '1', name: 'borgar', avatar: 'https://cdn.discordapp.com/embed/avatars/0.png', grid: [[0, 1, 0, 0], [2, 2, 2, 2], [0, 0, 0, 0], [1, 1, 1, 1], [3, 3, 3, 3]] },
  { id: '2', name: 'loljessecs', avatar: null, grid: [[0, 1, 0, 2], [1, 1, 3, 1], [0, 0, 0, 0], [2, 3, 2, 2]] },
  { id: '3', name: 'mizutsune', avatar: 'https://cdn.discordapp.com/embed/avatars/2.png', grid: [[0, 0, 0, 0], [3, 1, 2, 3]] },
  { id: '4', name: 'Aria', avatar: null, grid: [] },
];

const db = admin();
const date = todayET();

// Resolve the puzzle (for the #number and real grid replay).
let puzzle = null;
try {
  puzzle = await fetchPuzzle(date);
} catch {
  console.warn('Could not fetch today’s puzzle; grids/number may be blank.');
}

// Resolve the roster: real (from live_cards + progress) or the sample.
let players: CardPlayer[];
let storedMessageId: string | null = null;
if (useSample || !scope || !db) {
  if (!useSample && (!scope || !db)) console.warn('No --scope or no DB env; using --sample roster.');
  players = sampleRoster;
} else {
  const { data: card } = await db
    .from('live_cards')
    .select('players, message_id')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  const stored: CardPlayer[] = Array.isArray(card?.players) ? (card!.players as CardPlayer[]) : [];
  storedMessageId = (card?.message_id as string | null) ?? null;
  if (!stored.length) {
    console.warn(`No roster on today’s card for ${scope}; falling back to --sample. (Open the Activity once, or pass --sample.)`);
    players = sampleRoster;
  } else {
    players = puzzle ? await withGrids(db, puzzle, date, stored) : stored;
  }
}

const png = await renderRoster(players, { puzzleNo: puzzle?.id });
let payload = cardPayload() as { components?: unknown[] };
if (noButton) payload = { ...payload, components: [] };

if (dry) {
  const out = '/tmp/card-send.png';
  writeFileSync(out, png);
  console.log('DRY RUN — wrote', out, `(${png.length} bytes)`);
  console.log('payload:', JSON.stringify(payload, null, 2));
  process.exit(0);
}

// Resolve the webhook: explicit override, or the room's stored one.
let webhookUrl = webhookOverride;
if (!webhookUrl) {
  if (!scope || !db) {
    console.error('Need --webhook <url>, or --scope g:<id> with .env (SUPABASE_* set) to look one up.');
    process.exit(1);
  }
  const { data: chan } = await db
    .from('recap_channels')
    .select('webhook_url')
    .eq('scope_id', scope)
    .maybeSingle();
  webhookUrl = (chan?.webhook_url as string | null) ?? null;
  if (!webhookUrl) {
    console.error(`No stored webhook for ${scope}. Pass --webhook <url> (a channel webhook) instead.`);
    process.exit(1);
  }
}

if (doEdit) {
  const targetId = opt('--message-id') ?? storedMessageId;
  if (!targetId) {
    console.error('No message to edit. Pass --message-id <id> (from a POST), or POST a fresh card first.');
    process.exit(1);
  }
  const r = await sendCard(`${webhookUrl}/messages/${targetId}?with_components=${!noButton}`, payload, png, 'PATCH');
  console.log('PATCH', r.status, r.ok ? 'edited' : await r.text());
} else {
  const r = await sendCard(`${webhookUrl}?wait=true&with_components=${!noButton}`, payload, png, 'POST');
  const body = (await r.json().catch(() => ({}))) as { id?: string };
  console.log('POST', r.status, r.ok ? `posted message ${body.id}` : JSON.stringify(body));
  if (r.ok && body.id && scope && db && !useSample) {
    // Record the message id so a later --edit targets this one.
    await db.from('live_cards').update({ message_id: body.id }).eq('scope_id', scope).eq('puzzle_date', date);
  }
}
