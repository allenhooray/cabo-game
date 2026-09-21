#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import type { ClientCommand, ErrorMessage, PrivateRevealMessage } from "@cabo-game/shared";
import type { Room } from "@colyseus/sdk";
import { CaboClientCore, DEFAULT_SERVER_URL } from "./client-core.js";
import { caboDiscoveryMode, caboHelpLines, readCliVersion, renderCaboHelp } from "./cli-discovery.js";
import { createFileSessionStore, defaultSessionPath } from "./config.js";
import { advanceFlow, isGuardedFlow, moveSelection, selectionOptionsFor, selectionSignature, selectMenu, stateGuard, type InteractionFlow, type InteractionResult } from "./interaction.js";
import { createKnowledge, type KnowledgeState } from "./knowledge.js";
import type { CaboStateLike, ListedRoom, RoundResultView, StatePlayer } from "./model.js";
import { parseCommand, type LocalCommand } from "./parser.js";
import { formatCardText, renderCommandPrompt, renderDashboard, renderPlainState } from "./ui.js";

const discoveryMode = caboDiscoveryMode(process.argv.slice(2));
if (discoveryMode === "help") {
  stdout.write(`${renderCaboHelp()}\n`);
  process.exit(0);
}
if (discoveryMode === "version") {
  stdout.write(`${await readCliVersion()}\n`);
  process.exit(0);
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
}

const serverUrl = option("--server", DEFAULT_SERVER_URL).replace(/\/$/, "");
const playerName = option("--name", process.env.USER ?? "Player").trim().slice(0, 20);
const interactive = Boolean(stdin.isTTY && stdout.isTTY);
let room: Room<any, CaboStateLike> | undefined;
let latestState: CaboStateLike | undefined;
let lastRound = 0;
let readingSecret = false;
let muteReadlineOutput = false;
let flow: InteractionFlow = { kind: "idle" };
let knowledge: KnowledgeState = createKnowledge();
let notice: string | undefined;
let recentEvents: string[] = [];
let roundResult: RoundResultView | undefined;
let selectionIndex = 0;
let currentSelectionSignature = "";

const readlineOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!muteReadlineOutput) stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: stdin, output: readlineOutput, prompt: renderCommandPrompt(interactive), terminal: interactive });

const players = (): StatePlayer[] => latestState ? [...latestState.players.values()].sort((a, b) => a.seat - b.seat) : [];
const playerLabel = (id: string): string => players().find((player) => player.id === id)?.name ?? id;
const context = () => ({ ...(latestState ? { state: latestState } : {}), ...(room ? { selfId: room.sessionId } : {}) });

function printHelp(): void {
  const help = caboHelpLines();
  if (interactive) {
    for (const line of help) addEvent(line);
    notice = "Command reference added to Recent events.";
    renderNow();
  } else stdout.write(`${help.join("\n")}\n`);
}

function addEvent(message: string): void {
  recentEvents.push(formatCardText(message));
  if (recentEvents.length > 8) recentEvents = recentEvents.slice(-8);
  if (!interactive) stdout.write(`${message}\n`);
}

function inform(message: string, isError = false): void {
  if (interactive) {
    notice = `${isError ? "Error: " : ""}${message}`;
    renderNow();
  } else (isError ? process.stderr : stdout).write(`${message}\n`);
}

function renderNow(): void {
  if (readingSecret) return;
  if (!interactive) {
    rl.prompt();
    return;
  }
  syncSelection();
  stdout.write("\x1b[2J\x1b[H");
  stdout.write(renderDashboard({
    ...context(), knowledge, events: recentEvents, flow, selectionIndex,
    ...(notice ? { notice } : {}),
    ...(room ? { roomId: room.roomId } : {}),
    ...(roundResult ? { roundResult } : {}),
  }));
  stdout.write("\n\n");
  rl.prompt(true);
}

function renderState(): void {
  if (!room || !latestState) return inform("Not in a room.", true);
  if (interactive) renderNow();
  else stdout.write(`${renderPlainState(latestState, room.sessionId, knowledge, room.roomId)}\n`);
}

function formatEvent(event: any): string {
  switch (event?.type) {
    case "turn": return `Turn: ${playerLabel(event.playerId)}${event.finalTurn ? " (final)" : ""}`;
    case "action": {
      const actor = playerLabel(event.playerId);
      if (event.action === "draw-deck") return `${actor} drew from the deck.`;
      if (event.action === "draw-discard") return `${actor} took the discard into position ${event.position}.`;
      if (event.action === "replace") return `${actor} put the drawn card in position ${event.position}.`;
      if (event.action === "discard") return `${actor} discarded the drawn card.`;
      if (event.action === "peek-self") return `${actor} peeked at own position ${event.position}.`;
      if (event.action === "peek-other") return `${actor} peeked at ${playerLabel(event.targetPlayerId)} position ${event.position}.`;
      if (event.action === "swap") return `${actor} swapped position ${event.position} with ${playerLabel(event.targetPlayerId)}.`;
      if (event.action === "skip") return `${actor} skipped the power.`;
      if (event.action === "cabo") return `${actor} called CABO!`;
      return JSON.stringify(event);
    }
    case "discard": return `${playerLabel(event.playerId)} discarded ${event.card.label}.`;
    case "swap": return `${playerLabel(event.playerId)} blind-swapped position ${event.position} with ${playerLabel(event.targetPlayerId)}.`;
    case "cabo": return `${playerLabel(event.playerId)} called CABO!`;
    case "forfeit": return `${playerLabel(event.playerId)} forfeited.`;
    case "joined": return `${event.name} joined.`;
    case "disconnected": return `${playerLabel(event.playerId)} disconnected (${event.graceSeconds}s grace).`;
    case "reconnected": return `${playerLabel(event.playerId)} reconnected.`;
    case "round-result": return `Round result: ${Object.entries(event.roundScores).map(([id, score]) => `${playerLabel(id)} +${score}`).join(", ")}${event.caboSucceeded ? " — CABO succeeded" : " — CABO failed"}`;
    case "match-result": return `Match over. Winner(s): ${event.winners.map(playerLabel).join(", ")}`;
    default: return JSON.stringify(event);
  }
}

function makeRoundResult(event: any): RoundResultView {
  const lines = ["Round result"];
  for (const hand of event.hands ?? []) {
    const cards = hand.cards.map((card: { label: string }) => formatCardText(card.label)).join(" ");
    lines.push(`  ${playerLabel(hand.playerId).padEnd(12)} ${cards.padEnd(16)} hand ${String(hand.handScore).padStart(2)}  round +${event.roundScores[hand.playerId]}  total ${event.totals[hand.playerId]}`);
  }
  lines.push(`  CABO ${event.caboSucceeded ? "succeeded" : "failed"}.`);
  return { lines, nextRoundPending: true };
}

const gameClient = new CaboClientCore({
  serverUrl,
  playerName,
  sessionStore: createFileSessionStore(defaultSessionPath()),
  handlers: {
    attached: (nextRoom) => {
      room = nextRoom;
      latestState = nextRoom.state;
      lastRound = nextRoom.state.round;
      knowledge = gameClient.knowledge;
      flow = { kind: "idle" };
      roundResult = undefined;
      addEvent(`Joined room ${nextRoom.roomId} as ${playerName}.`);
      renderNow();
    },
    state: (state) => {
      latestState = state;
      knowledge = gameClient.knowledge;
      if (state.round !== lastRound) {
        if (lastRound !== 0) roundResult = undefined;
        lastRound = state.round;
      }
      if (isGuardedFlow(flow) && flow.guard !== stateGuard(context())) {
        flow = { kind: "idle" };
        notice = "The game state changed; the previous selection was cancelled.";
      }
      renderNow();
    },
    reveal: (message: PrivateRevealMessage) => {
      knowledge = gameClient.knowledge;
      if (message.reason === "draw") addEvent(`You drew ${message.card.label} (${message.card.rank} pts).`);
      else addEvent(`Private reveal${message.position ? ` at position ${message.position}` : ""}: ${message.card.label} (${message.card.rank} pts).`);
      renderNow();
    },
    knowledge: (nextKnowledge) => {
      knowledge = nextKnowledge;
      renderNow();
    },
    error: (message: ErrorMessage) => {
      flow = { kind: "idle" };
      inform(`${friendlyError(message.code)} ${message.message}`, true);
    },
    event: (event: any) => {
      knowledge = gameClient.knowledge;
      if (event.type === "round-result") roundResult = makeRoundResult(event);
      if (event.type === "match-result" && roundResult) roundResult.nextRoundPending = false;
      addEvent(formatEvent(event));
      renderNow();
    },
    dropped: () => { addEvent("Connection dropped. Your seat is held for 60 seconds; use reconnect if recovery fails."); renderNow(); },
    reconnected: () => { addEvent("Reconnected."); renderNow(); },
    left: () => {
      room = undefined;
      latestState = undefined;
      flow = { kind: "idle" };
      renderNow();
    },
    persistenceError: (error) => inform(`Could not save the reconnect session: ${error instanceof Error ? error.message : String(error)}`, true),
  },
});

function friendlyError(code: string): string {
  const labels: Record<string, string> = {
    NOT_YOUR_TURN: "It is not your turn.", INVALID_PHASE: "That action is not available now.",
    INVALID_POSITION: "That card position is unavailable.", INVALID_TARGET: "Choose another active player.",
    INVALID_POWER: "That power cannot be used now.", NOT_HOST: "Only the host can do that.",
    NOT_ENOUGH_PLAYERS: "At least two connected players are required.",
  };
  return labels[code] ?? `${code}:`;
}

async function listRooms(): Promise<ListedRoom[]> {
  return gameClient.listRooms();
}

async function readSecret(prompt: string): Promise<string> {
  readingSecret = true;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    try { return await new Promise((resolve) => rl.question(prompt, resolve)); }
    finally { readingSecret = false; }
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

function sendGame(command: ClientCommand): void {
  gameClient.send(command);
  notice = undefined;
}

async function execute(command: LocalCommand): Promise<boolean> {
  switch (command.kind) {
    case "help": printHelp(); break;
    case "rooms": {
      const available = await listRooms();
      if (!available.length) addEvent("No public lobby rooms.");
      for (const item of available) addEvent(`${item.roomId.padEnd(10)} ${item.playerCount}/${item.maxClients} players  target ${item.targetScore}`);
      renderNow();
      break;
    }
    case "create": {
      if (room) throw new Error("Leave the current room first.");
      const password = command.visibility === "private" ? await readSecret("Six digit password: ") : undefined;
      if (password !== undefined && !/^\d{6}$/.test(password)) throw new Error("Password must contain exactly six digits.");
      await gameClient.create(command.visibility, command.targetScore, password);
      break;
    }
    case "join": {
      if (room) throw new Error("Leave the current room first.");
      const publicRooms = await listRooms();
      const isPublic = publicRooms.some((item) => item.roomId === command.roomId);
      const password = command.password ?? (isPublic ? undefined : await readSecret("Six digit password: "));
      await gameClient.join(command.roomId, password);
      break;
    }
    case "reconnect": {
      if (room) throw new Error("Already connected to a room.");
      await gameClient.reconnect();
      break;
    }
    case "show": renderState(); break;
    case "players": for (const player of players()) addEvent(`${player.name} (${player.id})${player.isHost ? " [host]" : ""}`); renderNow(); break;
    case "game": {
      const gameCommand = withTarget(command);
      if (gameCommand.type === "cabo") {
        flow = { kind: "confirm-cabo", guard: stateGuard(context()) };
        notice = undefined;
        renderNow();
      } else sendGame(gameCommand);
      break;
    }
    case "leave":
      if (!room) throw new Error("Not in a room.");
      await gameClient.leave();
      room = undefined;
      latestState = undefined;
      knowledge = createKnowledge();
      addEvent("Left the room.");
      break;
    case "quit": await gameClient.close(); return false;
  }
  return true;
}

async function applyInteraction(result: InteractionResult): Promise<boolean> {
  if (result.kind === "flow") {
    flow = result.flow;
    notice = result.message;
    renderNow();
    return true;
  }
  flow = { kind: "idle" };
  notice = undefined;
  if (result.kind === "game") { sendGame(result.command); return true; }
  return execute(parseCommand(result.command));
}

async function handleInput(line: string): Promise<boolean> {
  notice = undefined;
  if (!line.trim()) {
    syncSelection();
    const selected = selectionOptionsFor(flow, context())[selectionIndex];
    if (selected) line = selected.value;
  }
  if (flow.kind !== "idle") return applyInteraction(advanceFlow(line, flow, context()));
  if (!line.trim()) { renderNow(); return true; }
  const menuResult = selectMenu(line, context());
  if (menuResult) return applyInteraction(menuResult);
  return execute(parseCommand(line));
}

addEvent(`Server ${serverUrl} — player ${playerName}`);
if (!interactive) printHelp();
renderNow();

if (interactive) {
  emitKeypressEvents(stdin);
  stdin.on("keypress", (_character, key) => {
    if (readingSecret || (key.name !== "up" && key.name !== "down")) return;
    const options = selectionOptionsFor(flow, context());
    if (!options.length) return;
    selectionIndex = moveSelection(selectionIndex, key.name === "up" ? -1 : 1, options.length);
    notice = undefined;
    rl.write(null, { ctrl: true, name: "u" });
    renderNow();
  });
}

let queue = Promise.resolve(true);
rl.on("line", (line) => {
  if (readingSecret) return;
  queue = queue.then(async () => {
    try {
      const keepRunning = await handleInput(line);
      if (!keepRunning) { rl.close(); return false; }
    } catch (error) {
      inform(error instanceof Error ? error.message : String(error), true);
    }
    return true;
  });
});

function syncSelection(): void {
  const nextSignature = selectionSignature(flow, context());
  if (nextSignature !== currentSelectionSignature) {
    currentSelectionSignature = nextSignature;
    selectionIndex = 0;
  }
  const optionCount = selectionOptionsFor(flow, context()).length;
  if (selectionIndex >= optionCount) selectionIndex = 0;
}
