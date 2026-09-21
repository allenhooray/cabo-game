import { describe, expect, it, vi } from "vitest";
import type { Client } from "colyseus";
import { CaboRoom } from "./CaboRoom.js";
import { PlayerState } from "./state.js";

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
  it("defaults a missing replacement position to the first selected position", () => {
    const room = new CaboRoom();
    const client = { sessionId: "a", send: vi.fn() } as unknown as Client;
    const internals = room as unknown as {
      handleCommand(client: Client, payload: unknown): void;
      runCommand(client: Client, command: unknown): void;
    };
    const runCommand = vi.fn();
    internals.runCommand = runCommand;

    internals.handleCommand(client, { type: "replace", positions: [2] });

    expect(runCommand).toHaveBeenCalledWith(client, {
      type: "replace",
      positions: [2],
      replacementPosition: 2,
    });
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

    await internals.onCreate({ name: "Alice", visibility: "public", targetScore: 100, roomName: "  Game night  " });

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

    await internals.onCreate({ name: "Alice", visibility: "public", targetScore: 100, roomName: "  " });

    expect(room.state.roomName).toBe("Alice's room");
  });
});
