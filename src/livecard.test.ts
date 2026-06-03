import { describe, expect, it } from "vitest";
import { botCardUrl, cardPayload } from "../api/_livecard";

// api/_livecard.ts: the room card is a bot message. On create it replies to the
// launcher's "<user> used /connections" message (message_reference); edits address the
// stored message id. These helpers shape the Discord REST request.
describe("cardPayload", () => {
  it("is a plain message with no message_reference when not replying", () => {
    const p = cardPayload() as { message_reference?: unknown };
    expect(p.message_reference).toBeUndefined();
  });

  it("replies to the launch message when given a reference", () => {
    const p = cardPayload({ messageId: "111", channelId: "222" }) as {
      message_reference?: { message_id: string; channel_id: string; fail_if_not_exists: boolean };
    };
    expect(p.message_reference).toEqual({ message_id: "111", channel_id: "222", fail_if_not_exists: false });
  });
});

describe("botCardUrl", () => {
  it("targets the channel for a create (POST)", () => {
    expect(botCardUrl("222")).toBe("https://discord.com/api/v10/channels/222/messages");
  });

  it("targets the message for an edit (PATCH)", () => {
    expect(botCardUrl("222", "111")).toBe("https://discord.com/api/v10/channels/222/messages/111");
  });
});
