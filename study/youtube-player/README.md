# Video player study scaffold

A clean-room, dependency-free scaffold of a YouTube-style web video player, built
to study how such a player is put together, plus a harness that points
[REA](https://github.com/morluto/rea) at a real watch page so you can compare
your mental model against evidence.

All code here is original. Nothing is copied from YouTube. Where this scaffold
matches YouTube, it follows **publicly documented** behaviour: the IFrame API
state codes, the keyboard shortcuts from YouTube's help pages, and the
well-known use of DASH-style separate audio/video streams over MSE with
storyboard seek previews.

```
npm run media     # generate test video (ffmpeg): VP9/Opus fMP4 segments ×3 qualities, storyboard, captions
npm run serve     # http://127.0.0.1:8080/
npm test          # unit tests for the DOM-free modules
npm run rea:local # REA against this scaffold   (needs Chrome + network to npm)
npm run rea:youtube  # REA against a real watch page (run on your own machine)
```

URL flags: `?autoplay`, `?bw=800` (simulated bandwidth cap, kbps), `?progressive`
(skip MSE), `?manifest=…`. Right-click the video for the stats panel; `window.player`
is exposed for DevTools.

## Architecture

```
public/src/
  main.js                  watch page: mounts the player, owns theater / miniplayer layout
  core/
    player.js              Player facade — IFrame-API-shaped surface + events; picks an engine
    state.js               PlayerState (-1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued)
                           derived from raw <video> events
    emitter.js, prefs.js, format.js
  media/
    mse-engine.js          adaptive engine: MediaSource, one TrackLoader per stream, scheduler tick
    track-loader.js        one SourceBuffer: playlist, init segment, next segment, seek, flush, evict
    hls-playlist.js        parse a fMP4 media playlist into {initUrl, segments[]}
    bandwidth.js           throughput estimate: fast/slow EWMA, take the min
    abr.js                 rendition choice from bandwidth × buffer level × on-screen size
    fetcher.js             segment fetch with an optional simulated bandwidth cap
    progressive-engine.js  fallback: one muxed file, no switching
  ui/
    controls.js            assembles the chrome; one `actions` table shared by buttons/keys/gestures
    progress-bar.js        chapters, buffered/played/hover layers, scrubbing, storyboard preview
    settings-menu.js       stacked panels: speed, captions, quality
    overlays.js            spinner (delayed), action bezel, seek ripple, big play button
    autohide.js            fade chrome on inactivity
    keyboard.js            k/space j l ←→ ↑↓ m f t i c 0-9 Home End < > , .
  features/
    captions.js            WebVTT → own overlay renderer (not native ::cue)
    stats.js               "stats for nerds"-style panel with a bandwidth-cap selector
```

### Data flow

```
manifest.json ─► Player.load ─► MseEngine.start
                                   │  MediaSource ─► video.src (blob URL)
                                   ├─ TrackLoader(video) ─► SourceBuffer(video/mp4 vp09)
                                   └─ TrackLoader(audio) ─► SourceBuffer(audio/mp4 opus)
every 250 ms  #tick:
   ABR: chooseRendition(bandwidth, bufferAhead, video.clientHeight×dpr) ─► videoTrack.switchTo(i)
   for each track: bufferAhead < 30 s ? pump(): fetch [init if rendition changed] + next segment
                   evict media > 30 s behind playhead
   all tracks done ─► mediaSource.endOfStream()
seeking ─► each track: abort in-flight fetch, restart at the segment covering the new time
manual quality ─► lock + flush forward buffer so the change shows now
```

Things worth noticing while you read the code:

- **Split audio/video.** Video quality changes never touch the audio
  SourceBuffer. Segments are keyframe-aligned (`-g` = fps × segment length), so
  a rendition switch is just "append the new init segment, then keep going".
- **Auto vs locked quality.** An auto switch takes effect at the next segment
  boundary, so it's invisible. A manual pick flushes the forward buffer so it's
  visible right away.
- **The size cap in ABR.** The player never fetches a rendition much taller
  than the box it's drawn in. Shrink to the miniplayer and watch `fetching` drop
  in the stats panel.
- **State is derived.** The UI listens to `statechange`, never to `waiting` or
  `stalled` directly, which keeps the buffering spinner logic in one place
  (plus a 400 ms delay so short stalls don't flash it).
- **One node, two slots.** Theater mode moves the same player element between
  page slots, so the MediaSource and playback survive the move. Focus is
  restored, because moving a node drops it.

## Studying the real player with REA

`scripts/rea-study.sh <url>` starts a throwaway Chrome profile with CDP on
loopback, lets the page play, and runs REA's passive web tools. Each result is
saved to `rea-out/<run>/` (gitignored):

| file | REA command | what to look at |
|---|---|---|
| `page.json` | `inspect-web-page` | network during playback (segment URL patterns, sizes, cadence), JSON response *shapes* (player config), DOM/accessibility tree of the controls, workers, storage key names |
| `bundle.json` | `analyze-web-bundle` | script chunks and import edges, endpoint candidates |
| `listeners-*.json` | `inspect-web-event-listeners` | which source locations handle `<video>` and player-root events |
| `execution.json` | `observe-web-execution` | which functions actually ran while you interacted (seek, open settings…) |
| `scripts/`, `js-graph.json` | `export-web-scripts` → `analyze-javascript-application` | the captured scripts as a static module graph |
| `SUMMARY.md` | `scripts/rea-summary.mjs` | a condensed study sheet of all of the above |

Example:

```bash
./scripts/rea-study.sh "https://www.youtube.com/watch?v=VIDEO_ID"
PLAYER_SELECTOR='#movie_player' PLAY_MS=15000 ./scripts/rea-study.sh "https://www.youtube.com/watch?v=VIDEO_ID"
```

REA only captures exact origins, so YouTube's media traffic (served from
per-server `*.googlevideo.com` hosts) is invisible by default. `npm run
rea:youtube` sets `EXTRA_ORIGIN_PATTERN='googlevideo\.com'`, which reads the
page's own resource list to find those hosts and adds them to the capture.

The run takes the CDP target whose URL matches, plays for `PLAY_MS`, and then
gives you a second `PLAY_MS` window for `observe-web-execution`. Interact with
the player during that window. `PLAYER_SELECTOR` picks the element whose
listeners are dumped (`#player` by default, which is this scaffold's root).
Set `CHROME=` if Chrome isn't found, and `HEADLESS=1` to run without a window.

Questions to answer from a YouTube capture, then compare with this scaffold:

1. How are media requests shaped: one URL per segment, or byte ranges / a
   streaming protocol on one endpoint? Are audio and video separate requests?
   (`page.json` network table)
2. What's in the initial player configuration? (JSON shapes; values are never
   captured, only key paths and types)
3. Which controls exist, and what are their accessible names?
4. Which modules handle `timeupdate`, `seeking` and `waiting`? How many layers
   sit between the `<video>` event and the UI?
5. Does playback use workers? What does the player keep in storage
   (key names only)?

Captured third-party scripts in `rea-out/` are for reading. Keep them out of
the repo, and write anything you build in your own code, as this scaffold does.

## Not built (good next steps)

Real DASH/MPD parsing, DRM/EME, ads/SSAI, live/DVR, an autoplay "up next" card,
a cards/end-screen layer, touch double-tap seek, picture-in-picture,
audio-track/language switching, and `changeType()` for mixed-codec ladders.
