// Adaptive bitrate decision. Inputs: throughput estimate, how much is already
// buffered, and how large the player is on screen. Output: a rendition index.
//
// Rules (deliberately simple and readable):
//  1. Never pick a rendition taller than the player's on-screen pixel height
//     (times devicePixelRatio) one step up — no 720p into a 240px miniplayer.
//  2. Spend at most `safety` of the estimated bandwidth.
//  3. With a thin buffer, be more conservative; with a deep buffer, allow a
//     step up a little more eagerly.
//  4. Hysteresis: only switch up if the new choice is sustainable for a while.
export function chooseRendition(renditions, { bandwidthBps, bufferAhead, viewportHeight, current }) {
  const safety = bufferAhead < 5 ? 0.5 : bufferAhead > 20 ? 0.9 : 0.75;
  const budget = bandwidthBps * safety;

  const sizeCap = renditions.findIndex((r) => r.height >= viewportHeight);
  const maxBySize = sizeCap === -1 ? renditions.length - 1 : sizeCap;

  let pick = 0;
  for (let i = 0; i <= maxBySize; i++) {
    if (renditions[i].bandwidth <= budget) pick = i;
  }

  // Upswitch hysteresis: require 20% headroom above the target's bitrate.
  if (current != null && pick > current && renditions[pick].bandwidth * 1.2 > budget) {
    pick = Math.max(current, pick - 1);
  }
  return pick;
}
