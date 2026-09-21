import { z } from "zod";
import { GAME_PHASES } from "./types.js";

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const AGENT_REQUEST_TYPES = ["rooms", "create", "join", "reconnect", "observe", "describe", "ping", "action", "leave", "shutdown"] as const;
export const AGENT_FRAME_TYPES = ["ready", "result", "observation", "event", "fatal"] as const;
export const AGENT_ACTION_TYPES = ["start", "draw-deck", "draw-discard", "replace", "discard", "peek-self", "peek-other", "swap", "skip", "cabo"] as const;

const position = z.number().int().min(1).max(4);
const targetScore = z.number().int().min(20).max(500);

export const roomOptionsSchema = z.object({
  name: z.string().trim().min(1).max(20),
  visibility: z.enum(["public", "private"]).default("public"),
  targetScore: targetScore.default(100),
  password: z.string().regex(/^\d{6}$/).optional(),
});

export const joinOptionsSchema = z.object({
  name: z.string().trim().min(1).max(20),
  password: z.string().regex(/^\d{6}$/).optional(),
});

const agentActionVariants = [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("draw-deck") }),
  z.object({ type: z.literal("draw-discard"), position }),
  z.object({ type: z.literal("replace"), position }),
  z.object({ type: z.literal("discard") }),
  z.object({ type: z.literal("peek-self"), position }),
  z.object({ type: z.literal("peek-other"), targetPlayerId: z.string().min(1), position }),
  z.object({ type: z.literal("swap"), targetPlayerId: z.string().min(1), position }),
  z.object({ type: z.literal("skip") }),
  z.object({ type: z.literal("cabo") }),
] as const;

export const agentActionSchema = z.discriminatedUnion("type", agentActionVariants);

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
  z.object({ id: requestId, type: z.literal("create"), visibility: z.enum(["public", "private"]), targetScore: targetScore.default(100), password: z.string().regex(/^\d{6}$/).optional() }).strict(),
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
  selfId: z.string(),
  revision: z.number().int().nonnegative(),
  state: z.object({
    phase: z.enum(GAME_PHASES),
    round: z.number().int().nonnegative(),
    targetScore,
    currentPlayerId: z.string().nullable(),
    caboCallerId: z.string().nullable(),
    discardTop: displayCardSchema.nullable(),
    deckCount: z.number().int().nonnegative(),
    players: z.array(playerObservationSchema),
    winners: z.array(z.string()),
  }).strict(),
  knowledge: z.object({
    round: z.number().int().nonnegative(),
    slots: z.array(displayCardSchema.nullable()).length(4),
    opponents: z.array(z.object({
      playerId: z.string(),
      slots: z.array(displayCardSchema.nullable()).length(4),
    }).strict()),
    held: displayCardSchema.nullable(),
  }).strict(),
  legalActions: z.array(agentActionSchema),
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

const agentResultFrameSchema = z.union([
  z.object({ type: z.literal("result"), id: z.string(), ok: z.literal(true), data: z.unknown().optional() }).strict(),
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
