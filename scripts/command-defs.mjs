// The app's CHAT-INPUT command definitions, as pure data. scripts/register-commands.mjs reconciles
// Discord's registered list against this array, and tests/interactions.test.ts reads it so two
// things can't silently drift from what's actually registered: the /help text (every command here
// must be listed in it) and the moderator gates (/mute + /unmute carry Manage Channels).
//
// The PRIMARY_ENTRY_POINT command (the App Launcher entry) is deliberately NOT in here — it's
// PATCHed on its own in register-commands.mjs and must stay handler: APP_HANDLER. Launch
// reliability depends on it; never fold it into the generic loop.
//
// Fields map 1:1 onto Discord's application-command body:
//   contexts            0 = guild, 1 = bot DM, 2 = private channel / group DM
//   integration_types   0 = GUILD_INSTALL (the bot is in the server), 1 = USER_INSTALL
//   default_member_permissions  null = open to everyone; a bitfield string = Discord-side gate
//   previousNames       names this command has been registered under before. Discord has no rename
//                       API, so the register script matches on these and PATCHes `name` in place —
//                       the command keeps its id and any per-guild permission overrides.

// Manage Channels (1 << 4). The moderator bar for muting/unmuting a channel.
export const MANAGE_CHANNELS = '16';

// Everywhere the Activity can be launched from (guild, DM, group DM), user-install included.
const ANYWHERE = [0, 1, 2];
const GUILD_ONLY = [0];
const BOTH_INSTALLS = [0, 1];

export const CHAT_COMMANDS = [
  {
    name: 'disconnections',
    description: 'Launch the daily 16-word Disconnections puzzle',
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    // Indefinite post-rebrand alias: same launch behaviour, described with the new name so the
    // branding is right even when someone still types /connections. api/interactions.ts's
    // LAUNCH_COMMANDS treats both names identically.
    name: 'connections',
    description: 'Launch Disconnections',
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    name: 'share',
    description: "Share your Disconnections result grid for today's puzzle",
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    name: 'donate',
    description: 'Support Disconnections and help cover the server costs',
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    // The install pitch lives here now that the mid-launch popup is gone (the other place it
    // appears is the small aside on a piggybacked recap). Open to everyone: the OAuth add itself
    // needs Manage Server, so there's nothing privileged about seeing the link.
    name: 'invite-bot',
    description: 'Add the Disconnections bot to this server',
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    name: 'help',
    description: 'What each Disconnections command does',
    contexts: ANYWHERE,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: null,
  },
  {
    // RENAMED from /disable-posts (itself renamed from /unsubscribe). The description names the
    // app's own surfaces on purpose: on most servers /mute is a moderation bot's member timeout,
    // and this one only silences Disconnections' cards and recaps in one channel.
    // integration_types is BOTH now, not guild-install only: a bot-less server gets posts too (the
    // token-backed card + the piggybacked recap), so its moderators need to be able to mute them.
    name: 'mute',
    description: 'Mute Disconnections in this channel: no more game cards or recaps',
    contexts: GUILD_ONLY,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: MANAGE_CHANNELS,
    previousNames: ['disable-posts', 'unsubscribe'],
  },
  {
    // RENAMED from /enable-posts, which was left ungated only because it carried the add-bot pitch;
    // that now lives in /invite-bot, so un-muting takes the same Discord-side Manage Channels gate
    // its mirror has. api/interactions.ts still checks the permission itself (defense in depth).
    name: 'unmute',
    description: 'Turn Disconnections cards and recaps back on in this channel',
    contexts: GUILD_ONLY,
    integration_types: BOTH_INSTALLS,
    default_member_permissions: MANAGE_CHANNELS,
    previousNames: ['enable-posts'],
  },
];
