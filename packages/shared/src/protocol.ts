import { z } from "zod";
import { GAME_PHASES } from "./types.js";

export const AGENT_PROTOCOL_VERSION = 4 as const;
export const AGENT_REQUEST_TYPES = ["rooms", "create", "join", "reconnect", "observe", "describe", "ping", "action", "leave", "shutdown"] as const;
export const AGENT_FRAME_TYPES = ["ready", "result", "observation", "event", "fatal"] as const;
export const AGENT_ACTION_TYPES = ["start", "draw-deck", "draw-discard", "replace", "resolve-mismatch", "discard", "peek-self", "peek-other", "swap", "skip", "cabo"] as const;

const position = z.number().int().min(1);
const placement = z.enum(["left", "right"]);
const targetScore = z.number().int().min(20).max(500);
export const roomNameSchema = z.string().refine(
  (value) => Array.from(value.trim()).length <= 40,
  "Room name must contain at most 40 characters.",
).meta({ maxLength: 40, description: "A room label of at most 40 Unicode characters; surrounding whitespace is ignored by the server." });

export const roomOptionsSchema = z.object({
  name: z.string().trim().min(1).max(20),
  roomName: roomNameSchema.optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  targetScore: targetScore.default(100),
  password: z.string().regex(/^\d{6}$/).optional(),
});

export const joinOptionsSchema = z.object({
  name: z.string().trim().min(1).max(20),
  password: z.string().regex(/^\d{6}$/).optional(),
});

const agentActionVariants = [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("draw-deck") }).strict(),
  z.object({ type: z.literal("draw-discard") }).strict(),
  z.object({
    type: z.literal("replace"),
    positions: z.array(position).min(1).max(4),
    replacementPosition: position,
  }).strict(),
  z.object({
    type: z.literal("resolve-mismatch"),
    drawnPlacement: placement,
    penaltyPlacement: placement.optional(),
  }).strict(),
  z.object({ type: z.literal("discard") }).strict(),
  z.object({ type: z.literal("peek-self"), position }).strict(),
  z.object({ type: z.literal("peek-other"), targetPlayerId: z.string().min(1), position }).strict(),
  z.object({ type: z.literal("swap"), targetPlayerId: z.string().min(1), position }).strict(),
  z.object({ type: z.literal("skip") }).strict(),
  z.object({ type: z.literal("cabo") }).strict(),
] as const;

export const agentActionSchema = z.discriminatedUnion("type", agentActionVariants);

const legalActionSchema = z.union([
  agentActionVariants[0],
  agentActionVariants[1],
  agentActionVariants[2],
  agentActionVariants[5],
  agentActionVariants[6],
  agentActionVariants[7],
  agentActionVariants[8],
  agentActionVariants[9],
  agentActionVariants[10],
  z.object({
    type: z.literal("replace"),
    selectablePositions: z.array(position),
    minSelections: z.literal(1),
    maxSelections: z.number().int().min(1).max(4),
  }).strict(),
  z.object({
    type: z.literal("resolve-mismatch"),
    placements: z.tuple([z.literal("left"), z.literal("right")]),
    penaltyCardPending: z.boolean(),
  }).strict(),
]);

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...agentActionVariants,
  z.object({ type: z.literal("leave") }),
]);

export const agentCommandRequestSchema = z.object({
  id: z.string().trim().min(1),
  command: agentActionSchema,
});

const requestId = z.string().trim().min(1);
export const agentRequestSchema = z.discriminatedUnion("type", [
  z.object({ id: requestId, type: z.literal("rooms") }).strict(),
  z.object({ id: requestId, type: z.literal("create"), visibility: z.enum(["public", "private"]), targetScore: targetScore.default(100), roomName: roomNameSchema.optional(), password: z.string().regex(/^\d{6}$/).optional() }).strict(),
  z.object({ id: requestId, type: z.literal("join"), roomId: z.string().min(1), password: z.string().regex(/^\d{6}$/).optional() }).strict(),
  z.object({ id: requestId, type: z.literal("reconnect") }).strict(),
  z.object({ id: requestId, type: z.literal("observe") }).strict(),
  z.object({ id: requestId, type: z.literal("describe") }).strict(),
  z.object({ id: requestId, type: z.literal("ping") }).strict(),
  z.object({ id: requestId, type: z.literal("action"), action: agentActionSchema }).strict(),
  z.object({ id: requestId, type: z.literal("leave") }).strict(),
  z.object({ id: requestId, type: z.literal("shutdown") }).strict(),
]);

const displayCardSchema = z.object({ label: z.string(), rank: z.number().int().min(0).max(13) }).strict();
const errorMessageSchema = z.object({ code: z.string(), message: z.string() }).strict();
const playerObservationSchema = z.object({
  id: z.string(),
  name: z.string(),
  seat: z.number().int().nonnegative(),
  score: z.number(),
  connected: z.boolean(),
  forfeited: z.boolean(),
  cardCount: z.number().int().nonnegative(),
  isHost: z.boolean(),
}).strict();

export const agentObservationSchema = z.object({
  roomId: z.string(),
  roomName: z.string(),
  selfId: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.object({
    phase: z.enum(GAME_PHASES),
    round: z.number().int().nonnegative(),
    targetScore,
    currentPlayerId: z.string().nullable(),
    caboCallerId: z.string().nullable(),
    drawSource: z.enum(["deck", "discard"]).nullable(),
    mismatchPenaltyCardPending: z.boolean(),
    discardTop: displayCardSchema.nullable(),
    deckCount: z.number().int().nonnegative(),
    players: z.array(playerObservationSchema),
    winners: z.array(z.string()),
  }).strict(),
  knowledge: z.object({
    round: z.number().int().nonnegative(),
    slots: z.array(displayCardSchema.nullable()),
    opponents: z.array(z.object({
      playerId: z.string(),
      slots: z.array(displayCardSchema.nullable()),
    }).strict()),
    held: displayCardSchema.nullable(),
  }).strict(),
  legalActions: z.array(legalActionSchema),
}).strict();

export const agentReadyFrameSchema = z.object({
  type: z.literal("ready"),
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  cliVersion: z.string(),
  server: z.string(),
  name: z.string(),
  sessionPersistence: z.boolean(),
  requestTimeoutMs: z.number().int(),
  capabilities: z.array(z.enum(["describe", "ping", "json-schema", "request-timeout"])),
}).strict();

const listedRoomSchema = z.object({
  roomId: z.string(),
  roomName: z.string(),
  targetScore,
  playerCount: z.number().int().nonnegative(),
  maxClients: z.number().int().positive(),
  phase: z.enum(GAME_PHASES),
  isFull: z.boolean(),
  isStarted: z.boolean(),
  canJoin: z.boolean(),
}).strict();

const agentSuccessDataSchema = z.union([
  z.object({ rooms: z.array(listedRoomSchema) }).strict(),
  z.object({ roomId: z.string(), roomName: z.string(), selfId: z.string() }).strict(),
  agentObservationSchema,
  z.object({ revision: z.number().int().nonnegative() }).strict(),
  z.object({
    connected: z.boolean(),
    server: z.string(),
    roomId: z.string().nullable(),
    roomName: z.string().nullable(),
    selfId: z.string().nullable(),
    revision: z.number().int().nonnegative().nullable(),
    phase: z.enum(GAME_PHASES).nullable(),
  }).strict(),
  z.object({
    protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
    cliVersion: z.string(),
    requestTypes: z.array(z.enum(AGENT_REQUEST_TYPES)),
    frameTypes: z.array(z.enum(AGENT_FRAME_TYPES)),
    actionTypes: z.array(z.enum(AGENT_ACTION_TYPES)),
    defaults: z.object({
      server: z.string(),
      requestTimeoutMs: z.number().int(),
      sessionPersistence: z.boolean(),
    }).strict(),
    schemaCommand: z.string(),
  }).strict(),
]);

const agentResultFrameSchema = z.union([
  z.object({ type: z.literal("result"), id: z.string(), ok: z.literal(true), data: agentSuccessDataSchema.optional() }).strict(),
  z.object({
    type: z.literal("result"),
    id: z.string().nullable(),
    ok: z.literal(false),
    error: errorMessageSchema,
    revision: z.number().int().nonnegative().optional(),
    uncertain: z.boolean().optional(),
  }).strict(),
]);

const agentObservationFrameSchema = agentObservationSchema.extend({ type: z.literal("observation") }).strict();
const agentEventFrameSchema = z.object({
  type: z.literal("event"),
  event: z.object({ type: z.string() }).catchall(z.unknown()),
}).strict();
const agentFatalFrameSchema = z.object({ type: z.literal("fatal"), error: errorMessageSchema }).strict();

export const agentFrameSchema = z.union([
  agentReadyFrameSchema,
  agentResultFrameSchema,
  agentObservationFrameSchema,
  agentEventFrameSchema,
  agentFatalFrameSchema,
]);

export const agentWireSchema = z.union([agentRequestSchema, agentFrameSchema]);

export function agentProtocolJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(agentWireSchema),
    $id: `urn:cabo:agent-protocol:v${AGENT_PROTOCOL_VERSION}`,
    title: `Cabo Agent JSONL Protocol v${AGENT_PROTOCOL_VERSION}`,
    description: "A single request or output frame in the Cabo Agent JSONL protocol.",
  };
}

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type AgentAction = z.infer<typeof agentActionSchema>;
export type LegalAction =
  | Exclude<AgentAction, { type: "replace" | "resolve-mismatch" }>
  | { type: "replace"; selectablePositions: number[]; minSelections: 1; maxSelections: number }
  | { type: "resolve-mismatch"; placements: ["left", "right"]; penaltyCardPending: boolean };
export type AgentCommandRequest = z.infer<typeof agentCommandRequestSchema>;
export type AgentRequest = z.infer<typeof agentRequestSchema>;
export type AgentObservation = z.infer<typeof agentObservationSchema>;
export type AgentFrame = z.infer<typeof agentFrameSchema>;
export type RoomOptions = z.infer<typeof roomOptionsSchema>;
export type JoinOptions = z.infer<typeof joinOptionsSchema>;

export type AgentCommandResult =
  | { id: string; ok: true; revision: number }
  | { id: string; ok: false; revision: number; error: ErrorMessage };

export interface ErrorMessage {
  code: string;
  message: string;
}

export interface PrivateRevealMessage {
  card: { id: string; rank: number; label: string };
  position?: number;
  reason: "initial" | "draw" | "peek";
}
