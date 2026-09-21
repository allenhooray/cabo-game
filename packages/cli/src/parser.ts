import type { ClientCommand } from "@cabo-game/shared";

export type LocalCommand =
  | { kind: "help" }
  | { kind: "rooms" }
  | { kind: "create"; visibility: "public" | "private"; targetScore: number }
  | { kind: "join"; roomId: string; password?: string }
  | { kind: "reconnect" }
  | { kind: "show" }
  | { kind: "players" }
  | { kind: "leave" }
  | { kind: "quit" }
  | { kind: "game"; command: ClientCommand; targetName?: string };

const position = (raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("Position must be 1, 2, 3, or 4.");
  return value;
};

export function parseCommand(input: string): LocalCommand {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  const [verb, ...args] = parts;
  switch (verb?.toLowerCase()) {
    case "help":
    case "?":
      return { kind: "help" };
    case "rooms":
      return { kind: "rooms" };
    case "create": {
      const visibility = args[0]?.toLowerCase();
      if (visibility !== "public" && visibility !== "private") throw new Error("Usage: create public|private [target].");
      const targetScore = args[1] === undefined ? 100 : Number(args[1]);
      if (!Number.isInteger(targetScore) || targetScore < 20 || targetScore > 500) throw new Error("Target must be an integer from 20 to 500.");
      return { kind: "create", visibility, targetScore };
    }
    case "join":
      if (!args[0]) throw new Error("Usage: join ROOM_CODE [password].");
      return { kind: "join", roomId: args[0], ...(args[1] ? { password: args[1] } : {}) };
    case "reconnect":
      return { kind: "reconnect" };
    case "show":
      return { kind: "show" };
    case "players":
      return { kind: "players" };
    case "leave":
      return { kind: "leave" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "start":
      return { kind: "game", command: { type: "start" } };
    case "draw":
      if (args[0] === "deck") return { kind: "game", command: { type: "draw-deck" } };
      if (args[0] === "discard") return { kind: "game", command: { type: "draw-discard", position: position(args[1]) } };
      throw new Error("Usage: draw deck | draw discard POSITION.");
    case "replace":
      return { kind: "game", command: { type: "replace", position: position(args[0]) } };
    case "discard":
      return { kind: "game", command: { type: "discard" } };
    case "peek":
      if (args[0] === "self") return { kind: "game", command: { type: "peek-self", position: position(args[1]) } };
      if (!args[0]) throw new Error("Usage: peek self POSITION | peek PLAYER POSITION.");
      return {
        kind: "game",
        targetName: args[0],
        command: { type: "peek-other", targetPlayerId: "", position: position(args[1]) },
      };
    case "swap":
      if (!args[0]) throw new Error("Usage: swap PLAYER POSITION.");
      return {
        kind: "game",
        targetName: args[0],
        command: { type: "swap", targetPlayerId: "", position: position(args[1]) },
      };
    case "skip":
      return { kind: "game", command: { type: "skip" } };
    case "cabo":
      return { kind: "game", command: { type: "cabo" } };
    case undefined:
      return { kind: "help" };
    default:
      throw new Error(`Unknown command: ${verb}. Type 'help' for available commands.`);
  }
}
