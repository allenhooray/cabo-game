import type { CaboStateLike, RoundResultView, StatePlayer } from "./model.js";
import type { KnowledgeState } from "./knowledge.js";
import { escapeTerminalText, flowPrompt, selectionOptionsFor, type InteractionContext, type InteractionFlow } from "./interaction.js";

export interface DashboardInput extends InteractionContext {
  knowledge: KnowledgeState;
  events: string[];
  notice?: string;
  flow: InteractionFlow;
  selectionIndex?: number;
  roomId?: string;
  roundResult?: RoundResultView;
}

export function renderCommandPrompt(interactive: boolean): string {
  return interactive ? "\x1b[7m cabo> \x1b[0m " : "cabo> ";
}

export function renderDashboard(input: DashboardInput): string {
  const lines = ["CABO", "===="];
  if (!input.state || !input.selfId) {
    lines.push("Not connected to a room.");
    if (input.flow.kind !== "room-browser") lines.push("", ...renderEvents(input.events));
    lines.push("", ...renderActions(input));
    return lines.join("\n");
  }

  const state = input.state;
  lines.push(
    `${escapeTerminalText(state.roomName)}  Room ${escapeTerminalText(input.roomId ?? "-")}  Round ${state.round || "-"}  Target ${state.targetScore}`,
    statusLine(state, input.selfId),
    `Deck ${state.deckCount}  Discard ${formatCardText(state.discardLabel || "-")}${state.caboCallerId ? `  CABO: ${playerName(state, state.caboCallerId)}` : ""}`,
    "",
    "Players",
    ...renderPlayers(state, input.selfId),
  );

  if (input.roundResult) lines.push("", ...input.roundResult.lines.map(formatCardText), ...(input.roundResult.nextRoundPending ? ["Next round begins in about 5 seconds..."] : []));
  lines.push("", ...renderEvents(input.events));
  if (state.phase !== "LOBBY") {
    lines.push("", "Your cards", renderCards(input.knowledge));
    if (input.knowledge.held) lines.push(`Drawn card: ${cardLabel(input.knowledge.held)}`);
    const knownOpponents = input.knowledge.opponents.filter((opponent) => opponent.slots.some(Boolean));
    if (knownOpponents.length) {
      lines.push("", "Known opponent cards", ...knownOpponents.map((opponent) => {
        const name = state.players.get(opponent.playerId)?.name ?? opponent.playerId;
        return `${name}: ${opponent.slots.map((card, index) => `[${index + 1}] ${card ? cardLabel(card) : "?"}`).join("   ")}`;
      }));
    }
  }
  lines.push("", ...renderActions(input));
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
  if (state.phase === "DRAWN") return `Status: YOUR TURN — replace 1-4 cards${state.drawSource === "deck" ? " or discard the drawn card" : ""}`;
  if (state.phase === "MISMATCH_PENDING") return "Status: YOUR TURN — place the mismatch card and penalty";
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
  return `${formatCardText(card.label)} (${card.rank} pts)`;
}

function renderEvents(events: string[]): string[] {
  return [
    "Recent events",
    ...(events.length ? events.slice(-8).map((event) => `  • ${formatCardText(event)}`) : ["  • No events yet."]),
    "─".repeat(48),
  ];
}

function renderActions(input: DashboardInput): string[] {
  const prompt = flowPrompt(input.flow, input);
  const options = selectionOptionsFor(input.flow, input);
  const selected = options.length ? Math.min(Math.max(input.selectionIndex ?? 0, 0), options.length - 1) : 0;
  const lines: string[] = [];
  if (prompt) lines.push(`  ${prompt}`);
  if (options.length) {
    lines.push(...options.map((option, index) => `${index === selected ? ">" : " "} [${option.value}] ${input.flow.kind === "room-browser" ? option.label : formatCardText(option.label)}`));
    lines.push("  Use ↑/↓ to move and Enter to select.");
  } else if (!prompt) {
    lines.push("  Waiting for another player...");
  }
  if (input.flow.kind === "idle") lines.push("  Type help for all commands.");
  if (input.flow.kind === "idle" && input.state?.phase === "LOBBY" && input.selfId) {
    lines.push("  Want an Agent to play? Ask it to use the cabo-agent command.");
  }
  const notice = input.flow.kind === "room-browser" ? input.flow.message ?? input.notice : input.notice;
  if (notice) lines.push(`  ! ${escapeTerminalText(notice)}`);
  return renderBorder(input.flow.kind === "room-browser" ? "Rooms" : "Actions", lines);
}

function playerName(state: CaboStateLike, id: string): string {
  return state.players.get(id)?.name ?? id;
}

export function formatCardText(text: string): string {
  const suits: Record<string, string> = { S: "♠", D: "♢", H: "♡", C: "♣" };
  return text.replace(/\b(A|[2-9]|10|J|Q|K)([SDHC])\b/g, (_match, rank: string, suit: string) => `${rank}${suits[suit]}`);
}

function renderBorder(title: string, lines: string[]): string[] {
  const innerWidth = Math.max(44, title.length + 3, ...lines.map((line) => line.length));
  const top = `┌─ ${title} ${"─".repeat(innerWidth - title.length - 3)}┐`;
  return [top, ...lines.map((line) => `│${line.padEnd(innerWidth)}│`), `└${"─".repeat(innerWidth)}┘`];
}
