import { describe, expect, it } from "vitest";
import { applyOwnActionEvent, applyReveal, applySwapEvent, createKnowledge } from "./knowledge.js";

describe("private card knowledge", () => {
  it("records initial and self-peek reveals but not other-player peeks", () => {
    let state = createKnowledge();
    state = applyReveal(state, { reason: "initial", position: 1, card: { id: "a", label: "4♣", rank: 4 } }, 1, "TURN_START");
    state = applyReveal(state, { reason: "peek", position: 3, card: { id: "b", label: "8♦", rank: 8 } }, 1, "POWER_PENDING", { command: { type: "peek-self", position: 3 } });
    state = applyReveal(state, { reason: "peek", position: 4, card: { id: "c", label: "Q♠", rank: 12 } }, 1, "POWER_PENDING", { command: { type: "peek-other", targetPlayerId: "bob", position: 4 } });
    expect(state.slots).toEqual([{ label: "4♣", rank: 4 }, null, { label: "8♦", rank: 8 }, null]);
  });

  it("handles reveal-before-state ordering at the start of the next round", () => {
    const state = applyReveal(createKnowledge(1), { reason: "initial", position: 1, card: { id: "a", label: "2♥", rank: 2 } }, 1, "ROUND_RESULT");
    expect(state.round).toBe(2);
    expect(state.slots[0]?.label).toBe("2♥");
    const firstRound = applyReveal(createKnowledge(), { reason: "initial", position: 2, card: { id: "b", label: "9♣", rank: 9 } }, 0, "LOBBY");
    expect(firstRound.round).toBe(1);
    expect(firstRound.slots[1]?.label).toBe("9♣");
  });

  it("updates replacements and discard draws only after their public event", () => {
    let state = createKnowledge(1);
    state = applyReveal(state, { reason: "draw", card: { id: "a", label: "J♣", rank: 11 } }, 1, "DRAWN");
    state = applyOwnActionEvent(state, { command: { type: "replace", position: 2 } });
    expect(state.slots[1]).toEqual({ label: "J♣", rank: 11 });
    expect(state.held).toBeNull();
    state = applyOwnActionEvent(state, { command: { type: "draw-discard", position: 4 }, discard: { label: "3♠", rank: 3 } });
    expect(state.slots[3]).toEqual({ label: "3♠", rank: 3 });
  });

  it("forgets a position involved in a blind swap", () => {
    let state = createKnowledge(1, { round: 1, slots: [{ label: "A♣", rank: 1 }, null, null, null] });
    state = applySwapEvent(state, 1, true);
    expect(state.slots[0]).toBeNull();
  });
});
