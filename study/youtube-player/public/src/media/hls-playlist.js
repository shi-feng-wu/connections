// Parses an HLS *media* playlist (one rendition) into an init segment plus a
// timeline of media segments. Only the tags ffmpeg's VOD fMP4 output uses are
// handled; this is a study scaffold, not a general HLS client.
export function parseMediaPlaylist(text, baseUrl) {
  const segments = [];
  let initUrl = null;
  let pendingDuration = null;
  let t = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      initUrl = new URL(/URI="([^"]+)"/.exec(line)[1], baseUrl).href;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length));
    } else if (!line.startsWith('#') && pendingDuration != null) {
      segments.push({ index: segments.length, start: t, end: t + pendingDuration, url: new URL(line, baseUrl).href });
      t += pendingDuration;
      pendingDuration = null;
    }
  }
  if (!initUrl) throw new Error('playlist has no EXT-X-MAP init segment');
  return { initUrl, segments, duration: t };
}

/** Index of the segment covering `time` (clamped to the last segment). */
export function segmentIndexAt(segments, time) {
  const i = segments.findIndex((s) => time < s.end);
  return i === -1 ? segments.length - 1 : i;
}
