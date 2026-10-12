#!/usr/bin/env bash
# Generates a synthetic test video for the player, laid out the way an adaptive
# player wants it: separate video-only and audio-only renditions, each split into
# fragmented-MP4 segments with keyframe-aligned boundaries (so the ABR controller
# can switch rendition at any segment), plus a storyboard sprite for seek previews.
#
# Codecs are VP9 + Opus, which open-source Chromium (incl. Playwright's) can decode
# through MSE. Output goes to public/media/ (gitignored). Requires ffmpeg.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=public/media
DUR=${DUR:-60}         # seconds of test pattern
SEG=4                  # segment duration, seconds
FPS=30
GOP=$((SEG * FPS))     # one keyframe per segment => every boundary is switchable

rm -rf "$OUT" && mkdir -p "$OUT"

SRC="testsrc2=size=1280x720:rate=$FPS:duration=$DUR"
TONE="sine=frequency=440:beep_factor=4:duration=$DUR"

# label height kbps
RENDITIONS=("240p 240 250" "480p 480 700" "720p 720 1500")

for r in "${RENDITIONS[@]}"; do
  read -r label h kbps <<<"$r"
  mkdir -p "$OUT/video/$label"
  echo "→ video $label"
  ffmpeg -hide_banner -loglevel error -f lavfi -i "$SRC" \
    -vf "scale=-2:$h,drawtext=text='$label  %{pts\\:hms}':x=20:y=20:fontsize=$((h / 12)):fontcolor=white:box=1:boxcolor=black@0.6" \
    -c:v libvpx-vp9 -b:v "${kbps}k" -deadline realtime -cpu-used 8 -row-mt 1 \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -an \
    -f hls -hls_time "$SEG" -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$OUT/video/$label/seg%03d.m4s" \
    "$OUT/video/$label/index.m3u8"
done

mkdir -p "$OUT/audio/opus"
echo "→ audio"
ffmpeg -hide_banner -loglevel error -f lavfi -i "$TONE" \
  -c:a libopus -b:a 96k -ac 2 \
  -f hls -hls_time "$SEG" -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$OUT/audio/opus/seg%03d.m4s" \
  "$OUT/audio/opus/index.m3u8"

# Progressive fallback (single muxed file) for browsers without MSE.
echo "→ progressive fallback"
ffmpeg -hide_banner -loglevel error -f lavfi -i "$SRC" -f lavfi -i "$TONE" \
  -vf "scale=-2:360" -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 64k -shortest "$OUT/progressive.webm"

# Storyboard: one 160x90 thumbnail every 2s, tiled 10 columns wide.
echo "→ storyboard"
FRAMES=$((DUR / 2))
ROWS=$(((FRAMES + 9) / 10))
ffmpeg -hide_banner -loglevel error -f lavfi -i "$SRC" \
  -vf "fps=1/2,scale=160:90,tile=10x$ROWS" -frames:v 1 "$OUT/storyboard.jpg"

# The manifest is our own tiny format (YouTube's real one is a DASH/SABR player
# response); it just points at the per-rendition playlists.
cat >"$OUT/manifest.json" <<JSON
{
  "id": "test-pattern",
  "title": "Synthetic test pattern ($DUR s)",
  "duration": $DUR,
  "video": [
    { "label": "240p", "height": 240, "bandwidth": 250000, "playlist": "video/240p/index.m3u8", "mime": "video/mp4; codecs=\"vp09.00.10.08\"" },
    { "label": "480p", "height": 480, "bandwidth": 700000, "playlist": "video/480p/index.m3u8", "mime": "video/mp4; codecs=\"vp09.00.10.08\"" },
    { "label": "720p", "height": 720, "bandwidth": 1500000, "playlist": "video/720p/index.m3u8", "mime": "video/mp4; codecs=\"vp09.00.10.08\"" }
  ],
  "audio": [
    { "label": "opus 96k", "bandwidth": 96000, "playlist": "audio/opus/index.m3u8", "mime": "audio/mp4; codecs=\"opus\"" }
  ],
  "progressive": "progressive.webm",
  "storyboard": { "url": "storyboard.jpg", "interval": 2, "width": 160, "height": 90, "columns": 10, "count": $FRAMES },
  "captions": [ { "lang": "en", "label": "English", "url": "../assets/captions.en.vtt" } ],
  "chapters": [
    { "start": 0, "title": "Intro" },
    { "start": 12, "title": "Color bars" },
    { "start": 30, "title": "Middle" },
    { "start": 48, "title": "Outro" }
  ]
}
JSON

du -sh "$OUT"
