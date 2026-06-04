import { useLayoutEffect, useRef, type ReactNode } from "react";

// FLIP reorder: a flex column whose keyed children — each tagged data-flip-row="<id>" —
// slide from their previous slot to their new one whenever the order changes (a player
// passing another on the live roster, or the leaderboard reshuffling on a refetch).
//
// We measure offsetTop (NOT getBoundingClientRect) so the delta is scroll-independent —
// scrolling the list never fakes a slide. `relative` makes this the rows' offsetParent so
// those offsets are measured against the scroll content. The glide easing matches the
// board's tile-gather and the tab fade, keeping reorder motion in the same family.
//
// prevTops lives on the instance, so it resets when this remounts — callers key it by the
// active tab, so a tab swap fades in fresh (no slide) while in-place updates animate.
const GLIDE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

export function FlipList({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevTops = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const rows = container.querySelectorAll<HTMLElement>("[data-flip-row]");
    const seen = new Set<string>();
    rows.forEach((el) => {
      const id = el.dataset.flipRow;
      if (!id) return;
      seen.add(id);
      const top = el.offsetTop;
      const prev = prevTops.current.get(id);
      prevTops.current.set(id, top);
      // First sighting (mount or a freshly added row) just appears — no slide. Motion-
      // sensitive users get the instant snap too.
      if (prev == null || prev === top || reduce) return;
      el.animate(
        [{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }],
        { duration: 360, easing: GLIDE },
      );
    });
    // drop rows that left so a returning id reads as a fresh appearance, not a slide
    for (const id of [...prevTops.current.keys()])
      if (!seen.has(id)) prevTops.current.delete(id);
  });

  return (
    <div ref={ref} className={"relative " + className}>
      {children}
    </div>
  );
}
