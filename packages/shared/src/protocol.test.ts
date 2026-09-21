import { describe, expect, it } from "vitest";
import { agentRequestSchema, roomNameSchema, roomOptionsSchema } from "./protocol.js";

describe("room names", () => {
  it("accepts omitted, blank, duplicate-looking, Unicode, and control-character names", () => {
    expect(roomOptionsSchema.parse({ name: "Alice" }).roomName).toBeUndefined();
    expect(roomOptionsSchema.parse({ name: "Alice", roomName: "   " }).roomName).toBe("   ");
    expect(roomNameSchema.safeParse("中".repeat(40)).success).toBe(true);
    expect(roomNameSchema.safeParse("😀".repeat(40)).success).toBe(true);
    expect(roomNameSchema.safeParse("quiet\u001broom").success).toBe(true);
    expect(roomNameSchema.safeParse("same room").success).toBe(true);
  });

  it("counts Unicode code points after trimming and rejects names over 40", () => {
    expect(roomNameSchema.safeParse(`  ${"😀".repeat(40)}  `).success).toBe(true);
    expect(roomNameSchema.safeParse("中".repeat(41)).success).toBe(false);
    expect(roomNameSchema.safeParse("😀".repeat(41)).success).toBe(false);
  });

  it("accepts roomName on strict agent create requests", () => {
    expect(agentRequestSchema.parse({ id: "1", type: "create", visibility: "public", targetScore: 100, roomName: "Friends" }))
      .toMatchObject({ roomName: "Friends" });
  });
});
