import type { LegalAction } from "@cabo-game/shared";
import type { CaboStateLike } from "./model.js";

export function legalActions(state: CaboStateLike, selfId: string): LegalAction[] {
  const self = state.players.get(selfId);
  if (!self || self.forfeited || !self.connected) return [];
  if (state.phase === "LOBBY") {
    const activeCount = [...state.players.values()].filter((player) => player.connected && !player.forfeited).length;
    return self.isHost && activeCount >= 2 ? [{ type: "start" }] : [];
  }
  if (state.currentPlayerId !== selfId) return [];
  const positions = Array.from({ length: self.cardCount }, (_, index) => index + 1);
  if (state.phase === "TURN_START" || state.phase === "FINAL_TURNS") {
    return [
      { type: "draw-deck" },
      { type: "draw-discard" },
      ...(!state.caboCallerId ? [{ type: "cabo" as const }] : []),
    ];
  }
  if (state.phase === "DRAWN") {
    return [
      { type: "replace", selectablePositions: positions, minSelections: 1, maxSelections: Math.min(4, positions.length) },
      ...(state.drawSource === "deck" ? [{ type: "discard" as const }] : []),
    ];
  }
  if (state.phase === "MISMATCH_PENDING") {
    return [{ type: "resolve-mismatch", placements: ["left", "right"], penaltyCardPending: state.mismatchPenaltyCardPending }];
  }
  if (state.phase !== "POWER_PENDING") return [];

  const targets = [...state.players.values()]
    .filter((player) => player.id !== selfId && !player.forfeited)
    .sort((a, b) => a.seat - b.seat);
  let powers: LegalAction[] = [];
  if (state.discardRank === 7 || state.discardRank === 8) {
    powers = positions.map((position) => ({ type: "peek-self", position }));
  } else if (state.discardRank === 9 || state.discardRank === 10) {
    powers = targets.flatMap((target) => Array.from({ length: target.cardCount }, (_, index) => ({ type: "peek-other" as const, targetPlayerId: target.id, position: index + 1 })));
  } else if (state.discardRank === 11 || state.discardRank === 12) {
    powers = targets.flatMap((target) => Array.from({ length: Math.min(self.cardCount, target.cardCount) }, (_, index) => ({ type: "swap" as const, targetPlayerId: target.id, position: index + 1 })));
  }
  return [...powers, { type: "skip" }];
}
