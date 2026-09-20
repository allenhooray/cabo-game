export const GAME_PHASES = [
  "LOBBY",
  "INITIAL_REVEAL",
  "TURN_START",
  "DRAWN",
  "POWER_PENDING",
  "TURN_END",
  "FINAL_TURNS",
  "ROUND_RESULT",
  "MATCH_RESULT",
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];
export type Position = 1 | 2 | 3 | 4;
export type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface Card {
  id: string;
  rank: Rank;
  label: string;
}

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
  discardTop?: Card;
  deckCount: number;
  players: PublicPlayer[];
  winners: string[];
}

export type EngineEvent =
  | { type: "private-reveal"; playerId: string; card: Card; position?: Position; reason: "initial" | "draw" | "peek" }
  | { type: "turn"; playerId: string; finalTurn: boolean }
  | { type: "discard"; playerId: string; card: Card }
  | { type: "swap"; playerId: string; targetPlayerId: string; position: Position }
  | { type: "cabo"; playerId: string }
  | { type: "forfeit"; playerId: string }
  | {
      type: "round-result";
      hands: Array<{ playerId: string; cards: Card[]; handScore: number }>;
      roundScores: Record<string, number>;
      totals: Record<string, number>;
      caboSucceeded: boolean;
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
