// Canonical leaderboard room key, shared by the client (reads) and /api/score
// (writes) so the two can't disagree on a player's scope. The `g:`/`c:` prefix
// keeps guild and channel rooms from colliding: a guild id stuffed into the
// channel slot yields a `c:` value that can never match the `g:` key a guild
// board is read under. /api/score also verifies guild membership before honoring
// a `g:` scope.
export function canonicalScope(
  guildId?: string | null,
  channelId?: string | null,
): string | null {
  if (guildId) return `g:${guildId}`;
  if (channelId) return `c:${channelId}`;
  return null;
}
