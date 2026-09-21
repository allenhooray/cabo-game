import { readFile } from "node:fs/promises";
import { DEFAULT_SERVER_URL } from "@cabo-game/client-core";

export type CaboDiscoveryMode = "help" | "version" | undefined;

export function caboDiscoveryMode(args: string[]): CaboDiscoveryMode {
  if (args.includes("--help") || args.includes("-h")) return "help";
  if (args.includes("--version") || args.includes("-v")) return "version";
  return undefined;
}

export async function readCliVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("CLI package version is unavailable.");
  return packageJson.version;
}

export function caboHelpLines(): string[] {
  return [
    "Usage: cabo [--server URL] [--name NAME] [-h|--help] [-v|--version]",
    `Options: --server URL (default: ${DEFAULT_SERVER_URL}) | --name NAME (default: current OS user)`,
    'Connection: rooms | create public|private [target] --name "room name" | join ROOM [password] | reconnect | quit',
    "Lobby:      players | start | leave",
    "Game:       show | draw deck | draw discard | replace POS [POS ...] [at POS] | resolve LEFT [PENALTY] | discard",
    "            peek self POS | peek PLAYER POS | swap PLAYER POS | skip | cabo | ready",
    "Positions follow the current hand size. Player arguments accept an exact nickname or session id; type cancel to leave a guided prompt.",
    "Want an Agent to play? Ask it to use the cabo-agent command.",
  ];
}

export function renderCaboHelp(): string {
  return caboHelpLines().join("\n");
}
