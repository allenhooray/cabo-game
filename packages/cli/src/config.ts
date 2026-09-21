import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseSavedSession, type SavedSession, type SessionStore } from "@cabo-game/client-core";

export type { SavedSession } from "@cabo-game/client-core";

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
    return parseSavedSession(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function clearSession(path = defaultSessionPath()): Promise<void> {
  await rm(path, { force: true });
}

export function createFileSessionStore(path = defaultSessionPath()): SessionStore {
  return {
    load: () => loadSession(path),
    save: (session) => saveSession(session, path),
    clear: () => clearSession(path),
  };
}
