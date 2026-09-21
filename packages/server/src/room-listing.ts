import type { GamePhase } from "@cabo-game/shared";

export interface PublicRoomListingSource {
  roomId: string;
  locked?: boolean;
  metadata?: {
    visibility?: string;
    roomName?: string;
    phase?: string;
    targetScore?: number;
    playerCount?: number;
    maxClients?: number;
  };
}

export interface PublicRoomListing {
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

export function toPublicRoomListing(room: PublicRoomListingSource): PublicRoomListing | undefined {
  const metadata = room.metadata;
  if (metadata?.visibility !== "public" || typeof metadata.roomName !== "string" || typeof metadata.phase !== "string") return undefined;
  const targetScore = metadata.targetScore ?? 100;
  const playerCount = metadata.playerCount ?? 0;
  const maxClients = metadata.maxClients ?? 4;
  const isFull = playerCount >= maxClients;
  const isStarted = metadata.phase !== "LOBBY";
  return {
    roomId: room.roomId,
    roomName: metadata.roomName,
    targetScore,
    playerCount,
    maxClients,
    phase: metadata.phase as GamePhase,
    isFull,
    isStarted,
    canJoin: !isFull && !isStarted && !room.locked,
  };
}
