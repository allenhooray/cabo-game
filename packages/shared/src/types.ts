export const GAME_PHASES = [
  "LOBBY",
  "INITIAL_REVEAL",
  "TURN_START",
  "DRAWN",
  "MISMATCH_PENDING",
  "POWER_PENDING",
  "TURN_END",
  "FINAL_TURNS",
  "ROUND_RESULT",
  "MATCH_RESULT",
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];
export type MemoryMode = "classic" | "assisted";
export type TurnDurationSeconds = 0 | 30 | 60 | 90;
export type Position = number;
export type DrawSource = "deck" | "discard";
export type EndPlacement = "left" | "right";
export type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface Card {
  id: string;
  rank: Rank;
  label: string;
}

export interface KnownCard {
  rank: number;
  label: string;
}

export type KnownSlots = Array<KnownCard | null>;

export interface OpponentKnowledge {
  playerId: string;
  slots: KnownSlots;
}

export interface PrivateKnowledgeSnapshot {
  memoryMode: MemoryMode;
  round: number;
  slots: KnownSlots;
  opponents: OpponentKnowledge[];
  held: KnownCard | null;
}

export type PublicActionEvent =
  | { type: "action"; action: "draw-deck"; playerId: string }
  | { type: "action"; action: "draw-discard"; playerId: string; takenCard: KnownCard }
  | {
      type: "action";
      action: "replace";
      playerId: string;
      positions: Position[];
      replacementPosition: Position;
      discardedCards: KnownCard[];
      insertedCard?: KnownCard;
    }
  | {
      type: "action";
      action: "exchange-mismatch";
      playerId: string;
      positions: Position[];
      revealedCards: KnownCard[];
      penaltyCardPending: boolean;
    }
  | {
      type: "action";
      action: "resolve-mismatch";
      playerId: string;
      drawnPlacement: EndPlacement;
      penaltyPlacement?: EndPlacement;
      insertedCard?: KnownCard;
    }
  | { type: "action"; action: "discard"; playerId: string; discardedCard: KnownCard }
  | { type: "action"; action: "peek-self"; playerId: string; position: Position }
  | { type: "action"; action: "peek-other"; playerId: string; targetPlayerId: string; position: Position }
  | { type: "action"; action: "swap"; playerId: string; targetPlayerId: string; ownPosition: Position; targetPosition: Position }
  | { type: "action"; action: "skip"; playerId: string }
  | { type: "action"; action: "cabo"; playerId: string };

export interface EnginePlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  forfeited: boolean;
  hand: Card[];
}

export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  forfeited: boolean;
  cardCount: number;
}

export interface PublicGameSnapshot {
  phase: GamePhase;
  round: number;
  targetScore: number;
  currentPlayerId?: string;
  caboCallerId?: string;
  drawSource?: DrawSource;
  mismatchPenaltyCardPending: boolean;
  discardTop?: Card;
  deckCount: number;
  players: PublicPlayer[];
  winners: string[];
}

export type EngineEvent =
  | { type: "private-reveal"; playerId: string; card: Card; position?: Position; reason: "initial" | "draw" | "peek" }
  | { type: "turn"; playerId: string; finalTurn: boolean }
  | { type: "discard"; playerId: string; card: Card }
  | { type: "exchange-mismatch"; playerId: string; positions: Position[]; cards: Card[]; penaltyCardPending: boolean }
  | { type: "mismatch-resolved"; playerId: string; drawnPlacement: EndPlacement; penaltyPlacement?: EndPlacement }
  | { type: "swap"; playerId: string; targetPlayerId: string; ownPosition: Position; targetPosition: Position }
  | { type: "cabo"; playerId: string }
  | { type: "forfeit"; playerId: string }
  | {
      type: "round-result";
      hands: Array<{ playerId: string; cards: Card[]; handScore: number }>;
      roundScores: Record<string, number>;
      totals: Record<string, number>;
      outcome:
        | { type: "cabo"; callerId: string; succeeded: boolean }
        | { type: "shooting-the-moon"; playerId: string };
    }
  | { type: "match-result"; winners: string[]; totals: Record<string, number> };

export const ERROR_CODES = [
  "INVALID_COMMAND",
  "INVALID_PHASE",
  "NOT_YOUR_TURN",
  "INVALID_POSITION",
  "INVALID_TARGET",
  "INVALID_POWER",
  "ROOM_FULL",
  "ROOM_STARTED",
  "NOT_HOST",
  "NOT_ENOUGH_PLAYERS",
  "NICKNAME_TAKEN",
  "INVALID_PASSWORD",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class GameRuleError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameRuleError";
  }
}
