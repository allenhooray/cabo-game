import type { CaboStateLike, RoundResultView, StatePlayer } from "./model.js";
import type { KnowledgeState } from "./knowledge.js";
import { activeTargets, flowPrompt, menuFor, type InteractionContext, type InteractionFlow } from "./interaction.js";

export interface DashboardInput extends InteractionContext {
  knowledge: KnowledgeState;
  events: string[];
  notice?: string;
  flow: InteractionFlow;
  roomId?: string;
  roundResult?: RoundResultView;
}

export function renderDashboard(input: DashboardInput): string {
  const lines = ["CABO", "===="];
  if (!input.state || !input.selfId) {
    lines.push("Not connected to a room.", "", ...renderEvents(input.events), "", ...renderActions(input));
    return lines.join("\n");
  }

  const state = input.state;
  lines.push(
    `Room ${input.roomId ?? "-"}  Round ${state.round || "-"}  Target ${state.targetScore}`,
    statusLine(state, input.selfId),
    `Deck ${state.deckCount}  Discard ${state.discardLabel || "-"}${state.caboCallerId ? `  CABO: ${playerName(state, state.caboCallerId)}` : ""}`,
    "",
    "Players",
    ...renderPlayers(state, input.selfId),
  );

  if (state.phase !== "LOBBY") {
    lines.push("", "Your cards", renderCards(input.knowledge));
    if (input.knowledge.held) lines.push(`Drawn card: ${cardLabel(input.knowledge.held)}`);
  }
  if (input.roundResult) lines.push("", ...input.roundResult.lines, ...(input.roundResult.nextRoundPending ? ["Next round begins in about 5 seconds..."] : []));
  lines.push("", ...renderEvents(input.events), "", ...renderActions(input));
  return lines.join("\n");
}

export function renderPlainState(state: CaboStateLike, selfId: string, knowledge: KnowledgeState, roomId: string): string {
  return renderDashboard({ state, selfId, knowledge, events: [], flow: { kind: "idle" }, roomId });
}

function statusLine(state: CaboStateLike, selfId: string): string {
  if (state.phase === "LOBBY") return "Status: Waiting for the host to start";
  if (state.phase === "ROUND_RESULT") return "Status: Round complete";
  if (state.phase === "MATCH_RESULT") return `Status: Match complete — winner${state.winners.length === 1 ? "" : "s"}: ${state.winners.map((id) => playerName(state, id)).join(", ")}`;
  const turn = state.currentPlayerId ? playerName(state, state.currentPlayerId) : "-";
  if (state.currentPlayerId !== selfId) return `Status: ${turn}'s turn${state.phase === "FINAL_TURNS" ? " (final turn)" : ""}`;
  if (state.phase === "DRAWN") return "Status: YOUR TURN — replace a card or discard the drawn card";
  if (state.phase === "POWER_PENDING") return "Status: YOUR TURN — choose how to use the discarded card's power";
  return `Status: YOUR TURN — choose where to draw${state.phase === "FINAL_TURNS" ? " (final turn)" : ""}`;
}

function renderPlayers(state: CaboStateLike, selfId: string): string[] {
  const rows = [...state.players.values()].sort((a, b) => a.seat - b.seat);
  const nameWidth = Math.max(6, ...rows.map((player) => player.name.length));
  return rows.map((player) => {
    const flags = playerFlags(player, state, selfId);
    return `${String(player.seat + 1).padStart(2)}  ${player.name.padEnd(nameWidth)}  ${String(player.score).padStart(3)} pts  ${player.cardCount} cards${flags ? `  ${flags}` : ""}`;
  });
}

function playerFlags(player: StatePlayer, state: CaboStateLike, selfId: string): string {
  return [
    player.id === selfId ? "YOU" : "",
    player.id === state.currentPlayerId ? "TURN" : "",
    player.isHost ? "HOST" : "",
    !player.connected ? "OFFLINE (60s grace)" : "",
    player.forfeited ? "DNF" : "",
  ].filter(Boolean).map((flag) => `[${flag}]`).join(" ");
}

function renderCards(knowledge: KnowledgeState): string {
  return knowledge.slots.map((card, index) => `[${index + 1}] ${card ? cardLabel(card) : "?"}`).join("   ");
}

function cardLabel(card: { label: string; rank: number }): string {
  return `${card.label} (${card.rank} pts)`;
}

function renderEvents(events: string[]): string[] {
  return ["Recent events", ...(events.length ? events.slice(-8).map((event) => `  • ${event}`) : ["  • No events yet."])];
}

function renderActions(input: DashboardInput): string[] {
  const prompt = flowPrompt(input.flow, input);
  if (prompt) return ["Action", `  ${prompt}`, ...(input.notice ? [`  ! ${input.notice}`] : [])];
  const menu = menuFor(input);
  const lines = ["Actions"];
  if (menu.length) lines.push(...menu.map((item) => `  [${item.key}] ${item.label}`));
  else lines.push("  Waiting for another player...");
  lines.push("  Type help for all commands.");
  if (input.notice) lines.push(`  ! ${input.notice}`);
  return lines;
}

function playerName(state: CaboStateLike, id: string): string {
  return state.players.get(id)?.name ?? id;
}
