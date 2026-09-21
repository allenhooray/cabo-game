import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema(
  {
    id: t.string().default(""),
    name: t.string().default(""),
    seat: t.number().default(0),
    score: t.number().default(0),
    connected: t.boolean().default(true),
    forfeited: t.boolean().default(false),
    cardCount: t.number().default(0),
    isHost: t.boolean().default(false),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const CaboState = schema(
  {
    revision: t.number().default(0),
    roomName: t.string().default(""),
    phase: t.string().default("LOBBY"),
    round: t.number().default(0),
    targetScore: t.number().default(100),
    currentPlayerId: t.string().default(""),
    caboCallerId: t.string().default(""),
    discardLabel: t.string().default(""),
    discardRank: t.number().default(-1),
    deckCount: t.number().default(0),
    players: t.map(PlayerState),
    winners: t.array("string"),
  },
  "CaboState",
);
export type CaboState = SchemaType<typeof CaboState>;
