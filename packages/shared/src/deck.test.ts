import { describe, expect, it } from "vitest";
import { createDeck, seededRandom, shuffle } from "./deck.js";

describe("deck", () => {
  it("builds the specified 52 card deck", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    for (let rank = 1; rank <= 12; rank += 1) {
      expect(deck.filter((card) => card.rank === rank)).toHaveLength(4);
    }
    expect(deck.filter((card) => card.rank === 13)).toHaveLength(2);
    expect(deck.filter((card) => card.rank === 0)).toHaveLength(2);
    expect(new Set(deck.map((card) => card.id))).toHaveLength(52);
  });

  it("supports deterministic shuffling", () => {
    expect(shuffle(createDeck(), seededRandom(42))).toEqual(shuffle(createDeck(), seededRandom(42)));
    expect(shuffle(createDeck(), seededRandom(42))).not.toEqual(shuffle(createDeck(), seededRandom(43)));
  });
});
