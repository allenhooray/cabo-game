import { isStoredKnowledge, type StoredKnowledge } from "./knowledge.js";

export interface SavedSession {
  server: string;
  name: string;
  roomId: string;
  token: string;
  knowledge?: StoredKnowledge;
}

export interface SessionStore {
  load(): Promise<SavedSession | undefined>;
  save(session: SavedSession): Promise<void>;
  clear(): Promise<void>;
}

export function parseSavedSession(value: unknown): SavedSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<SavedSession>;
  if (typeof data.server !== "string" || typeof data.name !== "string" || typeof data.roomId !== "string" || typeof data.token !== "string") {
    return undefined;
  }
  const session: SavedSession = { server: data.server, name: data.name, roomId: data.roomId, token: data.token };
  if (isStoredKnowledge(data.knowledge)) session.knowledge = data.knowledge;
  return session;
}
