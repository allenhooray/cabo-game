import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL_VERSION, agentRequestSchema, roomNameSchema, roomOptionsSchema } from "./protocol.js";

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

describe("agent protocol v6", () => {
  it("uses multi-position replacement commands and rejects the v3 shape", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(6);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "replace", positions: [1, 3], replacementPosition: 3 } }).success).toBe(true);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "replace", position: 1 } }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "draw-discard", position: 1 } }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "draw-discard" } }).success).toBe(true);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "resolve-mismatch", drawnPlacement: "left", penaltyPlacement: "right" } }).success).toBe(true);
    expect(agentRequestSchema.safeParse({ id: "1", type: "action", action: { type: "ready-next-round" } }).success).toBe(true);
  });
});
