import type { ClientCommand } from "@cabo-game/shared";
import type { CaboStateLike, StatePlayer } from "./model.js";

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

export type InteractionFlow =
  | { kind: "idle" }
  | { kind: "create-target"; visibility: "public" | "private" }
  | { kind: "join-room" }
  | { kind: "position"; action: "draw-discard" | "replace" | "peek-self"; guard: string }
  | { kind: "target"; action: "peek-other" | "swap"; guard: string }
  | { kind: "target-position"; action: "peek-other" | "swap"; target: StatePlayer; guard: string }
  | { kind: "confirm-cabo"; guard: string };

export interface InteractionContext {
  state?: CaboStateLike;
  selfId?: string;
}

export type InteractionResult =
  | { kind: "flow"; flow: InteractionFlow; message?: string }
  | { kind: "local"; command: string }
  | { kind: "game"; command: ClientCommand };

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

export function selectMenu(input: string, context: InteractionContext): InteractionResult | undefined {
  const item = menuFor(context).find((entry) => entry.key === input.trim());
  if (!item) return undefined;
  const guard = stateGuard(context);
  switch (item.action) {
    case "rooms": case "reconnect": case "start": case "players": case "leave":
      return { kind: "local", command: item.action };
    case "create-public": case "create-private":
      return { kind: "flow", flow: { kind: "create-target", visibility: item.action === "create-public" ? "public" : "private" } };
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
  if (flow.kind === "create-target") {
    const target = value === "" ? 100 : Number(value);
    if (!Number.isInteger(target) || target < 20 || target > 500) return { kind: "flow", flow, message: "Enter a target score from 20 to 500, or press Enter for 100." };
    return { kind: "local", command: `create ${flow.visibility} ${target}` };
  }
  if (flow.kind === "join-room") {
    if (!value) return { kind: "flow", flow, message: "Enter a room code." };
    return { kind: "local", command: `join ${value}` };
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
    case "create-target": return `Target score for ${flow.visibility} room (20-500, Enter = 100):`;
    case "join-room": return "Room code:";
    case "position": return "Choose card position: [1] [2] [3] [4]  (cancel to go back)";
    case "target": return `Choose player: ${activeTargets(context).map((player, index) => `[${index + 1}] ${player.name}`).join("  ")}  (cancel to go back)`;
    case "target-position": return `Choose ${flow.target.name}'s position: [1] [2] [3] [4]  (cancel to go back)`;
    case "confirm-cabo": return "Call CABO? Every other active player gets one final turn. [y/N]";
  }
}

export function isGuardedFlow(flow: InteractionFlow): flow is Exclude<InteractionFlow, { kind: "idle" } | { kind: "create-target" } | { kind: "join-room" }> {
  return "guard" in flow;
}
