// Dev-only harness component (used solely by src/preview.tsx, so it's excluded from the
// prod bundle): renders a Discord MessageData payload as Discord would — the bot's avatar +
// name + APP badge, the markdown body, link buttons, the ephemeral "Only you can see this"
// footer, and the Components V2 /share card. The payloads come straight from
// src/discord-messages.ts — the SAME builders the live webhook (api/interactions.ts) sends —
// so this preview is the real message text/structure, not a mock that can drift.
import type { ReactNode } from "react";
import { EPHEMERAL, IS_COMPONENTS_V2, type MessageData } from "./discord-messages";

// Discord dark-theme palette (2024+ "onyx"): the values Discord paints chat with, so the
// preview reads like a real channel rather than an approximation.
const C = {
  chat: "#313338",
  name: "#f2f3f5",
  body: "#dbdee1",
  muted: "#949ba4",
  heading: "#f2f3f5",
  codeBg: "#1e1f22",
  badge: "#5865f2",
  link: "#00a8fc",
  btn: "#4e5058",
  containerBg: "#2b2d31",
  containerBorder: "#3f4147",
  divider: "#3f4147",
};

// Inline markdown within a line: **bold** and `code` (the only inline marks these messages
// use). Everything else — emoji, arrows, the · separators — is literal text.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      out.push(
        <strong key={i++} style={{ fontWeight: 700, color: C.name }}>
          {m[1]}
        </strong>,
      );
    } else {
      out.push(
        <code
          key={i++}
          style={{
            background: C.codeBg,
            borderRadius: 4,
            padding: "1px 4px",
            fontSize: "0.85em",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          }}
        >
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Block-level markdown: ### headings, -# subtext, "- " bullets, "> " blockquotes, blank-line
// spacing. Mirrors the small subset Discord renders for the bot's messages.
function Markdown({ content }: { content: string }): ReactNode {
  // Group consecutive "> " lines so a multi-line quote draws ONE inset bar, like Discord.
  const blocks: Array<{ quote: string[] } | { line: string }> = [];
  for (const line of content.split("\n")) {
    const last = blocks[blocks.length - 1];
    if (line.startsWith("> ") || line === ">") {
      const text = line === ">" ? "" : line.slice(2);
      if (last && "quote" in last) last.quote.push(text);
      else blocks.push({ quote: [text] });
    } else {
      blocks.push({ line });
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {blocks.map((block, idx) => {
        if ("quote" in block)
          return (
            <div key={idx} style={{ display: "flex", gap: 10 }}>
              <span
                style={{ width: 4, borderRadius: 2, background: C.btn, flexShrink: 0 }}
                aria-hidden
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {block.quote.map((q, qi) =>
                  q === "" ? (
                    <div key={qi} style={{ height: 8 }} aria-hidden />
                  ) : (
                    <div key={qi} style={{ lineHeight: 1.4 }}>
                      {inline(q)}
                    </div>
                  ),
                )}
              </div>
            </div>
          );
        const line = block.line;
        if (line === "") return <div key={idx} style={{ height: 8 }} aria-hidden />;
        if (line.startsWith("### "))
          return (
            <div
              key={idx}
              style={{
                color: C.heading,
                fontWeight: 700,
                fontSize: 16,
                lineHeight: 1.35,
                marginTop: idx === 0 ? 0 : 4,
              }}
            >
              {inline(line.slice(4))}
            </div>
          );
        if (line.startsWith("-# "))
          return (
            <div
              key={idx}
              style={{ color: C.muted, fontSize: 12.5, lineHeight: 1.35 }}
            >
              {inline(line.slice(3))}
            </div>
          );
        if (line.startsWith("- "))
          return (
            <div
              key={idx}
              style={{ display: "flex", gap: 8, lineHeight: 1.4 }}
            >
              <span style={{ color: C.muted }}>•</span>
              <span>{inline(line.slice(2))}</span>
            </div>
          );
        return (
          <div key={idx} style={{ lineHeight: 1.4 }}>
            {inline(line)}
          </div>
        );
      })}
    </div>
  );
}

type Button = { style?: number; label?: string; url?: string; emoji?: { name?: string } };
type ActionRow = { components?: Button[] };

// Link buttons (style 5) — Discord renders them as a gray secondary button with the label
// and a small "open in new tab" glyph. The buttons here are all link buttons.
function Buttons({ rows }: { rows: ActionRow[] }): ReactNode {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
      {rows.flatMap((row, r) =>
        (row.components ?? []).map((b, c) => (
          <span
            key={`${r}-${c}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: C.btn,
              color: "#fff",
              fontSize: 14,
              fontWeight: 500,
              borderRadius: 8,
              padding: "8px 16px",
            }}
          >
            {b.emoji?.name && <span>{b.emoji.name}</span>}
            {b.label}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M14 5h5v5M19 5l-9 9M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )),
      )}
    </div>
  );
}

type V2Block = { type: number; content?: string; divider?: boolean };
type V2Container = { type: number; components?: V2Block[] };

// A Components V2 card (the /share result, the reply DM): a bordered Container (Wordle-style
// frame, no embed accent stripe) holding text blocks (TextDisplay=10, full markdown) and
// separators (Separator=14; divider:true draws a hairline).
function V2Card({ container }: { container: V2Container }): ReactNode {
  return (
    <div
      style={{
        background: C.containerBg,
        border: `1px solid ${C.containerBorder}`,
        borderRadius: 8,
        padding: "14px 16px",
        maxWidth: 420,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {(container.components ?? []).map((b, idx) => {
        if (b.type === 14)
          return b.divider ? (
            <hr
              key={idx}
              style={{
                border: "none",
                borderTop: `1px solid ${C.divider}`,
                margin: "6px 0",
              }}
            />
          ) : (
            <div key={idx} style={{ height: 6 }} aria-hidden />
          );
        return (
          <div key={idx}>
            <Markdown content={b.content ?? ""} />
          </div>
        );
      })}
    </div>
  );
}

// One Discord message: the bot identity row, the body (markdown + buttons, or the V2 card),
// and the ephemeral footer when the EPHEMERAL flag is set.
export function DiscordMessage({
  label,
  payload,
}: {
  label: string;
  payload: MessageData;
}): ReactNode {
  const flags = payload.flags ?? 0;
  const ephemeral = (flags & EPHEMERAL) !== 0;
  const isV2 = (flags & IS_COMPONENTS_V2) !== 0;
  const container = isV2
    ? (payload.components?.[0] as V2Container | undefined)
    : undefined;
  const rows = (payload.components ?? []) as ActionRow[];

  return (
    <section className="w-full max-w-[640px] px-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-amber-400">
        {label}
        {ephemeral ? " · ephemeral" : " · public"}
      </div>
      <div
        style={{
          background: C.chat,
          color: C.body,
          borderRadius: 8,
          padding: "16px 16px 16px 12px",
          fontFamily:
            'system-ui, "gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
          fontSize: 15,
        }}
      >
        <div style={{ display: "flex", gap: 14 }}>
          <img
            src="/connections-icon.png"
            alt=""
            width={40}
            height={40}
            // alignSelf keeps the flex row from stretching the avatar into a tall ellipse.
            style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover", alignSelf: "flex-start" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: C.name, fontWeight: 600, fontSize: 15 }}>
                Connections
              </span>
              <span
                style={{
                  background: C.badge,
                  color: "#fff",
                  fontSize: 10,
                  fontWeight: 600,
                  lineHeight: 1,
                  borderRadius: 4,
                  padding: "3px 4px",
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                App
              </span>
              <span style={{ color: C.muted, fontSize: 12 }}>Today at 4:21 PM</span>
            </div>
            <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 8 }}>
              {container ? (
                <V2Card container={container} />
              ) : (
                <>
                  {payload.content && <Markdown content={payload.content} />}
                  {rows.length > 0 && <Buttons rows={rows} />}
                </>
              )}
              {ephemeral && (
                <div style={{ marginTop: 4, fontSize: 12.5, color: C.muted }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }}
                    aria-hidden
                  >
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                    <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Only you can see this ·{" "}
                  <span style={{ color: C.link }}>Dismiss message</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
