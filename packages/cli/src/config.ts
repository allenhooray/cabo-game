import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SavedSession {
  server: string;
  name: string;
  roomId: string;
  token: string;
}

export function defaultSessionPath(): string {
  return join(homedir(), ".config", "cabo", "session.json");
}

export async function saveSession(session: SavedSession, path = defaultSessionPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadSession(path = defaultSessionPath()): Promise<SavedSession | undefined> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as Partial<SavedSession>;
    if (typeof data.server !== "string" || typeof data.name !== "string" || typeof data.roomId !== "string" || typeof data.token !== "string") {
      return undefined;
    }
    return data as SavedSession;
  } catch {
    return undefined;
  }
}

export async function clearSession(path = defaultSessionPath()): Promise<void> {
  await rm(path, { force: true });
}
