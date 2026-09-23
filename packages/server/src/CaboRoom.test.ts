import { describe, expect, it, vi } from "vitest";
import type { Client } from "colyseus";
import { CaboRoom } from "./CaboRoom.js";
import { PlayerState } from "./state.js";

describe("managed Bot admission", () => {
  function roomWithHost() {
    const room = new CaboRoom();
    room.state.players.set("host", new PlayerState().assign({ id: "host", name: "Host", seat: 0, isHost: true }));
    const internal = room as unknown as { hostId: string; handleBotCommand(client: Client, payload: unknown): Promise<void>; validateJoin(payload: unknown): unknown };
    internal.hostId = "host";
    return { room, internal, host: { sessionId: "host", send: vi.fn() } as unknown as Client };
  }

  it("rejects forged credentials and reserves capacity for a pending Bot", () => {
    const { room, internal } = roomWithHost();
    expect(() => internal.validateJoin({ name: "Fake", botToken: "forged" })).toThrow("INVALID_BOT_TOKEN");
    const pending = room as unknown as { pendingBots: Map<string, unknown> };
    pending.pendingBots.set("token", { persona: "abacus", name: "Bot" });
    for (let seat = 1; seat < 4; seat++) room.state.players.set(`human-${seat}`, new PlayerState().assign({ id: `human-${seat}`, name: `Human-${seat}`, seat }));
    expect(() => internal.validateJoin({ name: "Late" })).toThrow("ROOM_FULL");
    expect(() => internal.validateJoin({ name: "Bot", botToken: "token" })).not.toThrow();
  });

  it("allows only the host and enforces four Bots before launching a worker", async () => {
    const { room, internal, host } = roomWithHost();
    const guest = { sessionId: "guest", send: vi.fn() } as unknown as Client;
    await internal.handleBotCommand(guest, { id: "guest-1", command: { type: "invite-bot", persona: "abacus" } });
    expect(guest.send).toHaveBeenCalledWith("bot-result", expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "NOT_HOST" }) }));
    for (let seat = 1; seat <= 4; seat++) room.state.players.set(`bot-${seat}`, new PlayerState().assign({ id: `bot-${seat}`, name: `Bot-${seat}`, seat, isBot: true }));
    await internal.handleBotCommand(host, { id: "host-1", command: { type: "invite-bot", persona: "abacus" } });
    expect(host.send).toHaveBeenCalledWith("bot-result", expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "BOT_LIMIT" }) }));
  });
});

describe("agent command acknowledgements", () => {
  it("keeps the legacy command channel and returns the committed revision", () => {
    const room = new CaboRoom();
    const send = vi.fn();
    const client = { sessionId: "a", send } as unknown as Client;
    const internals = room as unknown as {
      runCommand: (client: Client, command: unknown) => void;
      handleAgentCommand: (client: Client, payload: unknown) => void;
      bumpRevision: () => void;
    };
    internals.runCommand = () => internals.bumpRevision();
    internals.handleAgentCommand(client, { id: "x", command: { type: "start" } });
    expect(send).toHaveBeenCalledWith("agent-result", { id: "x", ok: true, revision: 1 });
    expect(room.messages.command).toBeTypeOf("function");
  });

  it("returns structured errors without changing revision", () => {
    const room = new CaboRoom();
    const send = vi.fn();
    const client = { sessionId: "a", send } as unknown as Client;
    const internals = room as unknown as { handleAgentCommand: (client: Client, payload: unknown) => void };
    internals.handleAgentCommand(client, { id: "bad", command: { type: "replace", position: 9 } });
    expect(send).toHaveBeenCalledWith("agent-result", expect.objectContaining({
      id: "bad", ok: false, revision: 0, error: expect.objectContaining({ code: "INVALID_COMMAND" }),
    }));
  });
});

describe("interactive command compatibility", () => {
  it("rejects a missing replacement position", () => {
    const room = new CaboRoom();
    const client = { sessionId: "a", send: vi.fn() } as unknown as Client;
    const internals = room as unknown as {
      handleCommand(client: Client, payload: unknown): void;
      runCommand(client: Client, command: unknown): void;
    };
    const runCommand = vi.fn();
    internals.runCommand = runCommand;

    internals.handleCommand(client, { type: "replace", positions: [2] });

    expect(runCommand).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith("error", expect.objectContaining({ code: "INVALID_COMMAND" }));
  });
});

describe("room chat", () => {
  function chatRoom() {
    const room = new CaboRoom();
    room.state.players.set("a", new PlayerState().assign({ id: "a", name: "Alice", connected: true }));
    room.state.players.set("b", new PlayerState().assign({ id: "b", name: "Bob", connected: true }));
    const broadcast = vi.fn();
    const internals = room as unknown as {
      broadcast(type: string, payload: unknown): void;
      handleChat(client: Client, payload: unknown): void;
    };
    internals.broadcast = broadcast;
    return { room, internals, broadcast, client: { sessionId: "a", send: vi.fn() } as unknown as Client };
  }

  it("broadcasts authoritative identity without changing revision", () => {
    const { room, internals, broadcast, client } = chatRoom();
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    internals.handleChat(client, { text: "  hello 👋  " });
    expect(broadcast).toHaveBeenCalledWith("chat", {
      sequence: 1, playerId: "a", playerName: "Alice", text: "hello 👋", sentAt: 1234,
    });
    expect(room.state.revision).toBe(0);
    now.mockRestore();
  });

  it("rejects invalid messages without consuming rate-limit capacity", () => {
    const { internals, broadcast, client } = chatRoom();
    const send = client.send as ReturnType<typeof vi.fn>;
    internals.handleChat(client, { text: "bad\nline" });
    expect(send).toHaveBeenCalledWith("error", expect.objectContaining({ code: "INVALID_CHAT_MESSAGE" }));
    for (const text of ["one", "two", "three"]) internals.handleChat(client, { text });
    expect(broadcast).toHaveBeenCalledTimes(3);
  });

  it("allows three-message bursts, limits the fourth, and refills over time", () => {
    const { internals, broadcast, client } = chatRoom();
    const send = client.send as ReturnType<typeof vi.fn>;
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    for (const text of ["one", "two", "three", "four"]) internals.handleChat(client, { text });
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith("error", expect.objectContaining({ code: "CHAT_RATE_LIMITED" }));
    now.mockReturnValue(11_000);
    internals.handleChat(client, { text: "five" });
    expect(broadcast).toHaveBeenCalledTimes(4);
    now.mockRestore();
  });
});

describe("round history synchronization", () => {
  it("records each completed round once in authoritative room state", () => {
    const room = new CaboRoom();
    const internals = room as unknown as {
      engine: { round: number };
      recordRoundResult(event: unknown): void;
    };
    internals.engine = { round: 2 };
    const result = {
      type: "round-result",
      hands: [{ playerId: "a", cards: [{ id: "c1", label: "4H", rank: 4 }], handScore: 4 }],
      roundScores: { a: 9 },
      totals: { a: 13 },
      outcome: { type: "cabo", callerId: "a", succeeded: false },
    };

    internals.recordRoundResult(result);
    internals.recordRoundResult(result);

    expect(room.state.roundHistory).toHaveLength(1);
    expect(room.state.roundHistory[0]).toMatchObject({
      round: 2,
      outcomeType: "cabo",
      outcomePlayerId: "a",
      caboSucceeded: false,
    });
    expect(room.state.roundHistory[0]?.players[0]).toMatchObject({
      playerId: "a",
      roundScore: 9,
      totalScore: 13,
      handScore: 4,
    });
    expect(room.state.roundHistory[0]?.players[0]?.cards[0]).toMatchObject({ label: "4H", rank: 4 });
  });
});

describe("next round confirmations", () => {
  function waitingRoom() {
    const room = new CaboRoom();
    room.state.phase = "ROUND_RESULT";
    room.state.round = 1;
    room.state.players.set("a", new PlayerState().assign({ id: "a", name: "Alice", connected: true }));
    room.state.players.set("b", new PlayerState().assign({ id: "b", name: "Bob", connected: false }));
    const engine = {
      phase: "ROUND_RESULT",
      startNextRound: vi.fn(() => {
        engine.phase = "TURN_START";
        return [];
      }),
      getSnapshot: () => ({
        phase: engine.phase,
        round: 2,
        targetScore: 100,
        mismatchPenaltyCardPending: false,
        deckCount: 43,
        players: [...room.state.players.values()].map((player, seat) => ({
          id: player.id, name: player.name, seat, score: player.score, forfeited: player.forfeited, cardCount: 4,
        })),
        winners: [],
      }),
    };
    const internals = room as unknown as {
      engine: typeof engine;
      readyNextRound(playerId: string): void;
      startNextRoundIfReady(): void;
      sendAllKnowledge(): void;
      syncFromEngine(): void;
      dispatch(events: unknown[]): void;
    };
    internals.engine = engine;
    internals.sendAllKnowledge = vi.fn();
    internals.syncFromEngine = vi.fn();
    internals.dispatch = vi.fn();
    return { room, engine, internals };
  }

  it("waits for every active player, including disconnected players, and ignores duplicate confirmations", () => {
    const { room, engine, internals } = waitingRoom();
    internals.readyNextRound("a");
    const revision = room.state.revision;
    internals.readyNextRound("a");

    expect(room.state.players.get("a")?.nextRoundReady).toBe(true);
    expect(room.state.revision).toBe(revision);
    expect(engine.startNextRound).not.toHaveBeenCalled();

    internals.readyNextRound("b");
    expect(engine.startNextRound).toHaveBeenCalledOnce();
    expect([...room.state.players.values()].every((player) => !player.nextRoundReady)).toBe(true);
  });

  it("re-evaluates readiness after an unready player forfeits", () => {
    const { room, engine, internals } = waitingRoom();
    room.state.players.set("c", new PlayerState().assign({ id: "c", name: "Cara", connected: false }));
    room.state.players.get("a")!.nextRoundReady = true;
    room.state.players.get("b")!.nextRoundReady = true;
    room.state.players.get("c")!.forfeited = true;

    internals.startNextRoundIfReady();

    expect(engine.startNextRound).toHaveBeenCalledOnce();
  });

  it("never accepts confirmations after the match has ended", () => {
    const { room, engine, internals } = waitingRoom();
    room.state.phase = "MATCH_RESULT";
    engine.phase = "MATCH_RESULT";

    expect(() => internals.readyNextRound("a")).toThrow("not waiting for confirmations");
    expect(engine.startNextRound).not.toHaveBeenCalled();
  });
});

describe("room names", () => {
  it("allows five seats", () => {
    expect(new CaboRoom().maxClients).toBe(5);
  });

  it("normalizes custom names and stores the same value in state and metadata", async () => {
    const room = new CaboRoom();
    const setMetadata = vi.fn(async () => undefined);
    const internals = room as unknown as {
      onCreate(options: unknown): Promise<void>;
      setPrivate(value: boolean): Promise<void>;
      setMetadata(value: unknown): Promise<void>;
    };
    internals.setPrivate = vi.fn(async () => undefined);
    internals.setMetadata = setMetadata;

    await internals.onCreate({ name: "Alice", memoryMode: "assisted", turnDurationSeconds: 60, visibility: "public", targetScore: 100, roomName: "  Game night  " });

    expect(room.state.roomName).toBe("Game night");
    expect(setMetadata).toHaveBeenLastCalledWith(expect.objectContaining({ roomName: "Game night" }));
  });

  it("uses the creator name when the requested room name is blank", async () => {
    const room = new CaboRoom();
    const internals = room as unknown as {
      onCreate(options: unknown): Promise<void>;
      setPrivate(value: boolean): Promise<void>;
      setMetadata(value: unknown): Promise<void>;
    };
    internals.setPrivate = vi.fn(async () => undefined);
    internals.setMetadata = vi.fn(async () => undefined);

    await internals.onCreate({ name: "Alice", memoryMode: "assisted", turnDurationSeconds: 60, visibility: "public", targetScore: 100, roomName: "  " });

    expect(room.state.roomName).toBe("Alice's room");
  });
});
