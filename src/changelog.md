<!--
  User-facing changelog. Newest release first.

  Versioning follows SemVer (MAJOR.MINOR.PATCH):
    • MAJOR — a breaking or sweeping change (rare). Bump when something is removed
      or reworked in a way that changes how the game fundamentally works.
    • MINOR — a new, backward-compatible feature. Anything under an "Added" section.
    • PATCH — a bug fix or small tweak. A release that's only "Fixed".
  Reset the lower parts on a bump: 1.6.0 → 1.7.0 (feature), 1.7.0 → 1.7.1 (fix).

  Format (Keep a Changelog): each release is a "## vMAJOR.MINOR.PATCH — date" header,
  followed by one or more "### <Category>" sections, each with "- " bullets. Use the
  standard categories as needed, listed in this order: Added, Changed, Deprecated,
  Removed, Fixed, Security. Plain text only — no inline markdown styling is rendered.

  The top release shows the "New" badge and sets the app version, so add new releases
  at the very top. Group everything that ships together into one release.
-->

## v1.14.0 — Jul 1, 2026

### Added

- Need a hint? Tap the lightbulb to paint one word's tile in its group's color from the easiest group you haven't solved yet, like the NYT hint page. Each hint costs 30 points.

## v1.13.0 — Jul 1, 2026

### Added

- When we reply to feedback, the bot also DMs you the response in Discord.

## v1.12.1 — Jun 30, 2026

### Changed

- You no longer have to wait for a guess to finish animating before submitting the next guess.

## v1.12.0 — Jun 29, 2026

### Added

- Implemented now-playing card in servers without the bot.

## v1.11.0 — Jun 26, 2026

### Added

- Launch Connections in a DM or group chat and a who’s-playing card now drops in with a Play button, so whoever you’re talking to can tap in and join. It fills in as people jump in.

## v1.10.2 — Jun 26, 2026

### Fixed

- Launching the game is more reliable. Tapping Play now or running /connections would occasionally come up blank before.

## v1.10.1 — Jun 25, 2026

### Fixed

- On phones, the date, puzzle number, and menu now live in a header at the top of the screen. The menu button used to float in the bottom corner, where it could cover the next-puzzle countdown once your run was over.

## v1.10.0 — Jun 24, 2026

### Added

- Feedback is a conversation now. Give each message a subject and it becomes its own thread in your Feedback inbox — open any one to see our replies and write back. The inbox shows the latest line from either side, with a dot when there’s something new.

## v1.9.0 — Jun 24, 2026

### Added

- If the bot can’t post in your channel (usually a private one), launching the game there now shows a private tip with the exact permissions to grant, so the recap and who’s-playing card can appear.

## v1.8.0 — Jun 24, 2026

### Added

- Channel moderators can run /unsubscribe to stop the daily recap from posting in a channel. It turns back on by itself if someone plays there again.

## v1.7.0 — Jun 24, 2026

### Added

- You can see other players clicking tiles in real time now.

### Fixed

- The live roster updates instantly.

## v1.6.0 — Jun 23, 2026

### Added

- A Share button on your results.
- Your season standings now show arrows for how many spots you’ve moved since the day’s puzzle dropped.
- A built-in FAQ and a way to send feedback without leaving the game.
- Run /donate if you’d like to chip in for server costs.

### Changed

- Reworked scoring: dropped the redundant solve bonus, a quick solve now earns a bigger speed bonus, and a new grace period lets a super-quick run (20s) reach a perfect 500. (Does not affect old scores.)

## v1.5.0 — Jun 21, 2026

### Added

- /share, so you can post a spoiler-free grid of your result.
- Friends can see “Solving today’s puzzle” on your profile while you play now.

### Fixed

- Image-puzzle days work properly now too.

## v1.4.0 — Jun 12, 2026

### Added

- A little landing page for anyone who opens the link outside Discord.
- A new server dashboard.

### Changed

- The board fills big windows now, and stays square when they’re short.
- A fresher logo and smoother transitions.

## v1.3.0 — Jun 9, 2026

### Added

- Tap to reveal the last group and try to guess it before it spoils.
- The end screen now shows how your score broke down.
- Run /enable-posts to get the day’s results posted in a channel.

## v1.2.0 — Jun 6, 2026

### Added

- Season and all-time standings, across every channel and server you play in.
- A daily recap card posts yesterday’s results next to the standings.

### Changed

- The live list now shows everyone in the room as they solve.

## v1.1.0 — Jun 4, 2026

### Added

- Watch the whole room solve together, live.
- A “who’s playing” card pops into the channel when a game kicks off.
- Scoring, streaks, and a 24-hour window on each puzzle.

## v1.0.0 — Jun 2, 2026

### Added

- Connections, the daily NYT puzzle, right inside Discord.
- Your progress saves, so you can wander off and finish later.
