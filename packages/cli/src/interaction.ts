import type { ClientCommand } from "@cabo-game/shared";
import type { CaboStateLike, ListedRoom, StatePlayer } from "./model.js";

export type MenuAction =
  | "rooms" | "create-public" | "create-private" | "join" | "reconnect"
  | "start" | "players" | "leave"
  | "draw-deck" | "draw-discard" | "replace" | "discard" | "cabo"
  | "peek-self" | "peek-other" | "swap" | "skip";

export interface MenuItem {
  key: string;
  label: string;
  action: MenuAction;
}

export interface SelectionOption {
  value: string;
  label: string;
}

export type InteractionFlow =
  | { kind: "idle" }
  | { kind: "create-name"; visibility: "public" | "private"; defaultRoomName: string }
  | { kind: "create-target"; visibility: "public" | "private"; roomName?: string }
  | { kind: "join-room" }
  | { kind: "room-browser"; rooms: ListedRoom[]; page: number; message?: string }
  | { kind: "position"; action: "draw-discard" | "replace" | "peek-self"; guard: string }
  | { kind: "target"; action: "peek-other" | "swap"; guard: string }
  | { kind: "target-position"; action: "peek-other" | "swap"; target: StatePlayer; guard: string }
  | { kind: "confirm-cabo"; guard: string };

export interface InteractionContext {
  state?: CaboStateLike;
  selfId?: string;
  playerName?: string;
}

export type InteractionResult =
  | { kind: "flow"; flow: InteractionFlow; message?: string }
  | { kind: "local"; command: string }
  | { kind: "create"; visibility: "public" | "private"; targetScore: number; roomName?: string }
  | { kind: "listed-room"; room: ListedRoom }
  | { kind: "game"; command: ClientCommand };

export const ROOM_PAGE_SIZE = 10;

export function stateGuard(context: InteractionContext): string {
  const state = context.state;
  if (!state) return "disconnected";
  const players = [...state.players.values()].map((player) => `${player.id}:${player.connected}:${player.forfeited}`).join("|");
  return [state.phase, state.round, state.currentPlayerId, state.caboCallerId, state.discardLabel, players].join(":");
}

export function menuFor(context: InteractionContext): MenuItem[] {
  const { state, selfId } = context;
  if (!state || !selfId) return [
    { key: "1", label: "List public rooms", action: "rooms" },
    { key: "2", label: "Create public room", action: "create-public" },
    { key: "3", label: "Create private room", action: "create-private" },
    { key: "4", label: "Join room", action: "join" },
    { key: "5", label: "Reconnect", action: "reconnect" },
  ];

  const self = state.players.get(selfId);
  if (state.phase === "LOBBY") {
    const items: MenuItem[] = [];
    if (self?.isHost) items.push({ key: "1", label: "Start game", action: "start" });
    items.push(
      { key: self?.isHost ? "2" : "1", label: "Show players", action: "players" },
      { key: self?.isHost ? "3" : "2", label: "Leave room", action: "leave" },
    );
    return items;
  }

  if (state.currentPlayerId !== selfId) return [];
  if (state.phase === "TURN_START" || state.phase === "FINAL_TURNS") {
    const items: MenuItem[] = [
      { key: "1", label: "Draw from deck", action: "draw-deck" },
      { key: "2", label: `Take discard ${state.discardLabel || "-"}`, action: "draw-discard" },
    ];
    if (!state.caboCallerId) items.push({ key: "3", label: "Call CABO", action: "cabo" });
    return items;
  }
  if (state.phase === "DRAWN") return [
    { key: "1", label: "Replace one of your cards", action: "replace" },
    { key: "2", label: "Discard the drawn card", action: "discard" },
  ];
  if (state.phase === "POWER_PENDING") {
    const power = state.discardRank;
    const action: MenuItem | undefined = power <= 8
      ? { key: "1", label: "Peek at your card", action: "peek-self" }
      : power <= 10
        ? { key: "1", label: "Peek at another player's card", action: "peek-other" }
        : power <= 12
          ? { key: "1", label: "Blind-swap with another player", action: "swap" }
          : undefined;
    return [...(action ? [action] : []), { key: action ? "2" : "1", label: "Skip power", action: "skip" }];
  }
  return [];
}

export function selectionOptionsFor(flow: InteractionFlow, context: InteractionContext): SelectionOption[] {
  switch (flow.kind) {
    case "idle":
      return menuFor(context).map((item) => ({ value: item.key, label: item.label }));
    case "position":
      return positions().map((position) => ({ value: position, label: `Card position ${position}` }));
    case "target":
      return activeTargets(context).map((player, index) => ({ value: String(index + 1), label: player.name }));
    case "target-position":
      return positions().map((position) => ({ value: position, label: `${flow.target.name}'s position ${position}` }));
    case "confirm-cabo":
      return [
        { value: "n", label: "No, keep playing" },
        { value: "y", label: "Yes, call CABO" },
      ];
    case "room-browser": {
      const start = flow.page * ROOM_PAGE_SIZE;
      return flow.rooms.slice(start, start + ROOM_PAGE_SIZE).map((room) => ({
        value: room.roomId,
        label: `${escapeTerminalText(room.roomName)}  ${escapeTerminalText(room.roomId)}  ${roomStatus(room)}  ${room.playerCount}/${room.maxClients}`,
      }));
    }
    case "create-name":
    case "create-target":
    case "join-room":
      return [];
  }
}

export function moveSelection(current: number, direction: -1 | 1, optionCount: number): number {
  if (optionCount <= 0) return 0;
  const normalized = ((current % optionCount) + optionCount) % optionCount;
  return (normalized + direction + optionCount) % optionCount;
}

export function selectionSignature(flow: InteractionFlow, context: InteractionContext): string {
  return `${flow.kind}:${selectionOptionsFor(flow, context).map((option) => `${option.value}:${option.label}`).join("|")}`;
}

export function selectMenu(input: string, context: InteractionContext): InteractionResult | undefined {
  const item = menuFor(context).find((entry) => entry.key === input.trim());
  if (!item) return undefined;
  const guard = stateGuard(context);
  switch (item.action) {
    case "rooms": case "reconnect": case "start": case "players": case "leave":
      return { kind: "local", command: item.action };
    case "create-public": case "create-private":
      return {
        kind: "flow",
        flow: {
          kind: "create-name",
          visibility: item.action === "create-public" ? "public" : "private",
          defaultRoomName: `${context.state?.players.get(context.selfId ?? "")?.name ?? context.playerName ?? "Player"}'s room`,
        },
      };
    case "join": return { kind: "flow", flow: { kind: "join-room" } };
    case "draw-deck": return { kind: "game", command: { type: "draw-deck" } };
    case "discard": return { kind: "game", command: { type: "discard" } };
    case "skip": return { kind: "game", command: { type: "skip" } };
    case "draw-discard": case "replace": case "peek-self":
      return { kind: "flow", flow: { kind: "position", action: item.action, guard } };
    case "peek-other": case "swap":
      return { kind: "flow", flow: { kind: "target", action: item.action, guard } };
    case "cabo": return { kind: "flow", flow: { kind: "confirm-cabo", guard } };
  }
}

export function advanceFlow(input: string, flow: InteractionFlow, context: InteractionContext): InteractionResult {
  const value = input.trim();
  if (value.toLowerCase() === "cancel") return { kind: "flow", flow: { kind: "idle" }, message: "Selection cancelled." };
  if (flow.kind === "create-name") {
    const roomName = value || flow.defaultRoomName;
    if (Array.from(roomName).length > 40) return { kind: "flow", flow, message: "Room name must contain at most 40 characters." };
    return { kind: "flow", flow: { kind: "create-target", visibility: flow.visibility, roomName } };
  }
  if (flow.kind === "create-target") {
    const target = value === "" ? 100 : Number(value);
    if (!Number.isInteger(target) || target < 20 || target > 500) return { kind: "flow", flow, message: "Enter a target score from 20 to 500, or press Enter for 100." };
    return { kind: "create", visibility: flow.visibility, targetScore: target, ...(flow.roomName !== undefined ? { roomName: flow.roomName } : {}) };
  }
  if (flow.kind === "join-room") {
    if (!value) return { kind: "flow", flow, message: "Enter a room code." };
    return { kind: "local", command: `join ${value}` };
  }
  if (flow.kind === "room-browser") {
    const start = flow.page * ROOM_PAGE_SIZE;
    const room = flow.rooms.slice(start, start + ROOM_PAGE_SIZE).find((candidate) => candidate.roomId === value);
    if (!room) return { kind: "flow", flow, message: "Choose a room from the current page." };
    return { kind: "listed-room", room };
  }
  if (flow.kind === "confirm-cabo") {
    if (/^y(es)?$/i.test(value)) return { kind: "game", command: { type: "cabo" } };
    return { kind: "flow", flow: { kind: "idle" }, message: "CABO cancelled." };
  }
  if (flow.kind === "position") {
    const position = Number(value);
    if (!Number.isInteger(position) || position < 1 || position > 4) return { kind: "flow", flow, message: "Choose position 1, 2, 3, or 4." };
    if (flow.action === "draw-discard") return { kind: "game", command: { type: "draw-discard", position: position as 1 | 2 | 3 | 4 } };
    if (flow.action === "replace") return { kind: "game", command: { type: "replace", position: position as 1 | 2 | 3 | 4 } };
    return { kind: "game", command: { type: "peek-self", position: position as 1 | 2 | 3 | 4 } };
  }
  if (flow.kind === "target") {
    const targets = activeTargets(context);
    const target = targets[Number(value) - 1];
    if (!target) return { kind: "flow", flow, message: `Choose a player from 1 to ${targets.length}.` };
    return { kind: "flow", flow: { kind: "target-position", action: flow.action, target, guard: flow.guard } };
  }
  if (flow.kind === "target-position") {
    const position = Number(value);
    if (!Number.isInteger(position) || position < 1 || position > 4) return { kind: "flow", flow, message: "Choose position 1, 2, 3, or 4." };
    if (flow.action === "peek-other") return { kind: "game", command: { type: "peek-other", targetPlayerId: flow.target.id, position: position as 1 | 2 | 3 | 4 } };
    return { kind: "game", command: { type: "swap", targetPlayerId: flow.target.id, position: position as 1 | 2 | 3 | 4 } };
  }
  return { kind: "flow", flow: { kind: "idle" } };
}

export function activeTargets(context: InteractionContext): StatePlayer[] {
  if (!context.state) return [];
  return [...context.state.players.values()]
    .filter((player) => player.id !== context.selfId && !player.forfeited)
    .sort((a, b) => a.seat - b.seat);
}

export function flowPrompt(flow: InteractionFlow, context: InteractionContext): string | undefined {
  switch (flow.kind) {
    case "idle": return undefined;
    case "create-name": return `Room name (Enter = ${escapeTerminalText(flow.defaultRoomName)}):`;
    case "create-target": return `Target score for ${flow.visibility} room (20-500, Enter = 100):`;
    case "join-room": return "Room code:";
    case "room-browser": return `Public rooms — page ${flow.page + 1}/${Math.max(1, Math.ceil(flow.rooms.length / ROOM_PAGE_SIZE))} (←/→ pages, ↑/↓ rooms, Enter joins):`;
    case "position": return "Choose a card position (type cancel to go back):";
    case "target": return "Choose a player (type cancel to go back):";
    case "target-position": return `Choose ${flow.target.name}'s card position (type cancel to go back):`;
    case "confirm-cabo": return "Call CABO? Every other active player gets one final turn:";
  }
}

export function isGuardedFlow(flow: InteractionFlow): flow is Extract<InteractionFlow, { guard: string }> {
  return "guard" in flow;
}

export function moveRoomPage(flow: Extract<InteractionFlow, { kind: "room-browser" }>, direction: -1 | 1): InteractionFlow {
  const lastPage = Math.max(0, Math.ceil(flow.rooms.length / ROOM_PAGE_SIZE) - 1);
  const { message: _message, ...rest } = flow;
  return { ...rest, page: Math.min(lastPage, Math.max(0, flow.page + direction)) };
}

export function roomStatus(room: ListedRoom): string {
  return `${room.isFull ? "full" : "open"}/${room.isStarted ? "started" : "waiting"}`;
}

export function escapeTerminalText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}

function positions(): string[] {
  return ["1", "2", "3", "4"];
}
