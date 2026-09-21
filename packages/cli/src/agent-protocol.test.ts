import { AGENT_PROTOCOL_VERSION, agentFrameSchema, agentProtocolJsonSchema } from "@cabo-game/shared";
import { describe, expect, it } from "vitest";
import { AgentProtocolError, buildObservation, legalActions, parseAgentRequest } from "./agent-protocol.js";
import { createKnowledge } from "./knowledge.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

const alice: StatePlayer = { id: "a", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true };
const bob: StatePlayer = { id: "b", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false };

function state(overrides: Partial<CaboStateLike> = {}): CaboStateLike {
  return {
    revision: 3,
    roomName: "Alice's room",
    phase: "LOBBY",
    round: 0,
    targetScore: 100,
    currentPlayerId: "",
    caboCallerId: "",
    drawSource: "",
    mismatchPenaltyCardPending: false,
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
    expect(parseAgentRequest('{"id":"d1","type":"describe"}')).toEqual({ id: "d1", type: "describe" });
    expect(parseAgentRequest('{"id":"p1","type":"ping"}')).toEqual({ id: "p1", type: "ping" });
    expect(() => parseAgentRequest("{"))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_JSON", id: null }));
    expect(() => parseAgentRequest('{"id":"r2","type":"rooms","extra":true}'))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_REQUEST", id: "r2" }));
    expect(() => parseAgentRequest('{"id":"r3","type":"action","action":{"type":"leave"}}'))
      .toThrowError(expect.objectContaining<Partial<AgentProtocolError>>({ code: "INVALID_REQUEST", id: "r3" }));
  });

  it("enumerates lobby, draw, replacement and final-turn actions", () => {
    expect(legalActions(state(), "a")).toEqual([{ type: "start" }]);
    expect(legalActions(state({ phase: "TURN_START", currentPlayerId: "a" }), "a")).toEqual([{ type: "draw-deck" }, { type: "draw-discard" }, { type: "cabo" }]);
    expect(legalActions(state({ phase: "DRAWN", currentPlayerId: "a", drawSource: "deck" }), "a")).toEqual([
      { type: "replace", selectablePositions: [1, 2, 3, 4], minSelections: 1, maxSelections: 4 }, { type: "discard" },
    ]);
    expect(legalActions(state({ phase: "FINAL_TURNS", currentPlayerId: "a", caboCallerId: "b" }), "a"))
      .not.toContainEqual({ type: "cabo" });
    expect(legalActions(state({ phase: "ROUND_RESULT" }), "a")).toEqual([{ type: "ready-next-round" }]);
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
    const observation = buildObservation(state({ roundHistory: [{
      round: 1,
      outcomeType: "cabo",
      outcomePlayerId: "a",
      caboSucceeded: true,
      players: [{ playerId: "a", roundScore: 0, totalScore: 0, handScore: 4, cards: [{ label: "4H", rank: 4 }] }],
    }] }), "a", "room", createKnowledge());
    expect(observation.state.players.map((player) => player.id)).toEqual(["a", "b"]);
    expect(observation.state.currentPlayerId).toBeNull();
    expect(observation.state.caboCallerId).toBeNull();
    expect(observation.state.discardTop).toBeNull();
    expect(observation.state.players[0]?.nextRoundReady).toBe(false);
    expect(observation.state.roundHistory[0]).toMatchObject({ round: 1, outcomePlayerId: "a" });
    expect(observation.state.roundHistory[0]?.players[0]?.cards).toEqual([{ label: "4H", rank: 4 }]);
    expect(observation.knowledge.slots).toEqual([null, null, null, null]);
    expect(observation.knowledge.opponents).toEqual([]);
    expect(() => agentFrameSchema.parse({ type: "observation", ...observation })).not.toThrow();
  });

  it("generates a complete protocol JSON Schema from the wire schema", () => {
    const schema = agentProtocolJsonSchema();
    const serialized = JSON.stringify(schema);
    expect(schema.$id).toBe(`urn:cabo:agent-protocol:v${AGENT_PROTOCOL_VERSION}`);
    expect(schema).toHaveProperty("anyOf");
    expect(serialized.match(/\"const\":\"leave\"/g)).toHaveLength(1);
    expect(serialized).toContain('"roomName"');
    expect(serialized).toContain('"isStarted"');
    expect(serialized).toContain('"canJoin"');
    expect(serialized).toContain('"selectablePositions"');
    expect(serialized).toContain('"resolve-mismatch"');
    expect(serialized).toContain('"ready-next-round"');
    expect(serialized).toContain('"roundHistory"');
  });

  it("validates every output frame family", () => {
    const frames = [
      { type: "ready", protocolVersion: AGENT_PROTOCOL_VERSION, cliVersion: "0.1.0", server: "http://localhost", name: "Bot", sessionPersistence: false, requestTimeoutMs: 15000, capabilities: ["describe", "ping", "json-schema", "request-timeout"] },
      { type: "result", id: "1", ok: true, data: { connected: false, server: "http://localhost", roomId: null, roomName: null, selfId: null, revision: null, phase: null } },
      { type: "result", id: "2", ok: false, error: { code: "NO", message: "no" }, uncertain: true },
      { type: "event", event: { type: "connection-dropped" } },
      { type: "fatal", error: { code: "BAD", message: "bad" } },
    ];
    for (const frame of frames) expect(() => agentFrameSchema.parse(frame)).not.toThrow();
  });
});
