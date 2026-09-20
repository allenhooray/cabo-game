#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import type { ClientCommand, ErrorMessage, PrivateRevealMessage } from "@cabo/shared";
import { Client, type Room } from "@colyseus/sdk";
import { clearSession, loadSession, saveSession } from "./config.js";
import { parseCommand, type LocalCommand } from "./parser.js";

interface StatePlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
  connected: boolean;
  forfeited: boolean;
  cardCount: number;
  isHost: boolean;
}

interface CaboStateLike {
  phase: string;
  round: number;
  targetScore: number;
  currentPlayerId: string;
  caboCallerId: string;
  discardLabel: string;
  deckCount: number;
  players: Map<string, StatePlayer>;
  winners: string[];
}

interface ListedRoom {
  roomId: string;
  targetScore: number;
  playerCount: number;
  maxClients: number;
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
}

const serverUrl = option("--server", "http://localhost:2567").replace(/\/$/, "");
const playerName = option("--name", process.env.USER ?? "Player").trim().slice(0, 20);
const client = new Client(serverUrl);
let room: Room<any, CaboStateLike> | undefined;
let latestState: CaboStateLike | undefined;
let readingSecret = false;
let muteReadlineOutput = false;

const readlineOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!muteReadlineOutput) stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: stdin, output: readlineOutput, prompt: "cabo> ", terminal: true });

const players = (): StatePlayer[] => (latestState ? [...latestState.players.values()].sort((a, b) => a.seat - b.seat) : []);
const playerLabel = (id: string): string => players().find((player) => player.id === id)?.name ?? id;

function printHelp(): void {
  console.log(`
Connection: rooms | create public [target] | create private [target] | join ROOM [password] | reconnect | quit
Lobby:      players | start | leave
Game:       show | draw deck | draw discard POS | replace POS | discard
            peek self POS | peek PLAYER POS | swap PLAYER POS | skip | cabo
Positions are 1-4. Player arguments accept an exact nickname or session id.`);
}

function renderState(): void {
  if (!room || !latestState) {
    console.log("Not in a room.");
    return;
  }
  console.log(`\nRoom ${room.roomId} | ${latestState.phase} | round ${latestState.round} | target ${latestState.targetScore}`);
  console.log(`Deck ${latestState.deckCount} | discard ${latestState.discardLabel || "-"} | turn ${latestState.currentPlayerId ? playerLabel(latestState.currentPlayerId) : "-"}`);
  for (const player of players()) {
    const flags = [
      player.id === room.sessionId ? "you" : "",
      player.isHost ? "host" : "",
      !player.connected ? "offline" : "",
      player.forfeited ? "DNF" : "",
    ].filter(Boolean);
    console.log(`  ${player.seat + 1}. ${player.name} — ${player.score} pts, ${player.cardCount} cards${flags.length ? ` [${flags.join(", ")}]` : ""}`);
  }
  if (latestState.winners.length) console.log(`Winner(s): ${latestState.winners.map(playerLabel).join(", ")}`);
}

function formatEvent(event: any): string {
  switch (event?.type) {
    case "turn": return `Turn: ${playerLabel(event.playerId)}${event.finalTurn ? " (final)" : ""}`;
    case "discard": return `${playerLabel(event.playerId)} discarded ${event.card.label}.`;
    case "swap": return `${playerLabel(event.playerId)} swapped position ${event.position} with ${playerLabel(event.targetPlayerId)}.`;
    case "cabo": return `${playerLabel(event.playerId)} called CABO!`;
    case "forfeit": return `${playerLabel(event.playerId)} forfeited.`;
    case "joined": return `${event.name} joined.`;
    case "disconnected": return `${playerLabel(event.playerId)} disconnected (${event.graceSeconds}s grace).`;
    case "reconnected": return `${playerLabel(event.playerId)} reconnected.`;
    case "round-result": return `Round result: ${Object.entries(event.roundScores).map(([id, score]) => `${playerLabel(id)} +${score}`).join(", ")}${event.caboSucceeded ? " — CABO succeeded" : ""}`;
    case "match-result": return `Match over. Winner(s): ${event.winners.map(playerLabel).join(", ")}`;
    default: return JSON.stringify(event);
  }
}

async function attach(nextRoom: Room<any, CaboStateLike>): Promise<void> {
  room = nextRoom;
  await saveSession({ server: serverUrl, name: playerName, roomId: nextRoom.roomId, token: nextRoom.reconnectionToken });
  nextRoom.onStateChange((state) => { latestState = state; });
  nextRoom.onMessage<PrivateRevealMessage>("reveal", (message) => {
    console.log(`\nPRIVATE ${message.reason}${message.position ? ` position ${message.position}` : ""}: ${message.card.label} (${message.card.rank} points)`);
    rl.prompt(true);
  });
  nextRoom.onMessage<ErrorMessage>("error", (message) => {
    console.error(`\n${message.code}: ${message.message}`);
    rl.prompt(true);
  });
  nextRoom.onMessage<any>("event", (event) => {
    console.log(`\n${formatEvent(event)}`);
    rl.prompt(true);
  });
  nextRoom.onDrop(() => {
    console.log("\nConnection dropped. The server holds your seat for 60 seconds; use reconnect if automatic recovery fails.");
    rl.prompt(true);
  });
  nextRoom.onReconnect(() => {
    console.log("\nReconnected.");
    void saveSession({ server: serverUrl, name: playerName, roomId: nextRoom.roomId, token: nextRoom.reconnectionToken });
    rl.prompt(true);
  });
  nextRoom.onLeave(() => {
    if (room === nextRoom) {
      room = undefined;
      latestState = undefined;
    }
  });
  console.log(`Joined room ${nextRoom.roomId} as ${playerName}.`);
}

async function listRooms(): Promise<ListedRoom[]> {
  const response = await fetch(`${serverUrl}/rooms`);
  if (!response.ok) throw new Error(`Room list failed: HTTP ${response.status}`);
  return await response.json() as ListedRoom[];
}

async function readSecret(prompt: string): Promise<string> {
  readingSecret = true;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    try {
      return await new Promise((resolve) => rl.question(prompt, resolve));
    } finally {
      readingSecret = false;
    }
  }
  rl.pause();
  stdout.write(prompt);
  muteReadlineOutput = true;
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolve) => {
    let value = "";
    const onData = (buffer: Buffer): void => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdout.write("\n");
          muteReadlineOutput = false;
          rl.resume();
          readingSecret = false;
          resolve(value);
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f") value = value.slice(0, -1);
        else if (/\d/.test(char)) value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function resolveTarget(name: string): string {
  const normalized = name.toLocaleLowerCase();
  const match = players().find((player) => player.id === name || player.name.toLocaleLowerCase() === normalized);
  if (!match) throw new Error(`Player not found: ${name}.`);
  return match.id;
}

function withTarget(command: LocalCommand & { kind: "game" }): ClientCommand {
  if (!command.targetName) return command.command;
  const targetPlayerId = resolveTarget(command.targetName);
  if (command.command.type === "peek-other") return { ...command.command, targetPlayerId };
  if (command.command.type === "swap") return { ...command.command, targetPlayerId };
  return command.command;
}

async function execute(command: LocalCommand): Promise<boolean> {
  switch (command.kind) {
    case "help": printHelp(); break;
    case "rooms": {
      const available = await listRooms();
      if (!available.length) console.log("No public lobby rooms.");
      for (const item of available) console.log(`${item.roomId} — ${item.playerCount}/${item.maxClients}, target ${item.targetScore}`);
      break;
    }
    case "create": {
      if (room) throw new Error("Leave the current room first.");
      const password = command.visibility === "private" ? await readSecret("Six digit password: ") : undefined;
      if (password !== undefined && !/^\d{6}$/.test(password)) throw new Error("Password must contain exactly six digits.");
      await attach(await client.create("cabo", { name: playerName, visibility: command.visibility, targetScore: command.targetScore, ...(password ? { password } : {}) }));
      break;
    }
    case "join": {
      if (room) throw new Error("Leave the current room first.");
      const publicRooms = await listRooms();
      const isPublic = publicRooms.some((item) => item.roomId === command.roomId);
      const password = command.password ?? (isPublic ? undefined : await readSecret("Six digit password: "));
      await attach(await client.joinById(command.roomId, { name: playerName, ...(password ? { password } : {}) }));
      break;
    }
    case "reconnect": {
      if (room) throw new Error("Already connected to a room.");
      const saved = await loadSession();
      if (!saved) throw new Error("No saved session.");
      if (saved.server !== serverUrl) throw new Error(`Saved session belongs to ${saved.server}.`);
      await attach(await client.reconnect(saved.token));
      break;
    }
    case "show": renderState(); break;
    case "players":
      for (const player of players()) console.log(`${player.name} (${player.id})${player.isHost ? " [host]" : ""}`);
      break;
    case "game":
      if (!room) throw new Error("Join a room first.");
      room.send("command", withTarget(command));
      break;
    case "leave":
      if (!room) throw new Error("Not in a room.");
      room.send("command", { type: "leave" });
      await room.leave(true);
      room = undefined;
      latestState = undefined;
      await clearSession();
      console.log("Left the room.");
      break;
    case "quit":
      if (room) await room.leave(true);
      return false;
  }
  return true;
}

console.log(`Cabo CLI — server ${serverUrl}, player ${playerName}`);
printHelp();
rl.prompt();
let queue = Promise.resolve(true);
rl.on("line", (line) => {
  if (readingSecret) return;
  queue = queue.then(async () => {
    try {
      const keepRunning = await execute(parseCommand(line));
      if (!keepRunning) {
        rl.close();
        return false;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    rl.prompt();
    return true;
  });
});
