// Segment fetcher with an optional simulated bandwidth cap, so ABR behaviour
// can be studied against a local server that is otherwise infinitely fast.
// The cap is enforced by delaying the response until bytes/elapsed <= cap.
export const network = { capKbps: Number(new URLSearchParams(location.search).get('bw')) || 0 };

export async function fetchBytes(url, { signal, onSample } = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = await res.arrayBuffer();

  if (network.capKbps > 0) {
    const minMs = (buf.byteLength * 8) / network.capKbps; // bits / (kbit/s) = ms
    const wait = minMs - (performance.now() - t0);
    if (wait > 0) await sleep(wait, signal);
  }
  onSample?.(buf.byteLength, performance.now() - t0);
  return buf;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(signal.reason);
    });
  });
}
