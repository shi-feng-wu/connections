import { useEffect, useState } from "react";

// "Next puzzle in Xh Ym" countdown to the next midnight ET — the same fixed reset the
// daily is keyed to (see etDate() in App.tsx). Display-only: the actual rollover/reload is
// driven by the etDate() poll in App.tsx; this just tells players in every timezone when it
// lands (the reset is mid-afternoon east of ET, so without this it's a mystery).

// Milliseconds until the next midnight America/New_York. Reads the current ET wall-clock via
// Intl (mirrors etDate()'s America/New_York pattern) instead of a hardcoded UTC offset, so it
// stays correct across DST — the browser reports the real ET hour either way. The only artifact
// is a <=1h cosmetic skew on the two DST-transition days, which self-corrects within that day
// and never affects the real reset.
export function msUntilNextEtMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): number =>
    Number(parts.find((p) => p.type === t)?.value);
  let h = get("hour");
  if (h === 24) h = 0; // hour12:false can emit "24" at midnight on some engines
  const secsIntoDay = h * 3600 + get("minute") * 60 + get("second");
  const remMs = (86_400 - secsIntoDay) * 1000 - now.getMilliseconds();
  return remMs <= 0 ? 0 : remMs;
}

// "Xh Ym" above an hour, "Ym" within the hour, "Ss" in the last minute.
export function fmtCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Self-contained 1s ticker: keeps re-renders local to the label (not the App tree) and
// re-reads Intl each tick, so a mid-session clock/timezone change self-corrects. Cleared on
// unmount — the across-midnight puzzle reload remounts it and re-seeds from the fresh value.
export function ResetCountdown({ className = "" }: { className?: string }) {
  const [ms, setMs] = useState(() => msUntilNextEtMidnight());
  useEffect(() => {
    const id = setInterval(() => setMs(msUntilNextEtMidnight()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className={className}>Next puzzle in {fmtCountdown(ms)}</span>;
}
