// TEMPORARY de-risk probe (delete after). Streams an SSE event every second for ~12s. Opened
// same-origin from inside the Activity, it answers the one question that decides the relay's
// transport: does Discord's proxy pass a long-lived streaming HTTP response, or does it buffer/
// cut it? If the client logs ticks arriving ~1s apart over 12s → streaming works (SSE viable for
// the relay). If they all arrive at once at ~12s → buffered (use long-polling instead). If it
// errors early at N seconds → that N is the proxy's hold limit (sets the long-poll window).
//
// Edge runtime streams natively (Node functions buffer), so this is the fair test of the proxy.
export const config = { runtime: 'edge' };

export default function handler(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: string): void => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      send(`open ${Date.now()}`);
      let n = 0;
      const id = setInterval(() => {
        n += 1;
        send(`tick ${n} ${Date.now()}`);
        if (n >= 12) {
          clearInterval(id);
          controller.close();
        }
      }, 1000);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
