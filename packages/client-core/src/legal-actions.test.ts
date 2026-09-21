import { describe, expect, it } from "vitest";
import type { CaboStateLike, StatePlayer } from "./model.js";
import { legalActions } from "./legal-actions.js";

const alice: StatePlayer = { id: "a", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: true };
const bob: StatePlayer = { id: "b", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: false };

function state(overrides: Partial<CaboStateLike> = {}): CaboStateLike {
  return { revision: 1, roomName: "Alice's room", phase: "LOBBY", round: 0, targetScore: 100, currentPlayerId: "", caboCallerId: "", discardLabel: "", discardRank: -1, deckCount: 0, players: new Map([["a", alice], ["b", bob]]), winners: [], ...overrides };
}

describe("legalActions", () => {
  it("covers lobby, draw, replacement, and powers", () => {
    expect(legalActions(state(), "a")).toEqual([{ type: "start" }]);
    expect(legalActions(state({ phase: "TURN_START", currentPlayerId: "a" }), "a")).toContainEqual({ type: "draw-deck" });
    expect(legalActions(state({ phase: "DRAWN", currentPlayerId: "a" }), "a")).toContainEqual({ type: "replace", position: 4 });
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 9 }), "a")).toContainEqual({ type: "peek-other", targetPlayerId: "b", position: 3 });
    expect(legalActions(state({ phase: "POWER_PENDING", currentPlayerId: "a", discardRank: 11 }), "a")).toContainEqual({ type: "swap", targetPlayerId: "b", position: 2 });
  });
});
