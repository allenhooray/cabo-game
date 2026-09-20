import { agentRequestSchema, type AgentRequest, type ClientCommand } from "@cabo/shared";
import type { KnowledgeState } from "./knowledge.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

export type { AgentRequest };

export interface AgentObservation {
  roomId: string;
  selfId: string;
  revision: number;
  state: {
    phase: string;
    round: number;
    targetScore: number;
    currentPlayerId: string | null;
    caboCallerId: string | null;
    discardTop: { label: string; rank: number } | null;
    deckCount: number;
    players: StatePlayer[];
    winners: string[];
  };
  knowledge: KnowledgeState;
  legalActions: ClientCommand[];
}

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
    selfId,
    revision: state.revision,
    state: {
      phase: state.phase,
      round: state.round,
      targetScore: state.targetScore,
      currentPlayerId: state.currentPlayerId || null,
      caboCallerId: state.caboCallerId || null,
      discardTop: state.discardLabel ? { label: state.discardLabel, rank: state.discardRank } : null,
      deckCount: state.deckCount,
      players: [...state.players.values()].sort((a, b) => a.seat - b.seat).map(serializePlayer),
      winners: [...state.winners],
    },
    knowledge: {
      round: knowledge.round,
      slots: knowledge.slots.map((card) => card ? { ...card } : null),
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
    cardCount: player.cardCount,
    isHost: player.isHost,
  };
}

export function legalActions(state: CaboStateLike, selfId: string): ClientCommand[] {
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
  let powers: ClientCommand[] = [];
  if (state.discardRank === 7 || state.discardRank === 8) {
    powers = positions.map((position) => ({ type: "peek-self", position }));
  } else if (state.discardRank === 9 || state.discardRank === 10) {
    powers = targets.flatMap((target) => positions.map((position) => ({ type: "peek-other", targetPlayerId: target.id, position })));
  } else if (state.discardRank === 11 || state.discardRank === 12) {
    powers = targets.flatMap((target) => positions.map((position) => ({ type: "swap", targetPlayerId: target.id, position })));
  }
  return [...powers, { type: "skip" }];
}

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
