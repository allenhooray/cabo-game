import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameEngine, seededRandom, type ClientCommand, type TurnDurationSeconds } from "@cabo-game/shared";
import { CaboRoom } from "./CaboRoom.js";
import { PlayerState } from "./state.js";

const rooms: CaboRoom[] = [];
function setup(duration: TurnDurationSeconds = 30, playerCount = 3) {
  const room = new CaboRoom(); rooms.push(room);
  const inner = room as any;
  inner.turnDurationSeconds = duration;
  inner.broadcast = vi.fn(); inner.updateListing = vi.fn();
  const players = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }].slice(0, playerCount);
  const engine = new GameEngine({ players, targetScore: 500, random: seededRandom(8) });
  inner.engine = engine;
  for (const p of engine.players) room.state.players.set(p.id, new PlayerState().assign({ ...p, connected: true }));
  engine.startMatch(); inner.knowledge.reset(1, players.map((player) => player.id), "classic"); inner.syncFromEngine();
  return { room, inner, engine, act: (command: ClientCommand) => inner.applyGameCommand(engine.currentPlayerId, command) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { rooms.splice(0).forEach((room) => room.onDispose()); vi.useRealTimers(); });

describe("authoritative deadlines", () => {
  it("cannot stall when all cards are in hands and both draw sources are empty", () => {
    const { engine, act } = setup(30, 2);
    let exchange = 0;
    while (engine.canDrawDeck() || engine.canDrawDiscard()) {
      const player = engine.players.find((candidate) => candidate.id === engine.currentPlayerId)!;
      player.hand[0] = { id: `forced-a-${exchange}`, label: "AS", rank: 1 };
      player.hand[1] = { id: `forced-b-${exchange}`, label: "2S", rank: 2 };
      act({ type: engine.canDrawDeck() ? "draw-deck" : "draw-discard" });
      act({ type: "replace", positions: [1, 2], replacementPosition: 1 });
      act({ type: "resolve-mismatch", drawnPlacement: "right" });
      exchange += 1;
    }
    expect(engine.players.map((player) => player.hand.length)).toEqual([26, 26]);
    expect(engine.phase).toBe("TURN_START");
    vi.advanceTimersByTime(30_000);
    expect(engine.phase).toBe("FINAL_TURNS");
    vi.advanceTimersByTime(30_000);
    expect(engine.phase).toBe("ROUND_RESULT");
  });
  it("falls back to the discard when the deck cannot be recycled", () => {
    const { engine } = setup(); const player = engine.currentPlayerId!;
    (engine as any).deck = [];
    (engine as any).discardPile = [{ id: "last", label: "3S", rank: 3 }];
    vi.advanceTimersByTime(30_000);
    expect(engine.debugHand(player)[0]?.id).toBe("last");
    expect(engine.currentPlayerId).not.toBe(player);
  });
  it("skips an already pending power and completes final turns", () => {
    const { engine, act } = setup(); const player = engine.currentPlayerId!;
    (engine as any).deck.push({ id: "power", label: "JS", rank: 11 });
    act({ type: "draw-deck" }); act({ type: "discard" });
    expect(engine.phase).toBe("POWER_PENDING");
    vi.advanceTimersByTime(30_000); expect(engine.currentPlayerId).not.toBe(player);
    act({ type: "cabo" });
    vi.advanceTimersByTime(60_000); expect(engine.phase).toBe("ROUND_RESULT");
  });
  it("a successful user step invalidates the previous timeout and invalid commands do not extend time", () => {
    const { inner, room, engine } = setup(); const player = engine.currentPlayerId;
    const generation = inner.timerGeneration; const deadline = room.state.deadlineAt;
    expect(() => inner.runCommand({ sessionId: player }, { type: "skip" })).toThrow();
    expect(room.state.deadlineAt).toBe(deadline);
    vi.advanceTimersByTime(29_999);
    inner.runCommand({ sessionId: player }, { type: "draw-deck" });
    inner.handleDeadline(generation);
    expect(engine.phase).toBe("DRAWN"); expect(engine.currentPlayerId).toBe(player);
  });
  it.each([30, 60, 90] as const)("completes an idle turn after %i seconds", (duration) => {
    const { room, engine, inner } = setup(duration);
    const player = engine.currentPlayerId;
    expect(room.state.deadlineAt).toBe(Date.now() + duration * 1000);
    vi.advanceTimersByTime(duration * 1000);
    expect(engine.currentPlayerId).not.toBe(player);
    expect(inner.broadcast).toHaveBeenCalledWith("event", expect.objectContaining({ type: "turn-timeout", playerId: player }));
    expect(engine.phase).toBe("TURN_START");
  });
  it("resets only for an effective game step and rejects stale callbacks", () => {
    const { room, inner, engine, act } = setup();
    const oldGeneration = inner.timerGeneration;
    vi.advanceTimersByTime(20_000); act({ type: "draw-deck" });
    expect(room.state.deadlineAt).toBe(Date.now() + 30_000);
    inner.handleDeadline(oldGeneration);
    expect(engine.phase).toBe("DRAWN");
    inner.bumpRevision();
    vi.advanceTimersByTime(29_999); expect(engine.phase).toBe("DRAWN");
    vi.advanceTimersByTime(1); expect(engine.phase).toBe("TURN_START");
  });
  it("places a discard draw at position one", () => {
    const { engine, act } = setup(); const player = engine.currentPlayerId!;
    act({ type: "draw-discard" }); const held = engine.getPendingDraw()!.card;
    vi.advanceTimersByTime(30_000);
    expect(engine.debugHand(player)[0]).toEqual(held);
    expect(engine.currentPlayerId).not.toBe(player);
  });
  it("resolves mismatch cards at the right end without learning the penalty", () => {
    const { engine, inner, act } = setup(); const player = engine.currentPlayerId!;
    const hand = engine.players.find((p) => p.id === player)!.hand;
    hand[0] = { id: "x", rank: 1, label: "AS" }; hand[1] = { id: "y", rank: 2, label: "2S" };
    act({ type: "draw-deck" }); const held = engine.getPendingDraw()!.card;
    act({ type: "replace", positions: [1, 2, 3], replacementPosition: 2 });
    vi.advanceTimersByTime(30_000);
    expect(engine.debugHand(player)).toHaveLength(6);
    expect(engine.debugHand(player)[4]).toEqual(held);
    expect(inner.knowledge.snapshot(player).slots.every((card: unknown) => card === null)).toBe(true);
  });
  it("keeps unlimited turns but advances unconfirmed round results after 20s", () => {
    const { room, engine, act } = setup(0);
    expect(room.state.deadlineAt).toBe(0);
    vi.advanceTimersByTime(90_000); expect(engine.round).toBe(1);
    act({ type: "cabo" });
    while (engine.currentPlayerId) { act({ type: "draw-deck" }); act({ type: "replace", positions: [1], replacementPosition: 1 }); }
    expect(engine.phase).toBe("ROUND_RESULT");
    expect(room.state.deadlineAt).toBe(Date.now() + 20_000);
    vi.advanceTimersByTime(20_000); expect(engine.round).toBe(2); expect(room.state.deadlineAt).toBe(0);
  });
  it("starts early when all players are ready and cancels the old result timer", () => {
    const { room, engine, inner, act } = setup(0); act({ type: "cabo" });
    while (engine.currentPlayerId) { act({ type: "draw-deck" }); act({ type: "replace", positions: [1], replacementPosition: 1 }); }
    ["a", "b", "c"].forEach((id) => inner.readyNextRound(id));
    expect(engine.round).toBe(2); vi.advanceTimersByTime(20_000); expect(engine.round).toBe(2); expect(room.state.deadlineAt).toBe(0);
  });
  it("handles a late command once and clears timers on dispose", () => {
    const { room, inner, engine } = setup(); const player = engine.currentPlayerId;
    vi.setSystemTime(room.state.deadlineAt);
    expect(() => inner.runCommand({ sessionId: player }, { type: "draw-deck" })).toThrow("deadline passed");
    expect(engine.currentPlayerId).not.toBe(player);
    const revision = room.state.revision; room.onDispose(); vi.advanceTimersByTime(90_000);
    expect(room.state.revision).toBe(revision);
  });
  it("does not extend the deadline on disconnect or reconnect and cancels after forfeit ends a match", () => {
    const { room, inner, engine } = setup(); const end = room.state.deadlineAt;
    inner.allowReconnection = vi.fn(); inner.sendKnowledge = vi.fn();
    room.onDrop({ sessionId: "a" } as any); vi.advanceTimersByTime(10_000); room.onReconnect({ sessionId: "a" } as any);
    expect(room.state.deadlineAt).toBe(end);
    engine.forfeit("a"); engine.forfeit("b"); inner.syncFromEngine();
    expect(room.state.deadlineAt).toBe(0); expect(engine.phase).toBe("MATCH_RESULT");
  });
});
