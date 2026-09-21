import { describe, expect, it } from "vitest";
import { roomChatInputSchema } from "./room-chat.js";

describe("room chat input", () => {
  it("trims ordinary whitespace and keeps Unicode text", () => {
    expect(roomChatInputSchema.parse({ text: "  你好 👋  " })).toEqual({ text: "你好 👋" });
  });

  it("counts Unicode code points", () => {
    expect(roomChatInputSchema.safeParse({ text: "😀".repeat(200) }).success).toBe(true);
    expect(roomChatInputSchema.safeParse({ text: "😀".repeat(201) }).success).toBe(false);
  });

  it("rejects empty and control-character messages before trimming", () => {
    for (const text of ["", "   ", "hello\nthere", "hello\tthere", "\u001b[2J", "a\u0085b"]) {
      expect(roomChatInputSchema.safeParse({ text }).success).toBe(false);
    }
  });

  it("rejects unknown identity fields", () => {
    expect(roomChatInputSchema.safeParse({ text: "hello", playerId: "forged" }).success).toBe(false);
  });
});
