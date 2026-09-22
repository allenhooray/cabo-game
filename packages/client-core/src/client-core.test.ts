import { afterEach, describe, expect, it, vi } from "vitest";
import { CaboClientCore } from "./client-core.js";

function legacyState() {
  return {
    memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, revision: 0,
    phase: "LOBBY",
    round: 0,
    targetScore: 100,
    currentPlayerId: "",
    caboCallerId: "",
    discardLabel: "",
    discardRank: -1,
    deckCount: 0,
    players: new Map(),
    winners: [],
  };
}

function room(state = legacyState()) {
  return {
    state,
    roomId: "abc123",
    sessionId: "self",
    reconnectionToken: "token",
    send: vi.fn(),
    onStateChange: vi.fn(),
    onMessage: vi.fn(),
    onDrop: vi.fn(),
    onReconnect: vi.fn(),
    onLeave: vi.fn(),
    leave: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("legacy server compatibility", () => {
  it("marks old room listings without names clearly and keeps open rooms joinable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      roomId: "abc123", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 1, maxClients: 4, phase: "LOBBY",
    }]), { status: 200 })));
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice" });

    await expect(core.listRooms()).resolves.toEqual([{
      memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0,
      roomId: "abc123",
      roomName: "Unnamed room",
      targetScore: 100,
      playerCount: 1,
      maxClients: 4,
      phase: "LOBBY",
      isFull: false,
      isStarted: false,
      canJoin: true,
    }]);
  });

  it("preserves explicit join locks and derives old locked rooms as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      roomId: "locked", roomName: "Invite only", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 1, maxClients: 4,
      phase: "LOBBY", isFull: false, isStarted: false, canJoin: false,
    }, {
      roomId: "legacy-locked", locked: true, memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 1, maxClients: 4,
    }]), { status: 200 })));
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice" });

    const [listed, legacyLocked] = await core.listRooms();
    expect(listed?.canJoin).toBe(false);
    expect(listed?.roomName).toBe("Invite only");
    expect(legacyLocked).toMatchObject({ roomName: "Unnamed room", canJoin: false });
  });

  it("keeps legacy full and started rooms disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { roomId: "full", roomName: "   ", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 4, maxClients: 4, phase: "LOBBY" },
      { roomId: "started", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 2, maxClients: 4, phase: "TURN_START" },
    ]), { status: 200 })));
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice" });

    await expect(core.listRooms()).resolves.toEqual([
      {
        roomId: "full", roomName: "Unnamed room", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 4, maxClients: 4,
        phase: "LOBBY", isFull: true, isStarted: false, canJoin: false,
      },
      {
        roomId: "started", roomName: "Unnamed room", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 2, maxClients: 4,
        phase: "TURN_START", isFull: false, isStarted: true, canJoin: false,
      },
    ]);
  });

  it("attaches after create with the shared room-id fallback when an old state has no roomName", async () => {
    const attached = vi.fn();
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice", handlers: { attached } });
    const legacyRoom = room();
    vi.spyOn(core.client, "create").mockResolvedValue(legacyRoom as any);

    await core.create({ memoryMode: "assisted", turnDurationSeconds: 60, visibility: "public", targetScore: 100, roomName: "Game night" });

    expect(attached).toHaveBeenCalledOnce();
    expect(core.state?.roomName).toBe("Room abc123");
    expect((legacyRoom.state as typeof legacyRoom.state & { roomName?: string }).roomName).toBe("Room abc123");
    expect(core.room?.roomId).toBe("abc123");
  });

  it("attaches after join with a room-id fallback when an old state has no roomName", async () => {
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Bob" });
    vi.spyOn(core.client, "joinById").mockResolvedValue(room() as any);

    await core.join("abc123");

    expect(core.state?.roomName).toBe("Room abc123");
    expect(core.room?.roomId).toBe("abc123");
  });
});

describe("room chat transport", () => {
  it("registers the optional chat handler and sends on the independent channel", async () => {
    const chat = vi.fn();
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice", handlers: { chat } });
    const nextRoom = room();
    vi.spyOn(core.client, "joinById").mockResolvedValue(nextRoom as any);

    await core.join("abc123");
    const registration = nextRoom.onMessage.mock.calls.find(([type]) => type === "chat");
    expect(registration).toBeDefined();
    const message = { sequence: 1, playerId: "a", playerName: "Alice", text: "hello", sentAt: 1 };
    registration?.[1](message);
    expect(chat).toHaveBeenCalledWith(message);

    core.sendChat("hello");
    expect(nextRoom.send).toHaveBeenCalledWith("chat", { text: "hello" });
  });

  it("keeps chat optional for older consumers", async () => {
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Alice" });
    const nextRoom = room();
    vi.spyOn(core.client, "joinById").mockResolvedValue(nextRoom as any);
    await core.join("abc123");
    const registration = nextRoom.onMessage.mock.calls.find(([type]) => type === "chat");
    expect(() => registration?.[1]({ sequence: 1 })).not.toThrow();
  });
});
