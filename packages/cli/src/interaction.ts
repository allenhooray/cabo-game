import type { ClientCommand } from "@cabo-game/shared";
import type { CaboStateLike, ListedRoom, StatePlayer } from "./model.js";

export type MenuAction =
  | "rooms" | "create-public" | "create-private" | "join" | "reconnect"
  | "start" | "players" | "leave"
  | "ready-next-round"
  | "draw-deck" | "draw-discard" | "replace" | "resolve-mismatch" | "discard" | "cabo"
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
  | { kind: "position"; action: "peek-self"; guard: string }
  | { kind: "replace-positions"; guard: string }
  | { kind: "replacement-position"; positions: number[]; guard: string }
  | { kind: "mismatch-drawn-placement"; penaltyCardPending: boolean; guard: string }
  | { kind: "mismatch-penalty-placement"; drawnPlacement: "left" | "right"; guard: string }
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
  const players = [...state.players.values()].map((player) => `${player.id}:${player.connected}:${player.forfeited}:${player.nextRoundReady}:${player.cardCount}`).join("|");
  return [state.phase, state.round, state.currentPlayerId, state.caboCallerId, state.drawSource, state.mismatchPenaltyCardPending, state.discardLabel, players].join(":");
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

  if (state.phase === "ROUND_RESULT") {
    return self && !self.forfeited && !self.nextRoundReady
      ? [{ key: "1", label: "Ready for next round", action: "ready-next-round" }]
      : [];
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
    { key: "1", label: "Replace 1-4 of your cards", action: "replace" },
    ...(state.drawSource === "deck" ? [{ key: "2", label: "Discard the drawn card", action: "discard" as const }] : []),
  ];
  if (state.phase === "MISMATCH_PENDING") return [
    { key: "1", label: "Place mismatch cards", action: "resolve-mismatch" },
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
      return positions(context.state?.players.get(context.selfId ?? "")?.cardCount ?? 0).map((position) => ({ value: position, label: `Card position ${position}` }));
    case "replacement-position":
      return flow.positions.map(String).map((position) => ({ value: position, label: `Place the drawn card at selected position ${position}` }));
    case "mismatch-drawn-placement":
    case "mismatch-penalty-placement":
      return [{ value: "left", label: "Left end" }, { value: "right", label: "Right end" }];
    case "target":
      return activeTargets(context).map((player, index) => ({ value: String(index + 1), label: player.name }));
    case "target-position":
      return positions(flow.action === "swap"
        ? Math.min(flow.target.cardCount, context.state?.players.get(context.selfId ?? "")?.cardCount ?? 0)
        : flow.target.cardCount).map((position) => ({ value: position, label: `${flow.target.name}'s position ${position}` }));
    case "confirm-cabo":
      return [
        { value: "n", label: "No, keep playing" },
        { value: "y", label: "Yes, call CABO" },
      ];
    case "room-browser": {
      const start = flow.page * ROOM_PAGE_SIZE;
      return [...flow.rooms.slice(start, start + ROOM_PAGE_SIZE).map((room, index) => ({
        value: String(index + 1),
        label: `${escapeTerminalText(room.roomName)}  ID ${escapeTerminalText(room.roomId)}  ${roomStatus(room)}  ${room.playerCount}/${room.maxClients}`,
      })), { value: "cancel", label: "Back to main menu" }];
    }
    case "create-name":
    case "create-target":
    case "join-room":
    case "replace-positions":
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
    case "ready-next-round": return { kind: "game", command: { type: "ready-next-round" } };
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
    case "draw-discard": return { kind: "game", command: { type: "draw-discard" } };
    case "replace": return { kind: "flow", flow: { kind: "replace-positions", guard } };
    case "peek-self": return { kind: "flow", flow: { kind: "position", action: item.action, guard } };
    case "resolve-mismatch": return { kind: "flow", flow: { kind: "mismatch-drawn-placement", penaltyCardPending: Boolean(context.state?.mismatchPenaltyCardPending), guard } };
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
    const rooms = flow.rooms.slice(start, start + ROOM_PAGE_SIZE);
    const selectedIndex = Number(value) - 1;
    const room = Number.isInteger(selectedIndex) && selectedIndex >= 0
      ? rooms[selectedIndex]
      : rooms.find((candidate) => candidate.roomId === value);
    if (!room) return { kind: "flow", flow, message: "Choose a room from the current page." };
    return { kind: "listed-room", room };
  }
  if (flow.kind === "confirm-cabo") {
    if (/^y(es)?$/i.test(value)) return { kind: "game", command: { type: "cabo" } };
    return { kind: "flow", flow: { kind: "idle" }, message: "CABO cancelled." };
  }
  if (flow.kind === "replace-positions") {
    const positions = value.split(/[\s,]+/).filter(Boolean).map(Number);
    const cardCount = context.state?.players.get(context.selfId ?? "")?.cardCount ?? 0;
    if (positions.length < 1 || positions.length > 4 || new Set(positions).size !== positions.length
      || positions.some((position) => !Number.isInteger(position) || position < 1 || position > cardCount)) {
      return { kind: "flow", flow, message: `Enter 1-4 unique positions from 1 to ${cardCount}, separated by spaces or commas.` };
    }
    if (positions.length === 1) return { kind: "game", command: { type: "replace", positions, replacementPosition: positions[0] as number } };
    return { kind: "flow", flow: { kind: "replacement-position", positions, guard: flow.guard } };
  }
  if (flow.kind === "replacement-position") {
    const replacementPosition = Number(value);
    if (!flow.positions.includes(replacementPosition)) return { kind: "flow", flow, message: "Choose one of the selected positions." };
    return { kind: "game", command: { type: "replace", positions: flow.positions, replacementPosition } };
  }
  if (flow.kind === "mismatch-drawn-placement") {
    if (value !== "left" && value !== "right") return { kind: "flow", flow, message: "Choose left or right." };
    if (!flow.penaltyCardPending) return { kind: "game", command: { type: "resolve-mismatch", drawnPlacement: value } };
    return { kind: "flow", flow: { kind: "mismatch-penalty-placement", drawnPlacement: value, guard: flow.guard } };
  }
  if (flow.kind === "mismatch-penalty-placement") {
    if (value !== "left" && value !== "right") return { kind: "flow", flow, message: "Choose left or right." };
    return { kind: "game", command: { type: "resolve-mismatch", drawnPlacement: flow.drawnPlacement, penaltyPlacement: value } };
  }
  if (flow.kind === "position") {
    const position = Number(value);
    const cardCount = context.state?.players.get(context.selfId ?? "")?.cardCount ?? 0;
    if (!Number.isInteger(position) || position < 1 || position > cardCount) return { kind: "flow", flow, message: `Choose position 1 to ${cardCount}.` };
    return { kind: "game", command: { type: "peek-self", position } };
  }
  if (flow.kind === "target") {
    const targets = activeTargets(context);
    const target = targets[Number(value) - 1];
    if (!target) return { kind: "flow", flow, message: `Choose a player from 1 to ${targets.length}.` };
    return { kind: "flow", flow: { kind: "target-position", action: flow.action, target, guard: flow.guard } };
  }
  if (flow.kind === "target-position") {
    const position = Number(value);
    const max = flow.action === "swap"
      ? Math.min(flow.target.cardCount, context.state?.players.get(context.selfId ?? "")?.cardCount ?? 0)
      : flow.target.cardCount;
    if (!Number.isInteger(position) || position < 1 || position > max) return { kind: "flow", flow, message: `Choose position 1 to ${max}.` };
    if (flow.action === "peek-other") return { kind: "game", command: { type: "peek-other", targetPlayerId: flow.target.id, position } };
    return { kind: "game", command: { type: "swap", targetPlayerId: flow.target.id, position } };
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
    case "room-browser": return `Public rooms — page ${flow.page + 1}/${Math.max(1, Math.ceil(flow.rooms.length / ROOM_PAGE_SIZE))} (←/→ pages, ↑/↓ options, Enter selects):`;
    case "position": return "Choose a card position (type cancel to go back):";
    case "replace-positions": return "Enter 1-4 card positions separated by spaces or commas (type cancel to go back):";
    case "replacement-position": return "Choose which selected position receives the drawn card:";
    case "mismatch-drawn-placement": return "The selected cards did not match. Place the drawn card at which end?";
    case "mismatch-penalty-placement": return "Place the facedown penalty card at which end?";
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

function positions(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}
