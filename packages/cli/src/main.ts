#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { Writable } from "node:stream";
import type { ClientCommand, ErrorMessage, PrivateRevealMessage } from "@cabo/shared";
import { Client, type Room } from "@colyseus/sdk";
import { clearSession, loadSession, saveSession, type SavedSession } from "./config.js";
import { advanceFlow, isGuardedFlow, selectMenu, stateGuard, type InteractionFlow, type InteractionResult } from "./interaction.js";
import { applyOwnActionEvent, applyReveal, applySwapEvent, createKnowledge, resetForRound, storedKnowledge, type KnowledgeState, type PendingGameAction } from "./knowledge.js";
import type { CaboStateLike, ListedRoom, RoundResultView, StatePlayer } from "./model.js";
import { parseCommand, type LocalCommand } from "./parser.js";
import { renderDashboard, renderPlainState } from "./ui.js";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
}

const serverUrl = option("--server", "http://localhost:2567").replace(/\/$/, "");
const playerName = option("--name", process.env.USER ?? "Player").trim().slice(0, 20);
const client = new Client(serverUrl);
const interactive = Boolean(stdin.isTTY && stdout.isTTY);
let room: Room<any, CaboStateLike> | undefined;
let latestState: CaboStateLike | undefined;
let lastRound = 0;
let readingSecret = false;
let muteReadlineOutput = false;
let flow: InteractionFlow = { kind: "idle" };
let knowledge: KnowledgeState = createKnowledge();
let pendingGameAction: PendingGameAction | undefined;
let notice: string | undefined;
let recentEvents: string[] = [];
let roundResult: RoundResultView | undefined;
let sessionWrites = Promise.resolve();

const readlineOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!muteReadlineOutput) stdout.write(chunk, encoding);
    callback();
  },
});
const rl = createInterface({ input: stdin, output: readlineOutput, prompt: "cabo> ", terminal: interactive });

const players = (): StatePlayer[] => latestState ? [...latestState.players.values()].sort((a, b) => a.seat - b.seat) : [];
const playerLabel = (id: string): string => players().find((player) => player.id === id)?.name ?? id;
const context = () => ({ ...(latestState ? { state: latestState } : {}), ...(room ? { selfId: room.sessionId } : {}) });

function printHelp(): void {
  const help = [
    "Connection: rooms | create public [target] | create private [target] | join ROOM [password] | reconnect | quit",
    "Lobby:      players | start | leave",
    "Game:       show | draw deck | draw discard POS | replace POS | discard",
    "            peek self POS | peek PLAYER POS | swap PLAYER POS | skip | cabo",
    "Positions are 1-4. Player arguments accept an exact nickname or session id.",
    "At a guided prompt, type cancel to return to the action menu.",
  ];
  if (interactive) {
    for (const line of help) addEvent(line);
    notice = "Command reference added to Recent events.";
    renderNow();
  } else stdout.write(`${help.join("\n")}\n`);
}

function addEvent(message: string): void {
  recentEvents.push(message);
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
  stdout.write("\x1b[2J\x1b[H");
  stdout.write(renderDashboard({
    ...context(), knowledge, events: recentEvents, flow,
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
    const cards = hand.cards.map((card: { label: string }) => card.label).join(" ");
    lines.push(`  ${playerLabel(hand.playerId).padEnd(12)} ${cards.padEnd(16)} hand ${String(hand.handScore).padStart(2)}  round +${event.roundScores[hand.playerId]}  total ${event.totals[hand.playerId]}`);
  }
  lines.push(`  CABO ${event.caboSucceeded ? "succeeded" : "failed"}.`);
  return { lines, nextRoundPending: true };
}

async function persistSession(): Promise<void> {
  if (!room) return;
  await saveSession({ server: serverUrl, name: playerName, roomId: room.roomId, token: room.reconnectionToken, knowledge: storedKnowledge(knowledge) });
}

function queueSessionPersist(): void {
  sessionWrites = sessionWrites.then(persistSession).catch((error: unknown) => {
    inform(`Could not save the reconnect session: ${error instanceof Error ? error.message : String(error)}`, true);
  });
}

async function attach(nextRoom: Room<any, CaboStateLike>, saved?: SavedSession): Promise<void> {
  room = nextRoom;
  latestState = nextRoom.state;
  lastRound = nextRoom.state.round;
  flow = { kind: "idle" };
  knowledge = createKnowledge(nextRoom.state.round, saved?.knowledge);
  pendingGameAction = undefined;
  roundResult = undefined;

  nextRoom.onStateChange((state) => {
    latestState = state;
    if (state.round !== lastRound) {
      knowledge = resetForRound(knowledge, state.round);
      if (lastRound !== 0) roundResult = undefined;
      lastRound = state.round;
      queueSessionPersist();
    }
    if (isGuardedFlow(flow) && flow.guard !== stateGuard(context())) {
      flow = { kind: "idle" };
      notice = "The game state changed; the previous selection was cancelled.";
    }
    renderNow();
  });
  nextRoom.onMessage<PrivateRevealMessage>("reveal", (message) => {
    knowledge = applyReveal(knowledge, message, latestState?.round ?? lastRound, latestState?.phase ?? "LOBBY", pendingGameAction);
    if (message.reason === "draw") addEvent(`You drew ${message.card.label} (${message.card.rank} pts).`);
    else addEvent(`Private reveal${message.position ? ` at position ${message.position}` : ""}: ${message.card.label} (${message.card.rank} pts).`);
    if (message.reason === "peek") pendingGameAction = undefined;
    queueSessionPersist();
    renderNow();
  });
  nextRoom.onMessage<ErrorMessage>("error", (message) => {
    pendingGameAction = undefined;
    flow = { kind: "idle" };
    inform(`${friendlyError(message.code)} ${message.message}`, true);
  });
  nextRoom.onMessage<any>("event", (event) => {
    if (event.type === "discard" && event.playerId === nextRoom.sessionId) {
      knowledge = applyOwnActionEvent(knowledge, pendingGameAction);
      pendingGameAction = undefined;
      queueSessionPersist();
    }
    if (event.type === "swap") {
      knowledge = applySwapEvent(knowledge, event.position, event.playerId === nextRoom.sessionId || event.targetPlayerId === nextRoom.sessionId);
      if (event.playerId === nextRoom.sessionId) pendingGameAction = undefined;
      queueSessionPersist();
    }
    if (event.type === "round-result") roundResult = makeRoundResult(event);
    if (event.type === "match-result" && roundResult) roundResult.nextRoundPending = false;
    if (event.type === "cabo" || event.type === "turn") pendingGameAction = undefined;
    addEvent(formatEvent(event));
    renderNow();
  });
  nextRoom.onDrop(() => { addEvent("Connection dropped. Your seat is held for 60 seconds; use reconnect if recovery fails."); renderNow(); });
  nextRoom.onReconnect(() => { addEvent("Reconnected."); queueSessionPersist(); renderNow(); });
  nextRoom.onLeave(() => {
    if (room === nextRoom) {
      room = undefined;
      latestState = undefined;
      flow = { kind: "idle" };
      pendingGameAction = undefined;
    }
    renderNow();
  });
  addEvent(`Joined room ${nextRoom.roomId} as ${playerName}.`);
  await persistSession();
  renderNow();
}

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
  const response = await fetch(`${serverUrl}/rooms`);
  if (!response.ok) throw new Error(`Room list failed: HTTP ${response.status}`);
  return await response.json() as ListedRoom[];
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
  if (!room) throw new Error("Join a room first.");
  pendingGameAction = {
    command,
    ...(command.type === "draw-discard" && latestState?.discardLabel ? { discard: { label: latestState.discardLabel, rank: latestState.discardRank } } : {}),
  };
  room.send("command", command);
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
      await attach(await client.reconnect(saved.token), saved);
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
      room.send("command", { type: "leave" });
      await room.leave(true);
      room = undefined;
      latestState = undefined;
      knowledge = createKnowledge();
      await clearSession();
      addEvent("Left the room.");
      break;
    case "quit": if (room) await room.leave(true); return false;
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
  if (flow.kind !== "idle") return applyInteraction(advanceFlow(line, flow, context()));
  if (!line.trim()) { renderNow(); return true; }
  const menuResult = selectMenu(line, context());
  if (menuResult) return applyInteraction(menuResult);
  return execute(parseCommand(line));
}

addEvent(`Server ${serverUrl} — player ${playerName}`);
if (!interactive) printHelp();
renderNow();
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
