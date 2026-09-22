import { describe, expect, it } from "vitest";
import { caboRisk, formatCaboRisk } from "./cabo-risk.js";
import { createKnowledge } from "./knowledge.js";
import type { CaboStateLike } from "./model.js";

describe("Cabo risk", () => {
  const state = { phase: "TURN_START", currentPlayerId: "a", caboCallerId: "", memoryMode: "assisted", players: new Map([["a", { connected: true, forfeited: false, cardCount: 4 }]]) } as unknown as CaboStateLike;
  it("uses only legal remembered cards, and never exposes history in classic mode", () => {
    const knowledge = createKnowledge(1, { round: 1, slots: [{ label: "AS", rank: 1 }, null, { label: "3S", rank: 3 }, null] }, "assisted");
    expect(caboRisk(state, "a", knowledge)).toMatchObject({ knownScore: 4, unknownCount: 2, tieFails: true, failurePenalty: 5 });
    const classic = caboRisk({ ...state, memoryMode: "classic" }, "a", knowledge)!;
    expect(classic).toMatchObject({ knownScore: null, unknownCount: 4 });
    expect(formatCaboRisk(classic)).toContain("A tie also fails");
    expect(caboRisk({ ...state, phase: "DRAWN" }, "a", knowledge)).toBeNull();
    const exact = caboRisk({ ...state, players: new Map([["a", { ...state.players.get("a")!, cardCount: 1 }]]) }, "a", knowledge)!;
    expect(exact).toMatchObject({ knownScore: 1, unknownCount: 0 });
    expect(formatCaboRisk(exact)).toContain("Exact hand total: 1");
  });
});
