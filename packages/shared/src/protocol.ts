import { z } from "zod";

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

export const clientCommandSchema = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("leave") }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type RoomOptions = z.infer<typeof roomOptionsSchema>;
export type JoinOptions = z.infer<typeof joinOptionsSchema>;

export interface ErrorMessage {
  code: string;
  message: string;
}

export interface PrivateRevealMessage {
  card: { id: string; rank: number; label: string };
  position?: number;
  reason: "initial" | "draw" | "peek";
}
