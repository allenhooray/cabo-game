export interface StatePlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  connected: boolean;
  forfeited: boolean;
  cardCount: number;
  isHost: boolean;
}

export interface CaboStateLike {
  phase: string;
  round: number;
  targetScore: number;
  currentPlayerId: string;
  caboCallerId: string;
  discardLabel: string;
  discardRank: number;
  deckCount: number;
  players: Map<string, StatePlayer>;
  winners: string[];
}

export interface ListedRoom {
  roomId: string;
  targetScore: number;
  playerCount: number;
  maxClients: number;
}

export interface DisplayCard {
  label: string;
  rank: number;
}

export interface RoundResultView {
  lines: string[];
  nextRoundPending: boolean;
}
