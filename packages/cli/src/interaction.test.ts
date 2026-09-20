import { describe, expect, it } from "vitest";
import { advanceFlow, menuFor, selectMenu, stateGuard, type InteractionContext } from "./interaction.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

const alice: StatePlayer = { id: "a", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: true };
const bob: StatePlayer = { id: "b", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: false };

function context(phase: string, currentPlayerId = "a", discardRank = 5): InteractionContext {
  const state: CaboStateLike = {
    revision: 1,
    phase, round: 1, targetScore: 100, currentPlayerId, caboCallerId: "", discardLabel: "5♣", discardRank,
    deckCount: 43, players: new Map([["a", alice], ["b", bob]]), winners: [],
  };
  return { state, selfId: "a" };
}

describe("context actions", () => {
  it("shows only legal actions for the current phase", () => {
    expect(menuFor(context("TURN_START")).map((item) => item.action)).toEqual(["draw-deck", "draw-discard", "cabo"]);
    expect(menuFor(context("DRAWN")).map((item) => item.action)).toEqual(["replace", "discard"]);
    expect(menuFor(context("TURN_START", "b"))).toEqual([]);
    expect(menuFor(context("POWER_PENDING", "a", 10)).map((item) => item.action)).toEqual(["peek-other", "skip"]);
  });

  it("turns numeric choices into guided position commands", () => {
    const ctx = context("TURN_START");
    const selected = selectMenu("2", ctx);
    expect(selected?.kind).toBe("flow");
    if (selected?.kind !== "flow") return;
    expect(advanceFlow("3", selected.flow, ctx)).toEqual({ kind: "game", command: { type: "draw-discard", position: 3 } });
  });

  it("guides target then position and supports cancellation", () => {
    const ctx = context("POWER_PENDING", "a", 11);
    const selected = selectMenu("1", ctx);
    if (selected?.kind !== "flow") throw new Error("missing target flow");
    const target = advanceFlow("1", selected.flow, ctx);
    if (target.kind !== "flow") throw new Error("missing position flow");
    expect(advanceFlow("4", target.flow, ctx)).toEqual({ kind: "game", command: { type: "swap", targetPlayerId: "b", position: 4 } });
    expect(advanceFlow("cancel", target.flow, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
  });

  it("requires an explicit yes before CABO", () => {
    const ctx = context("TURN_START");
    const result = selectMenu("3", ctx);
    if (result?.kind !== "flow") throw new Error("missing confirmation");
    expect(advanceFlow("n", result.flow, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
    expect(advanceFlow("yes", result.flow, ctx)).toEqual({ kind: "game", command: { type: "cabo" } });
    expect(result.flow).toMatchObject({ guard: stateGuard(ctx) });
  });
});
