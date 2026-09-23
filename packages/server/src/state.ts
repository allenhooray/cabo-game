import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string().default(""),
    name: t.string().default(""),
    seat: t.number().default(0),
    score: t.number().default(0),
    connected: t.boolean().default(true),
    forfeited: t.boolean().default(false),
    nextRoundReady: t.boolean().default(false),
    cardCount: t.number().default(0),
    isHost: t.boolean().default(false),
    isBot: t.boolean().default(false),
    botPersona: t.string().default(""),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const RoundHistoryCardState = schema(
  {
    label: t.string().default(""),
    rank: t.number().default(0),
  },
  "RoundHistoryCardState",
);
export type RoundHistoryCardState = SchemaType<typeof RoundHistoryCardState>;

export const RoundHistoryPlayerState = schema(
  {
    playerId: t.string().default(""),
    roundScore: t.number().default(0),
    totalScore: t.number().default(0),
    handScore: t.number().default(0),
    cards: t.array(RoundHistoryCardState),
  },
  "RoundHistoryPlayerState",
);
export type RoundHistoryPlayerState = SchemaType<typeof RoundHistoryPlayerState>;

export const RoundHistoryEntryState = schema(
  {
    round: t.number().default(0),
    outcomeType: t.string().default("cabo"),
    outcomePlayerId: t.string().default(""),
    caboSucceeded: t.boolean().default(false),
    players: t.array(RoundHistoryPlayerState),
  },
  "RoundHistoryEntryState",
);
export type RoundHistoryEntryState = SchemaType<typeof RoundHistoryEntryState>;

export const CaboState = schema(
  {
    memoryMode: t.string().default("classic"),
    turnDurationSeconds: t.number().default(60),
    deadlineAt: t.number().default(0),
    serverTime: t.number().default(0),
    revision: t.number().default(0),
    pendingBotCount: t.number().default(0),
    roomName: t.string().default(""),
    phase: t.string().default("LOBBY"),
    round: t.number().default(0),
    targetScore: t.number().default(100),
    currentPlayerId: t.string().default(""),
    caboCallerId: t.string().default(""),
    drawSource: t.string().default(""),
    mismatchPenaltyCardPending: t.boolean().default(false),
    discardLabel: t.string().default(""),
    discardRank: t.number().default(-1),
    deckCount: t.number().default(0),
    players: t.map(PlayerState),
    winners: t.array("string"),
    roundHistory: t.array(RoundHistoryEntryState),
  },
  "CaboState",
);
export type CaboState = SchemaType<typeof CaboState>;
