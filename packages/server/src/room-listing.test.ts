import { describe, expect, it } from "vitest";
import { toPublicRoomListing } from "./room-listing.js";

describe("public room listings", () => {
  const source = (overrides: Record<string, unknown> = {}) => ({
    roomId: "room-1",
    locked: false,
    metadata: { memoryMode: "assisted" as const, turnDurationSeconds: 60 as const, visibility: "public", roomName: "Friday", phase: "LOBBY", targetScore: 100, playerCount: 1, maxClients: 5 },
    ...overrides,
  });

  it("includes waiting, full, started, and locked public rooms with joinability", () => {
    expect(toPublicRoomListing(source())).toMatchObject({ isFull: false, isStarted: false, canJoin: true });
    expect(toPublicRoomListing(source({ metadata: { ...source().metadata, playerCount: 5 } }))).toMatchObject({ isFull: true, isStarted: false, canJoin: false });
    expect(toPublicRoomListing(source({ metadata: { ...source().metadata, phase: "TURN_START" } }))).toMatchObject({ isFull: false, isStarted: true, canJoin: false });
    expect(toPublicRoomListing(source({ locked: true }))).toMatchObject({ isFull: false, isStarted: false, canJoin: false });
  });

  it("excludes private rooms", () => {
    expect(toPublicRoomListing(source({ metadata: { ...source().metadata, visibility: "private" } }))).toBeUndefined();
  });
});
