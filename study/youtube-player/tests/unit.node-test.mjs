// Unit tests for the DOM-free modules (node:test; named so the repo-root vitest run skips it). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaPlaylist, segmentIndexAt } from '../public/src/media/hls-playlist.js';
import { chooseRendition } from '../public/src/media/abr.js';
import { BandwidthEstimator } from '../public/src/media/bandwidth.js';
import { parseVtt } from '../public/src/features/captions.js';
import { formatTime } from '../public/src/core/format.js';

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
seg000.m4s
#EXTINF:4.000000,
seg001.m4s
#EXTINF:2.500000,
seg002.m4s
#EXT-X-ENDLIST`;

test('parses an fMP4 media playlist into a timeline', () => {
  const pl = parseMediaPlaylist(PLAYLIST, 'http://h/v/240p/index.m3u8');
  assert.equal(pl.initUrl, 'http://h/v/240p/init.mp4');
  assert.equal(pl.segments.length, 3);
  assert.deepEqual(pl.segments[2], { index: 2, start: 8, end: 10.5, url: 'http://h/v/240p/seg002.m4s' });
  assert.equal(pl.duration, 10.5);
  assert.equal(segmentIndexAt(pl.segments, 0), 0);
  assert.equal(segmentIndexAt(pl.segments, 4), 1);
  assert.equal(segmentIndexAt(pl.segments, 99), 2);
});

const R = [
  { label: '240p', height: 240, bandwidth: 250_000 },
  { label: '480p', height: 480, bandwidth: 700_000 },
  { label: '720p', height: 720, bandwidth: 1_500_000 },
];

test('ABR picks the best rendition the budget and viewport allow', () => {
  assert.equal(chooseRendition(R, { bandwidthBps: 10e6, bufferAhead: 10, viewportHeight: 1080 }), 2);
  assert.equal(chooseRendition(R, { bandwidthBps: 10e6, bufferAhead: 10, viewportHeight: 300 }), 1, 'size cap');
  assert.equal(chooseRendition(R, { bandwidthBps: 1e6, bufferAhead: 10, viewportHeight: 1080 }), 1);
  assert.equal(chooseRendition(R, { bandwidthBps: 1e6, bufferAhead: 2, viewportHeight: 1080 }), 0, 'thin buffer');
  assert.equal(chooseRendition(R, { bandwidthBps: 100e3, bufferAhead: 10, viewportHeight: 1080 }), 0, 'floor');
});

test('ABR upswitch needs headroom', () => {
  // 0.75 * 2.1M = 1.575M budget: 720p fits, but not with 20% headroom.
  assert.equal(chooseRendition(R, { bandwidthBps: 2.1e6, bufferAhead: 10, viewportHeight: 1080, current: 1 }), 1);
  assert.equal(chooseRendition(R, { bandwidthBps: 2.1e6, bufferAhead: 10, viewportHeight: 1080 }), 2);
});

test('bandwidth estimate follows samples and reacts to drops', () => {
  const bw = new BandwidthEstimator();
  assert.equal(bw.estimate(), 1_000_000);
  for (let i = 0; i < 5; i++) bw.sample(500_000, 1000); // 4 Mbps
  assert.ok(Math.abs(bw.estimate() - 4e6) < 1, String(bw.estimate()));
  bw.sample(100_000, 1000); // 0.8 Mbps
  assert.ok(bw.estimate() < 3e6);
  bw.sample(100, 1); // too small to count
  assert.equal(bw.samples, 6);
});

test('parses WebVTT cues', () => {
  const cues = parseVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500 align:start\nHello <b>there</b>\nline 2\n\n01:00.000 --> 01:01.000\nshort form');
  assert.deepEqual(cues, [
    { start: 1, end: 2.5, text: 'Hello there\nline 2' },
    { start: 60, end: 61, text: 'short form' },
  ]);
});

test('formats times like the player clock', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
});
