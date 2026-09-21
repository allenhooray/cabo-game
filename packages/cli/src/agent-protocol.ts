import { agentRequestSchema, type AgentObservation, type AgentRequest } from "@cabo-game/shared";
import { legalActions } from "@cabo-game/client-core";
import type { KnowledgeState } from "./knowledge.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

export type { AgentRequest };
export type { AgentObservation };

export function parseAgentRequest(line: string): AgentRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AgentProtocolError("INVALID_JSON", "Input is not valid JSON.");
  }
  const parsed = agentRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentProtocolError("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "Invalid request.", requestId(value));
  }
  return parsed.data;
}

export function buildObservation(
  state: CaboStateLike,
  selfId: string,
  roomId: string,
  knowledge: KnowledgeState,
): AgentObservation {
  return {
    roomId,
    roomName: state.roomName,
    selfId,
    revision: state.revision,
    state: {
      phase: state.phase,
      round: state.round,
      targetScore: state.targetScore,
      currentPlayerId: state.currentPlayerId || null,
      caboCallerId: state.caboCallerId || null,
      drawSource: state.drawSource || null,
      mismatchPenaltyCardPending: state.mismatchPenaltyCardPending,
      discardTop: state.discardLabel ? { label: state.discardLabel, rank: state.discardRank } : null,
      deckCount: state.deckCount,
      players: [...state.players.values()].sort((a, b) => a.seat - b.seat).map(serializePlayer),
      winners: [...state.winners],
    },
    knowledge: {
      round: knowledge.round,
      slots: knowledge.slots.map((card) => card ? { ...card } : null),
      opponents: knowledge.opponents.map((opponent) => ({
        playerId: opponent.playerId,
        slots: opponent.slots.map((card) => card ? { ...card } : null),
      })),
      held: knowledge.held ? { ...knowledge.held } : null,
    },
    legalActions: legalActions(state, selfId),
  };
}

function serializePlayer(player: StatePlayer): StatePlayer {
  return {
    id: player.id,
    name: player.name,
    seat: player.seat,
    score: player.score,
    connected: player.connected,
    forfeited: player.forfeited,
    nextRoundReady: player.nextRoundReady,
    cardCount: player.cardCount,
    isHost: player.isHost,
  };
}

export { legalActions } from "@cabo-game/client-core";

export function requestId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { id?: unknown }).id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export class AgentProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly id: string | null = null) {
    super(message);
    this.name = "AgentProtocolError";
  }
}
