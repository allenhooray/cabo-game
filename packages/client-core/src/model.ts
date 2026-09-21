import type { GamePhase } from "@cabo-game/shared";

export interface StatePlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  connected: boolean;
  forfeited: boolean;
  nextRoundReady: boolean;
  cardCount: number;
  isHost: boolean;
}

export interface CaboStateLike {
  revision: number;
  roomName: string;
  phase: GamePhase;
  round: number;
  targetScore: number;
  currentPlayerId: string;
  caboCallerId: string;
  drawSource: "deck" | "discard" | "";
  mismatchPenaltyCardPending: boolean;
  discardLabel: string;
  discardRank: number;
  deckCount: number;
  players: Map<string, StatePlayer>;
  winners: string[];
}

export interface ListedRoom {
  roomId: string;
  roomName: string;
  targetScore: number;
  playerCount: number;
  maxClients: number;
  phase: GamePhase;
  isFull: boolean;
  isStarted: boolean;
  canJoin: boolean;
}

/** Room-list payload accepted from both current and pre-room-name servers. */
export interface ListedRoomResponse {
  roomId: string;
  locked?: boolean;
  roomName?: string;
  targetScore: number;
  playerCount: number;
  maxClients: number;
  phase?: GamePhase;
  isFull?: boolean;
  isStarted?: boolean;
  canJoin?: boolean;
}

export interface DisplayCard {
  label: string;
  rank: number;
}

export interface RoundResultView {
  lines: string[];
  nextRoundPending: boolean;
}
