#!/usr/bin/env bash
# Point REA (https://github.com/morluto/rea) at a video page and save its
# evidence for study. Works on the real YouTube watch page (run on your own
# machine; the page must be reachable) and on this scaffold, so the two can be
# compared side by side.
#
#   ./scripts/rea-study.sh https://www.youtube.com/watch?v=VIDEO_ID
#   ./scripts/rea-study.sh http://127.0.0.1:8080/        # after `npm run serve`
#
# What it does:
#   1. launches a throwaway Chromium profile with CDP on 127.0.0.1:9222
#   2. lets the page load and play for a while
#   3. runs REA's passive web tools and writes each result to rea-out/<run>/
#
# Everything REA captures stays local in rea-out/ (gitignored). Captured
# third-party scripts are for reading, not for copying into this project.
#
# Env: CHROME=/path/to/chrome   PORT=9222   PLAY_MS=8000   HEADLESS=1
#      PLAYER_SELECTOR=#player        element whose event listeners are dumped
#      EXTRA_ORIGIN_PATTERN=regex     other origins to capture as well, found from the
#                                     page's own resource list (e.g. 'googlevideo\.com'
#                                     for YouTube's media servers); REA otherwise only
#                                     captures the page's own origin
set -euo pipefail
cd "$(dirname "$0")/.."

URL=${1:?usage: rea-study.sh <url>}
PORT=${PORT:-9222}
PLAY_MS=${PLAY_MS:-8000}
REA=${REA:-npx -y rea-agents@latest}
CDP="http://127.0.0.1:$PORT"

find_chrome() {
  for c in "${CHROME:-}" google-chrome chromium chromium-browser \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    /opt/pw-browsers/chromium-*/chrome-linux/chrome; do
    [ -n "$c" ] && command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  echo "No Chrome-family browser found; set CHROME=/path/to/chrome" >&2
  exit 1
}

RUN="rea-out/$(echo "$URL" | sed -E 's#https?://##; s#[^A-Za-z0-9]+#_#g' | cut -c1-60)-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
PROFILE="$PWD/.rea-browser-profile"
rm -rf "$PROFILE"

CHROME_BIN=$(find_chrome)
HEADLESS_FLAG=()
[ "${HEADLESS:-0}" = 1 ] && HEADLESS_FLAG=(--headless=new)
[ "$(id -u)" = 0 ] && HEADLESS_FLAG+=(--no-sandbox) # containers run as root; Chrome refuses otherwise
"$CHROME_BIN" ${HEADLESS_FLAG[@]+"${HEADLESS_FLAG[@]}"} --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" --password-store=basic --no-first-run --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required "$URL" >"$RUN/chrome.log" 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID 2>/dev/null || true' EXIT

for _ in $(seq 50); do curl -fsS "$CDP/json/version" >/dev/null 2>&1 && break; sleep 0.2; done

run() { # run <name> <rea args...>
  local name=$1; shift
  echo "→ $name"
  if $REA "$@" --format json >"$RUN/$name.json" 2>"$RUN/$name.err"; then rm -f "$RUN/$name.err"
  else echo "  (failed; see $RUN/$name.err)"; fi
}

run targets list-browser-targets "$CDP"
TARGET=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const list = r.normalized_result?.targets ?? [];
  const t = list.find((t) => (t.url ?? "").startsWith(process.argv[2].split("?")[0])) ?? list[0];
  process.stdout.write(t?.target_id ?? "");
' "$RUN/targets.json" "$URL")
[ -n "$TARGET" ] || { echo "no page target found; see $RUN/targets.json"; exit 1; }
echo "target $TARGET — letting the page play for ${PLAY_MS}ms"

# REA captures only exact origins: the page's own, plus any we name here.
ORIGIN_ARGS=()
if [ -n "${EXTRA_ORIGIN_PATTERN:-}" ]; then
  sleep 3 # let the player start fetching media first
  PAGE_ORIGIN=$(node -e 'console.log(new URL(process.argv[1]).origin)' "$URL")
  ORIGIN_ARGS=(--allowed-origins "$PAGE_ORIGIN")
  for o in $(node scripts/discover-origins.mjs "$CDP" "$TARGET" "$EXTRA_ORIGIN_PATTERN"); do
    [ "$o" = "$PAGE_ORIGIN" ] && continue
    echo "  + capturing $o"
    ORIGIN_ARGS+=(--allowed-origins "$o")
  done
fi

# While the page plays: network (segment requests, player config JSON shapes),
# console, workers, DOM + accessibility tree of the player chrome, and scripts.
run page inspect-web-page "$CDP" "$TARGET" ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"} --observation-ms "$PLAY_MS" \
  --include-accessibility-text --include-json-body-shapes --include-script-sources --include-storage-keys
run bundle analyze-web-bundle "$CDP" "$TARGET" --observation-ms 2000
run screenshot capture-web-screenshot "$CDP" "$TARGET"

# Which handlers sit on the video element and the player root?
run listeners-video inspect-web-event-listeners "$CDP" "$TARGET" video
run listeners-player inspect-web-event-listeners "$CDP" "$TARGET" "${PLAYER_SELECTOR:-#player}"

# Precise execution profile while you interact (seek, open settings, ...).
echo "→ execution: interact with the player now (${PLAY_MS}ms)"
run execution observe-web-execution "$CDP" "$TARGET" ${ORIGIN_ARGS[@]+"${ORIGIN_ARGS[@]}"} --observation-ms "$PLAY_MS"

# Export the captured scripts to disk for REA's static JS analysis.
if [ -s "$RUN/page.json" ]; then
  run export export-web-scripts "$PWD/$RUN/page.json" "$PWD/$RUN/scripts"
  [ -d "$RUN/scripts" ] && run js-graph analyze-javascript-application "$PWD/$RUN/scripts"
fi

node scripts/rea-summary.mjs "$RUN" | tee "$RUN/SUMMARY.md"
