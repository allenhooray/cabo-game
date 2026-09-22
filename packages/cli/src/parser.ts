import type { ClientCommand, MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";

export type LocalCommand =
  | { kind: "help" }
  | { kind: "rooms" }
  | { kind: "create"; visibility: "public" | "private"; targetScore: number; roomName?: string; memoryMode: MemoryMode; turnDurationSeconds: TurnDurationSeconds }
  | { kind: "join"; roomId: string; password?: string }
  | { kind: "reconnect" }
  | { kind: "show" }
  | { kind: "players" }
  | { kind: "leave" }
  | { kind: "chat"; text?: string }
  | { kind: "quit" }
  | { kind: "game"; command: ClientCommand; targetName?: string };

const position = (raw: string | undefined): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error("Position must be a positive integer.");
  return value;
};

const placement = (raw: string | undefined): "left" | "right" => {
  if (raw !== "left" && raw !== "right") throw new Error("Placement must be left or right.");
  return raw;
};

export function parseCommand(input: string): LocalCommand {
  const chat = input.trim().match(/^chat(?:\s+([\s\S]*))?$/i);
  if (chat) return { kind: "chat", ...(chat[1] !== undefined ? { text: chat[1] } : {}) };
  const parts = tokenize(input);
  const [verb, ...args] = parts;
  switch (verb?.toLowerCase()) {
    case "help":
    case "?":
      return { kind: "help" };
    case "rooms":
      return { kind: "rooms" };
    case "create": {
      const visibility = args[0]?.toLowerCase();
      if (visibility !== "public" && visibility !== "private") throw new Error('Usage: create public|private [target] --name "room name".');
      let targetScore = 100;
      let memoryMode: MemoryMode = "classic";
      let turnDurationSeconds: TurnDurationSeconds = 60;
      let roomName: string | undefined;
      let sawTarget = false;
      let sawName = false;
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--mode") {
          const mode = args[++index];
          if (mode !== "classic" && mode !== "assisted") throw new Error("Mode must be classic or assisted.");
          memoryMode = mode;
          continue;
        }
        if (arg === "--timer") {
          const duration = Number(args[++index]);
          if (![0, 30, 60, 90].includes(duration)) throw new Error("Timer must be 0, 30, 60 or 90 seconds.");
          turnDurationSeconds = duration as TurnDurationSeconds;
          continue;
        }
        if (arg === "--name") {
          if (sawName) throw new Error("--name may only be specified once.");
          if (index + 1 >= args.length || args[index + 1]?.startsWith("--")) throw new Error("--name requires a room name.");
          sawName = true;
          roomName = args[index + 1] as string;
          index += 1;
          continue;
        }
        if (arg?.startsWith("--")) throw new Error(`Unknown create option: ${arg}.`);
        if (sawTarget) throw new Error('Usage: create public|private [target] --name "room name".');
        targetScore = Number(arg);
        sawTarget = true;
      }
      if (!Number.isInteger(targetScore) || targetScore < 20 || targetScore > 500) throw new Error("Target must be an integer from 20 to 500.");
      return { kind: "create", visibility, targetScore, memoryMode, turnDurationSeconds, ...(roomName !== undefined ? { roomName } : {}) };
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
    case "ready":
      return { kind: "game", command: { type: "ready-next-round" } };
    case "draw":
      if (args[0] === "deck") return { kind: "game", command: { type: "draw-deck" } };
      if (args[0] === "discard" && args.length === 1) return { kind: "game", command: { type: "draw-discard" } };
      throw new Error("Usage: draw deck | draw discard.");
    case "replace": {
      const at = args.indexOf("at");
      const rawPositions = at >= 0 ? args.slice(0, at) : args;
      if (!rawPositions.length || rawPositions.length > 4 || (at >= 0 && at !== args.length - 2)) {
        throw new Error("Usage: replace POS [POS ...] [at POS].");
      }
      const positions = rawPositions.map(position);
      const replacementPosition = at >= 0 ? position(args[at + 1]) : positions[0] as number;
      if (new Set(positions).size !== positions.length) throw new Error("Positions must be unique.");
      if (!positions.includes(replacementPosition)) throw new Error("The replacement position must be selected.");
      return { kind: "game", command: { type: "replace", positions, replacementPosition } };
    }
    case "resolve":
      return {
        kind: "game",
        command: {
          type: "resolve-mismatch",
          drawnPlacement: placement(args[0]),
          ...(args[1] ? { penaltyPlacement: placement(args[1]) } : {}),
        },
      };
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
      if (args.length !== 3 || !args[0]) throw new Error("Usage: swap PLAYER OWN_POSITION TARGET_POSITION.");
      return {
        kind: "game",
        targetName: args[0],
        command: { type: "swap", targetPlayerId: "", ownPosition: position(args[1]), targetPosition: position(args[2]) },
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

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of input.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped) throw new Error("Command cannot end with an escape character.");
  if (quote) throw new Error("Room name has an unclosed quote.");
  if (started) tokens.push(token);
  return tokens;
}
