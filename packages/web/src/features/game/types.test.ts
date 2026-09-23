import { describe, expect, it } from "vitest";
import { clientEvent } from "./types.js";

describe("clientEvent", () => {
  it("accepts complete events and returns only the fields used by the Web client", () => {
    expect(clientEvent({
      type: "action",
      action: "exchange-mismatch",
      playerId: "alice",
      positions: [1, 2],
      revealedCards: [{ id: "private", label: "4H", rank: 4 }, { label: "4S", rank: 4 }],
      penaltyCardPending: true,
    })).toEqual({
      type: "action",
      action: "exchange-mismatch",
      playerId: "alice",
      positions: [1, 2],
      revealedCards: [{ label: "4H", rank: 4 }, { label: "4S", rank: 4 }],
      penaltyCardPending: true,
    });

    expect(clientEvent({
      type: "round-result",
      hands: [{ playerId: "alice", cards: [{ id: "card-1", label: "KH", rank: 13 }], handScore: 13 }],
      roundScores: { alice: 13 },
      totals: { alice: 13 },
      outcome: { type: "cabo", callerId: "alice", succeeded: false },
    })).toEqual({
      type: "round-result",
      hands: [{ playerId: "alice", cards: [{ label: "KH", rank: 13 }], handScore: 13 }],
      roundScores: { alice: 13 },
      totals: { alice: 13 },
      outcome: { type: "cabo", callerId: "alice", succeeded: false },
    });
  });

  it.each([
    undefined,
    null,
    { type: "action", action: "replace", playerId: "alice", replacementPosition: 1, discardedCards: [] },
    { type: "action", action: "draw-discard", playerId: "alice", takenCard: { label: "4H" } },
    { type: "action", action: "exchange-mismatch", playerId: "alice", positions: [1], revealedCards: [null], penaltyCardPending: true },
    { type: "action", action: "peek-other", playerId: "alice", position: 1 },
    { type: "joined", playerId: "alice" },
    { type: "disconnected", playerId: "alice", graceSeconds: "60" },
    { type: "turn", playerId: "alice" },
    { type: "turn-timeout", playerId: "alice", phase: "UNKNOWN" },
    { type: "round-result", hands: [], roundScores: {}, totals: {}, outcome: { type: "cabo", callerId: "alice" } },
    { type: "round-result", hands: [{ playerId: "alice", cards: [], handScore: "zero" }], roundScores: {}, totals: {}, outcome: { type: "shooting-the-moon", playerId: "alice" } },
    { type: "match-result", winners: ["alice"], totals: { alice: "zero" } },
  ])("rejects malformed event %#", (event) => {
    expect(() => clientEvent(event)).not.toThrow();
    expect(clientEvent(event)).toBeUndefined();
  });
});
