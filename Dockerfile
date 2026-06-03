# Always-on worker that holds one Discord gateway connection so the bot's custom status
# stays set to "/connections" (see scripts/status.mjs for why this can't be serverless).
#
# This is for Railway ONLY. The main app deploys on Vercel, which ignores Dockerfiles.
# The script has zero npm dependencies, so we don't copy package.json or run an install —
# just Node + the one file. node:22-alpine tracks the latest Node 22.x, which ships the
# global WebSocket the worker uses.
FROM node:22-alpine
WORKDIR /app
COPY scripts/status.mjs ./scripts/status.mjs
# DISCORD_BOT_TOKEN is injected at runtime from Railway's Variables tab — never baked in.
CMD ["node", "scripts/status.mjs"]
