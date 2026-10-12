// Simple generic icons drawn on a 24x24 grid.
const path = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

export const icons = {
  play: path('M8 5v14l11-7z'),
  pause: path('M7 5h4v14H7zM13 5h4v14h-4z'),
  replay: path('M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z'),
  next: path('M6 6l8.5 6L6 18zM16 6h2v12h-2z'),
  volumeHigh: path('M4 9v6h4l5 5V4L8 9zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z'),
  volumeLow: path('M4 9v6h4l5 5V4L8 9zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z'),
  volumeMuted: path('M4 9v6h4l5 5V4L8 9zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z'),
  captions: path('M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm2 5v4a1 1 0 0 0 1 1h3v-1.5H7.5v-3H10V9H7a1 1 0 0 0-1 1zm7 0v4a1 1 0 0 0 1 1h3v-1.5h-2.5v-3H17V9h-3a1 1 0 0 0-1 1z'),
  settings: path('M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.7a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z'),
  miniplayer: path('M3 5h18v14H3zm2 2v10h14V7zm6 5h7v4h-7z'),
  theater: path('M2 7h20v10H2zm2 2v6h16V9z'),
  theaterExit: path('M5 6h14v12H5zm2 2v8h10V8z'),
  fullscreen: path('M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z'),
  fullscreenExit: path('M8 4h2v6H4V8h4zm6 0h2v4h4v2h-6zM4 14h6v6H8v-4H4zm10 0h6v2h-4v4h-2z'),
  back: path('M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z'),
  chevron: path('M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z'),
  check: path('M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'),
};
