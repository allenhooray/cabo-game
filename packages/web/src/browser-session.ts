import { DEFAULT_SERVER_URL, parseSavedSession, type SavedSession, type SessionStore } from "@cabo-game/client-core";

const SESSION_KEY = "cabo.session.v1";
const SERVER_KEY = "cabo.server.v1";
const NAME_KEY = "cabo.name.v1";

export class BrowserSessionStore implements SessionStore {
  async load(): Promise<SavedSession | undefined> {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? parseSavedSession(JSON.parse(raw)) : undefined;
    } catch {
      return undefined;
    }
  }

  async save(session: SavedSession): Promise<void> {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(SESSION_KEY);
  }
}

export function defaultServerUrl(): string {
  return normalizeServerUrl(import.meta.env.VITE_CABO_SERVER_URL || DEFAULT_SERVER_URL);
}

export function savedServerUrl(): string {
  const saved = localStorage.getItem(SERVER_KEY);
  return saved ? normalizeServerUrl(saved) : defaultServerUrl();
}

export function saveServerUrl(value: string): string {
  const normalized = validateServerUrl(value);
  localStorage.setItem(SERVER_KEY, normalized);
  return normalized;
}

export function resetServerUrl(): string {
  localStorage.removeItem(SERVER_KEY);
  return defaultServerUrl();
}

export function savedPlayerName(): string {
  const saved = localStorage.getItem(NAME_KEY)?.trim().slice(0, 20);
  if (saved) return saved;

  const generated = `Player${randomNameSuffix()}`;
  localStorage.setItem(NAME_KEY, generated);
  return generated;
}

export function savePlayerName(value: string): string {
  const normalized = value.trim().slice(0, 20);
  localStorage.setItem(NAME_KEY, normalized);
  return normalized;
}

export function validateServerUrl(value: string): string {
  const normalized = normalizeServerUrl(value);
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http:// or https:// server address.");
  if (window.location.protocol === "https:" && url.protocol !== "https:") {
    throw new Error("An HTTPS page can only connect to an HTTPS game server.");
  }
  return normalized;
}

function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function randomNameSuffix(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const values = new Uint32Array(4);

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) values[index] = Math.floor(Math.random() * alphabet.length);
  }

  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}
