import type { CaboStateLike } from "@cabo-game/client-core";
import type { KnownCard, PublicActionEvent } from "@cabo-game/shared";

export type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "offline";
export type Selection = "idle" | "replace" | "peek-other" | "swap";
export type CardMotion = PublicActionEvent & { id: number };

export interface RoundResult {
  type: "round-result";
  hands: Array<{ playerId: string; cards: KnownCard[]; handScore: number }>;
  roundScores: Record<string, number>;
  totals: Record<string, number>;
  outcome:
    | { type: "cabo"; callerId: string; succeeded: boolean }
    | { type: "shooting-the-moon"; playerId: string };
}

export interface MatchResult {
  type: "match-result";
  winners: string[];
  totals: Record<string, number>;
}

export type ResultEvent = RoundResult | MatchResult;

export interface Confirmation {
  revision?: number;
  title: string;
  body: string;
  label: string;
  action(): Promise<void>;
}

export interface TemporaryCard {
  ownerId: string;
  position: number;
  card: KnownCard;
  expiresAt: number;
  round: number;
}

export type ClientEvent =
  | PublicActionEvent
  | { type: "turn"; playerId: string; finalTurn: boolean }
  | { type: "discard"; playerId: string }
  | { type: "swap"; playerId: string }
  | { type: "cabo"; playerId: string }
  | { type: "forfeit"; playerId: string }
  | ResultEvent
  | { type: "joined"; playerId: string; name: string }
  | { type: "disconnected"; playerId: string; graceSeconds: number }
  | { type: "reconnected"; playerId: string }
  | { type: "turn-timeout"; playerId: string; phase: CaboStateLike["phase"] };

const gamePhases = new Set<string>([
  "LOBBY", "INITIAL_REVEAL", "TURN_START", "DRAWN", "MISMATCH_PENDING", "POWER_PENDING",
  "TURN_END", "FINAL_TURNS", "ROUND_RESULT", "MATCH_RESULT",
]);

export function clientEvent(value: unknown): ClientEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "action": return actionEvent(value);
    case "turn": return typeof value.playerId === "string" && typeof value.finalTurn === "boolean"
      ? { type: "turn", playerId: value.playerId, finalTurn: value.finalTurn } : undefined;
    case "discard": case "swap": case "cabo": case "forfeit": case "reconnected":
      return typeof value.playerId === "string" ? { type: value.type, playerId: value.playerId } : undefined;
    case "joined": return typeof value.playerId === "string" && typeof value.name === "string"
      ? { type: "joined", playerId: value.playerId, name: value.name } : undefined;
    case "disconnected": return typeof value.playerId === "string" && isFiniteNumber(value.graceSeconds)
      ? { type: "disconnected", playerId: value.playerId, graceSeconds: value.graceSeconds } : undefined;
    case "turn-timeout": return typeof value.playerId === "string" && isGamePhase(value.phase)
      ? { type: "turn-timeout", playerId: value.playerId, phase: value.phase } : undefined;
    case "round-result": return roundResult(value);
    case "match-result": return matchResult(value);
    default: return undefined;
  }
}

function actionEvent(value: Record<string, unknown>): PublicActionEvent | undefined {
  if (typeof value.playerId !== "string" || typeof value.action !== "string") return undefined;
  const playerId = value.playerId;
  switch (value.action) {
    case "draw-deck": return { type: "action", action: "draw-deck", playerId };
    case "draw-discard": {
      const takenCard = knownCard(value.takenCard);
      return takenCard ? { type: "action", action: "draw-discard", playerId, takenCard } : undefined;
    }
    case "replace": {
      const positions = numberArray(value.positions);
      const discardedCards = knownCards(value.discardedCards);
      if (!positions || !discardedCards || !isFiniteNumber(value.replacementPosition)) return undefined;
      return { type: "action", action: "replace", playerId, positions, replacementPosition: value.replacementPosition, discardedCards };
    }
    case "exchange-mismatch": {
      const positions = numberArray(value.positions);
      const revealedCards = knownCards(value.revealedCards);
      if (!positions || !revealedCards || typeof value.penaltyCardPending !== "boolean") return undefined;
      return { type: "action", action: "exchange-mismatch", playerId, positions, revealedCards, penaltyCardPending: value.penaltyCardPending };
    }
    case "resolve-mismatch": {
      if (!isPlacement(value.drawnPlacement) || (value.penaltyPlacement !== undefined && !isPlacement(value.penaltyPlacement))) return undefined;
      return {
        type: "action",
        action: "resolve-mismatch",
        playerId,
        drawnPlacement: value.drawnPlacement,
        ...(value.penaltyPlacement ? { penaltyPlacement: value.penaltyPlacement } : {}),
      };
    }
    case "discard": {
      const discardedCard = knownCard(value.discardedCard);
      return discardedCard ? { type: "action", action: "discard", playerId, discardedCard } : undefined;
    }
    case "peek-self": return isFiniteNumber(value.position)
      ? { type: "action", action: "peek-self", playerId, position: value.position } : undefined;
    case "peek-other": return typeof value.targetPlayerId === "string" && isFiniteNumber(value.position)
      ? { type: "action", action: "peek-other", playerId, targetPlayerId: value.targetPlayerId, position: value.position } : undefined;
    case "swap": return typeof value.targetPlayerId === "string" && isFiniteNumber(value.ownPosition) && isFiniteNumber(value.targetPosition)
      ? { type: "action", action: "swap", playerId, targetPlayerId: value.targetPlayerId, ownPosition: value.ownPosition, targetPosition: value.targetPosition } : undefined;
    case "skip": return { type: "action", action: "skip", playerId };
    case "cabo": return { type: "action", action: "cabo", playerId };
    default: return undefined;
  }
}

function roundResult(value: Record<string, unknown>): RoundResult | undefined {
  const hands = handResults(value.hands);
  const roundScores = numberRecord(value.roundScores);
  const totals = numberRecord(value.totals);
  const outcome = roundOutcome(value.outcome);
  return hands && roundScores && totals && outcome
    ? { type: "round-result", hands, roundScores, totals, outcome }
    : undefined;
}

function matchResult(value: Record<string, unknown>): MatchResult | undefined {
  const totals = numberRecord(value.totals);
  return stringArray(value.winners) && totals
    ? { type: "match-result", winners: value.winners, totals }
    : undefined;
}

function handResults(value: unknown): RoundResult["hands"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hands: RoundResult["hands"] = [];
  for (const hand of value) {
    if (!isRecord(hand) || typeof hand.playerId !== "string" || !isFiniteNumber(hand.handScore)) return undefined;
    const cards = knownCards(hand.cards);
    if (!cards) return undefined;
    hands.push({ playerId: hand.playerId, cards, handScore: hand.handScore });
  }
  return hands;
}

function roundOutcome(value: unknown): RoundResult["outcome"] | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "cabo" && typeof value.callerId === "string" && typeof value.succeeded === "boolean") {
    return { type: "cabo", callerId: value.callerId, succeeded: value.succeeded };
  }
  if (value.type === "shooting-the-moon" && typeof value.playerId === "string") {
    return { type: "shooting-the-moon", playerId: value.playerId };
  }
  return undefined;
}

function knownCards(value: unknown): KnownCard[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cards: KnownCard[] = [];
  for (const valueCard of value) {
    const card = knownCard(valueCard);
    if (!card) return undefined;
    cards.push(card);
  }
  return cards;
}

function knownCard(value: unknown): KnownCard | undefined {
  return isRecord(value) && typeof value.label === "string" && isFiniteNumber(value.rank)
    ? { label: value.label, rank: value.rank }
    : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every(isFiniteNumber) ? value : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, score] of Object.entries(value)) {
    if (!isFiniteNumber(score)) return undefined;
    result[key] = score;
  }
  return result;
}

function isPlacement(value: unknown): value is "left" | "right" {
  return value === "left" || value === "right";
}

function isGamePhase(value: unknown): value is CaboStateLike["phase"] {
  return typeof value === "string" && gamePhases.has(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
