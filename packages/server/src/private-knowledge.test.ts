import { describe, expect, it } from "vitest";
import type { Card, EngineEvent, Rank } from "@cabo-game/shared";
import { PrivateKnowledgeStore, publicAction } from "./private-knowledge.js";

const card = (id: string, label: string, rank: Rank): Card => ({ id, label, rank });

describe("private knowledge", () => {
  it("keeps peeks private and follows known cards through public swaps", () => {
    const store = new PrivateKnowledgeStore();
    store.reset(1, ["alice", "bob"]);
    store.applyPrivateReveal(
      { type: "private-reveal", playerId: "alice", reason: "peek", position: 2, card: card("b", "9H", 9) },
      { type: "peek-other", targetPlayerId: "bob", position: 2 },
    );
    expect(store.snapshot("alice")?.opponents[0]?.slots[1]).toEqual({ label: "9H", rank: 9 });
    expect(store.snapshot("bob")?.slots[1]).toBeNull();

    store.applyAction({ type: "action", action: "swap", playerId: "alice", targetPlayerId: "bob", position: 2 });
    expect(store.snapshot("alice")?.slots[1]).toEqual({ label: "9H", rank: 9 });
    expect(store.snapshot("alice")?.opponents[0]?.slots[1]).toBeNull();
  });

  it("publishes only animation-safe action details", () => {
    const events: EngineEvent[] = [{ type: "discard", playerId: "alice", card: card("secret-id", "4C", 4) }];
    expect(publicAction({ type: "draw-deck" }, "alice", [], card("hidden", "KS", 13))).toEqual({ type: "action", action: "draw-deck", playerId: "alice" });
    expect(publicAction({ type: "replace", position: 3 }, "alice", events)).toEqual({
      type: "action", action: "replace", playerId: "alice", position: 3, discardedCard: { label: "4C", rank: 4 },
    });
    expect(JSON.stringify(publicAction({ type: "replace", position: 3 }, "alice", events))).not.toContain("secret-id");
  });
});
