# Always-on Railway worker. Runs the live-roster SSE relay (scripts/relay.mjs), which also keeps
# the bot's "/connections" custom status alive as a child process (scripts/status.mjs — see that
# file for why presence can't be serverless). One service covers both.
#
# This is for Railway ONLY. The main app deploys on Vercel, which ignores Dockerfiles. Both scripts
# have zero npm dependencies, so we don't copy package.json or run an install — just Node + the two
# files. node:22-alpine tracks the latest Node 22.x, which ships the global WebSocket the status
# worker uses.
FROM node:22-alpine
WORKDIR /app
COPY scripts/status.mjs ./scripts/status.mjs
COPY scripts/relay.mjs ./scripts/relay.mjs
# Injected at runtime from Railway's Variables tab — never baked in:
#   DISCORD_BOT_TOKEN  (status worker)   SESSION_SECRET  (verify x-ct tickets)   RELAY_SECRET (server pushes)
#   APP_ORIGIN + INTERNAL_SECRET  (optional: the live-card trailing flush → Vercel /api/refresh-card)
CMD ["node", "scripts/relay.mjs"]
