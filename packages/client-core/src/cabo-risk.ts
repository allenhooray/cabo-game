import type { CaboRisk, PrivateKnowledgeSnapshot } from "@cabo-game/shared";
import type { CaboStateLike } from "./model.js";
import { legalActions } from "./legal-actions.js";

export function caboRisk(state: CaboStateLike, selfId: string, knowledge: PrivateKnowledgeSnapshot): CaboRisk | null {
  if (!legalActions(state, selfId).some((action) => action.type === "cabo")) return null;
  const count = state.players.get(selfId)?.cardCount ?? 0;
  const known = state.memoryMode === "assisted" ? knowledge.slots.slice(0, count).filter((card) => card !== null) : [];
  return { strictLowest: true, tieFails: true, failurePenalty: 5,
    knownScore: state.memoryMode === "assisted" ? known.reduce((sum, card) => sum + card.rank, 0) : null,
    unknownCount: count - known.length };
}

export function formatCaboRisk(risk: CaboRisk): string {
  const summary = risk.knownScore === null ? `${risk.unknownCount} cards in your hand.`
    : risk.unknownCount === 0 ? `Exact hand total: ${risk.knownScore}.`
      : `Known subtotal: ${risk.knownScore}; ${risk.unknownCount} unknown cards.`;
  return `${summary} You must be strictly lowest. A tie also fails. Failure scores your hand + 5. Every other active player gets one final turn.`;
}
