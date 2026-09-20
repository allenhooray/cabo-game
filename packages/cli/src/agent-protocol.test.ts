import { describe, expect, it } from "vitest";
import { AgentProtocolError, buildObservation, legalActions, parseAgentRequest } from "./agent-protocol.js";
import { createKnowledge } from "./knowledge.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

const alice: StatePlayer = { id: "a", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: true };
const bob: StatePlayer = { id: "b", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: false };

function state(overrides: Partial<CaboStateLike> = {}): CaboStateLike {
  return {
    revision: 3,
    phase: "LOBBY",
    round: 0,
    targetScore: 100,
    currentPlayerId: "",
    caboCallerId: "",
    discardLabel: "",
    discardRank: -1,
    deckCount: 0,
    players: new Map([[alice.id, alice], [bob.id, bob]]),
    winners: [],
    ...overrides,
  };
}

describe("agent JSONL protocol", () => {
  it("parses strict requests and reports malformed input", () => {
    expect(parseAgentRequest('{"id":"r1","type":"rooms"}')).toEqual({ id: "r1", type: "rooms" });
    expect(() => parseAgentRequest("{"))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_JSON", id: null }));
    expect(() => parseAgentRequest('{"id":"r2","type":"rooms","extra":true}'))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_REQUEST", id: "r2" }));
    expect(() => parseAgentRequest('{"id":"r3","type":"action","action":{"type":"leave"}}'))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_REQUEST", id: "r3" }));
  });

  it("enumerates lobby, draw, replacement and final-turn actions", () => {
    expect(legalActions(state(), "a")).toEqual([{ type: "start" }]);
    expect(legalActions(state({ phase: "TURN_START", currentPlayerId: "a" }), "a")).toHaveLength(6);
    expect(legalActions(state({ phase: "DRAWN", currentPlayerId: "a" }), "a")).toEqual([
      { type: "replace", position: 1 }, { type: "replace", position: 2 },
      { type: "replace", position: 3 }, { type: "replace", position: 4 }, { type: "discard" },
    ]);
    expect(legalActions(state({ phase: "FINAL_TURNS", currentPlayerId: "a", caboCallerId: "b" }), "a"))
      .not.toContainEqual({ type: "cabo" });
  });

  it("enumerates every power target and always permits skipping", () => {
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 7 }), "a"))
      .toContainEqual({ type: "peek-self", position: 4 });
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 9 }), "a"))
      .toContainEqual({ type: "peek-other", targetPlayerId: "b", position: 3 });
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 11 }), "a"))
      .toContainEqual({ type: "swap", targetPlayerId: "b", position: 2 });
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 12 }), "a"))
      .toContainEqual({ type: "skip" });
  });

  it("serializes maps, null values and private knowledge", () => {
    const observation = buildObservation(state(), "a", "room", createKnowledge());
    expect(observation.state.players.map((player) => player.id)).toEqual(["a", "b"]);
    expect(observation.state.currentPlayerId).toBeNull();
    expect(observation.state.caboCallerId).toBeNull();
    expect(observation.state.discardTop).toBeNull();
    expect(observation.knowledge.slots).toEqual([null, null, null, null]);
  });
});
