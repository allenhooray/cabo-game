import { describe, expect, it } from "vitest";
import { applyOwnActionEvent, applyReveal, applySwapEvent, createKnowledge } from "./knowledge.js";

describe("private card knowledge", () => {
  it("records own reveals but not another player's peek", () => {
    let state = createKnowledge();
    state = applyReveal(state, { reason: "initial", position: 1, card: { id: "a", label: "4♣", rank: 4 } }, 1, "TURN_START");
    state = applyReveal(state, { reason: "peek", position: 3, card: { id: "b", label: "8♦", rank: 8 } }, 1, "POWER_PENDING", { command: { type: "peek-self", position: 3 } });
    state = applyReveal(state, { reason: "peek", position: 4, card: { id: "c", label: "Q♠", rank: 12 } }, 1, "POWER_PENDING", { command: { type: "peek-other", targetPlayerId: "bob", position: 4 } });
    expect(state.slots).toEqual([{ label: "4♣", rank: 4 }, null, { label: "8♦", rank: 8 }, null]);
  });

  it("applies confirmed replacements and forgets blind swaps", () => {
    let state = createKnowledge(1, { round: 1, slots: [{ label: "A♣", rank: 1 }, null, null, null] });
    state = applyReveal(state, { reason: "draw", card: { id: "a", label: "J♣", rank: 11 } }, 1, "DRAWN");
    state = applyOwnActionEvent(state, { command: { type: "replace", position: 2 } });
    expect(state.slots[1]).toEqual({ label: "J♣", rank: 11 });
    state = applySwapEvent(state, 1, true);
    expect(state.slots[0]).toBeNull();
  });
});
