import { z } from "zod";

export const ROOM_CHAT_MESSAGE_TYPE = "chat" as const;
export const ROOM_CHAT_MAX_LENGTH = 200;

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

export const roomChatInputSchema = z.object({
  text: z.string()
    .refine((value) => !controlCharacters.test(value), "Chat messages cannot contain control characters.")
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, "Chat messages cannot be empty.")
    .refine((value) => Array.from(value).length <= ROOM_CHAT_MAX_LENGTH, `Chat messages must contain at most ${ROOM_CHAT_MAX_LENGTH} characters.`),
}).strict();

export type RoomChatInput = z.infer<typeof roomChatInputSchema>;

export interface RoomChatMessage {
  sequence: number;
  playerId: string;
  playerName: string;
  text: string;
  sentAt: number;
}
