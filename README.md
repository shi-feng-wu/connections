# Connections (Discord Activity)

The daily NYT Connections puzzle as a Discord Activity (the embedded GUI that opens on Play, like the Wordle activity). Shows live progress of everyone in your session and a persistent leaderboard (this season + all-time) on the end screen.

- Client: Vite + React + TypeScript + Tailwind v4
- API: Vercel serverless functions for OAuth token exchange and the NYT puzzle proxy
- Realtime + storage: Supabase Presence for live progress, Postgres for the leaderboard
- Also runs standalone in a plain browser (skips Discord/Supabase) for UI dev

```
src/        client: main.tsx (bootstrap), App.tsx (state/wiring), components.tsx (UI),
            game.ts (model), realtime.ts, leaderboard.ts, supabase.ts, toast.ts
api/        Vercel functions: puzzle.ts (NYT), token.ts (OAuth), _nyt.ts (shared)
supabase/   schema.sql: the leaderboard table (run once)
index.html  vite.config.ts  tsconfig.json  package.json
```

One `package.json`, one `node_modules`. No server to run: Vercel hosts the
static client + functions, Supabase handles realtime/DB.

## Requirements

- Node 22 (pinned via `.node-version`; run `fnm use`)
- A Discord application with Activities enabled
- Accounts on [Vercel](https://vercel.com) and [Supabase](https://supabase.com)

## 1. Supabase (live progress + leaderboard)

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor → New query → paste `supabase/schema.sql` → Run. Presence
   needs no table; this creates the `scores` table, the leaderboard functions
   (`room_board` / `room_self` / `current_streak`), and policies. It's
   idempotent: re-run it after pulling scoring changes to pick up new columns
   and functions.
3. Project Settings → API → copy the Project URL, the anon public
   key, the service_role key (secret, server only), and the JWT Secret
   (Settings → API → JWT Settings). The last two power server-side scoring and
   authenticated presence.

## 2. Configure

```bash
fnm use
npm install
cp .env.example .env
```

Fill in `.env`:
- `VITE_DISCORD_CLIENT_ID`: your app ID (prefilled)
- `DISCORD_CLIENT_SECRET`: Developer Portal → OAuth2 → Client Secret
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`: from step 1 (the anon key is
  read-only; it can't write the leaderboard)
- `SUPABASE_SERVICE_ROLE_KEY`: from step 1. Server-only secret that lets
  `/api/score` write verified rows. Never `VITE_`-prefixed (would ship to the browser).
- `SUPABASE_JWT_SECRET`: from step 1. Signs the short-lived Realtime JWTs that
  gate live presence to verified users.
- `SESSION_SECRET`: any long random string. HMAC key for the signed game session
  that anchors solve timing. Generate e.g. `openssl rand -base64 32`.

## 3. Run locally

```bash
npm i -g vercel     # one-time
vercel dev          # serves the client + /api functions together
```

Open the printed URL. Two browser tabs with `?room=test` on the end share live
progress, so you can watch multiplayer work without Discord.

### Tests

```bash
npm test            # vitest run (one-shot); npm run test:watch to iterate
npm run typecheck   # tsc --noEmit
```

Covers the parts that must be correct: the pure `Game` model (`game.ts`: submit
outcomes, loss back-fill, the score formula, share grid), roster ranking
(`roster.ts`), the HMAC session signing (`api/_session.ts`, the anti-cheat that
binds a score to a server-timed session), and the leaderboard SQL itself.
`src/sql.test.ts` loads the real `current_streak` / `room_board` / `room_self`
function bodies out of `supabase/schema.sql` and runs them in an in-process
Postgres ([PGlite](https://pglite.dev), WASM), so the streak/aggregation logic
is actually executed, not just reviewed. The UI is verified separately via the
screenshot harness (`preview.html` + `src/preview.tsx`).

## 4. Deploy to Vercel

1. Push to GitHub (already wired: `git push`).
2. [vercel.com](https://vercel.com) → Add New → Project → import the repo.
   Vercel auto-detects Vite + the `api/` functions, no config needed.
3. Settings → Environment Variables → add everything from your `.env`
   (`VITE_DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`,
   `SESSION_SECRET`). The `VITE_*` ones are needed at build time; the rest are
   server-only secrets (no `VITE_` prefix, so they never reach the browser).
4. Deploy → copy your `https://<project>.vercel.app` URL.
5. Discord Portal → Activities → URL Mappings → `/` → that host (no `https://`).
   Set once.

## How multiplayer works

- Identity comes from the Discord SDK (`identify` scope); standalone falls back to a guest.
- Live progress: everyone in the same activity launch shares a Discord
  `instanceId`. The client joins a Supabase Realtime Presence channel keyed by
  that ID and broadcasts `{name, mistakesLeft, solvedCount, done}`, so the
  Players panel updates live. No server, no table.
- Scoring & leaderboards: each finish produces a single transferable
  `score` (`game.ts` → `Game.score`). A win rewards completion plus a flat solve
  bonus, with mistakes and speed trading off; a loss earns convex partial credit
  for groups reached (so finishing is worth far more than getting 2/4). On finish
  the server writes one row to `scores` (first finish per puzzle wins, so replays
  can't farm it). The end screen then shows where you stand in the room: a
  leaderboard with two tabs, This season (the month) and All-time, each
  ranking players by cumulative score with streak / games / win% / avg-mistakes,
  and your own row pinned. Both come off the same table via the `room_board` /
  `room_self` Postgres functions (windowed by a `since` date; `null` = all-time).
  A "room" is the Discord guild in a server, or the channel in a DM / group chat
  (which have no guild), so the standing persists across activity launches. Only
  the official daily counts toward it. Live in-session progress is a separate
  surface, the Roster (Supabase Presence), no table.

## Notes

Personal/educational. Puzzle data is © The New York Times via their public
endpoint; don't use commercially or against their
[Terms](https://www.nytimes.com/content/help/rights/terms/terms-of-service.html).
Not affiliated with NYT.

Leaderboard integrity. Scores are server-authoritative: `/api/score` resolves
the player's identity from their Discord token (`/users/@me`), replays the
submitted guesses against the real solution to derive the outcome, measures solve
time from a signed start session, computes the score itself, and writes with the
service-role key. The browser's anon key is read-only (RLS blocks all writes), so
the leaderboard can't be forged, and live presence is gated to verified users via
short-lived Supabase JWTs. The one thing that's not preventable, because the
puzzle is rendered client-side and the answers are published by NYT anyway, is a
determined player looking up the answers to post a clean solve; but it's tied to
their real identity and real (server-measured) time. Closing even that would need
fully server-authoritative play (validate every guess, never send answers), which
isn't worth the per-guess latency for a public puzzle.
