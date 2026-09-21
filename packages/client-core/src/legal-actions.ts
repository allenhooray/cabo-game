import type { AgentAction } from "@cabo-game/shared";
import type { CaboStateLike } from "./model.js";

export function legalActions(state: CaboStateLike, selfId: string): AgentAction[] {
  const self = state.players.get(selfId);
  if (!self || self.forfeited || !self.connected) return [];
  if (state.phase === "LOBBY") {
    const activeCount = [...state.players.values()].filter((player) => player.connected && !player.forfeited).length;
    return self.isHost && activeCount >= 2 ? [{ type: "start" }] : [];
  }
  if (state.currentPlayerId !== selfId) return [];
  const positions = [1, 2, 3, 4] as const;
  if (state.phase === "TURN_START" || state.phase === "FINAL_TURNS") {
    return [
      { type: "draw-deck" },
      ...positions.map((position) => ({ type: "draw-discard" as const, position })),
      ...(!state.caboCallerId ? [{ type: "cabo" as const }] : []),
    ];
  }
  if (state.phase === "DRAWN") {
    return [...positions.map((position) => ({ type: "replace" as const, position })), { type: "discard" }];
  }
  if (state.phase !== "POWER_PENDING") return [];

  const targets = [...state.players.values()]
    .filter((player) => player.id !== selfId && !player.forfeited)
    .sort((a, b) => a.seat - b.seat);
  let powers: AgentAction[] = [];
  if (state.discardRank === 7 || state.discardRank === 8) {
    powers = positions.map((position) => ({ type: "peek-self", position }));
  } else if (state.discardRank === 9 || state.discardRank === 10) {
    powers = targets.flatMap((target) => positions.map((position) => ({ type: "peek-other", targetPlayerId: target.id, position })));
  } else if (state.discardRank === 11 || state.discardRank === 12) {
    powers = targets.flatMap((target) => positions.map((position) => ({ type: "swap", targetPlayerId: target.id, position })));
  }
  return [...powers, { type: "skip" }];
}
