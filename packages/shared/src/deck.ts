import type { Card, Rank } from "./types.js";

export type RandomSource = () => number;

const rankLabel = (rank: number): string => {
  if (rank === 0) return "Joker";
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
};

export function createDeck(): Card[] {
  const cards: Card[] = [];
  for (let rank = 1; rank <= 12; rank += 1) {
    for (const suit of ["S", "H", "D", "C"]) {
      cards.push({ id: `${rank}-${suit}`, rank: rank as Rank, label: `${rankLabel(rank)}${suit}` });
    }
  }
  cards.push({ id: "13-A", rank: 13, label: "K-A" });
  cards.push({ id: "13-B", rank: 13, label: "K-B" });
  cards.push({ id: "0-B", rank: 0, label: "Black Joker" });
  cards.push({ id: "0-R", rank: 0, label: "Red Joker" });
  return cards;
}

export function shuffle<T>(items: readonly T[], random: RandomSource = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const value = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = value as T;
  }
  return copy;
}

export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
