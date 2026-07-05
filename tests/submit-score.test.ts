import { afterEach, describe, expect, it, vi } from "vitest";
import { submitScore } from "../src/leaderboard";

// The finishing guess commits in the background (App.tsx commitChain), so /api/score can
// replay the record BEFORE that guess lands and answer ok:false "not-finished" — an HTTP 200.
// submitScore used to treat any response as done, silently dropping the score (a lost
// leaderboard row AND a broken streak). These pin the retry contract that closed that hole.

const INPUT = {
  session: "s",
  accessToken: "t",
  guildId: null,
  channelId: null,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("submitScore", () => {
  it("retries a not-finished response until the record lands", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ok: false, reason: "not-finished" }))
      .mockResolvedValueOnce(json({ ok: true, score: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const done = submitScore(INPUT);
    await vi.runAllTimersAsync(); // flush the backoff sleep(s)
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a success immediately and other ok:false reasons as final", async () => {
    const accepted = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal("fetch", accepted);
    await submitScore(INPUT);
    expect(accepted).toHaveBeenCalledTimes(1);

    // "not-daily" (practice/yesterday) is a real verdict, not a race — no retry.
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(json({ ok: false, reason: "not-daily" }));
    vi.stubGlobal("fetch", rejected);
    await submitScore(INPUT);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("gives up after bounded retries instead of looping", async () => {
    vi.useFakeTimers();
    const never = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: false, reason: "not-finished" }));
    vi.stubGlobal("fetch", never);

    const done = submitScore(INPUT);
    await vi.runAllTimersAsync();
    await done;

    expect(never).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});
