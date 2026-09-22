import type { CaboStateLike, RoundResultView, StatePlayer } from "./model.js";
import type { KnowledgeState } from "./knowledge.js";
import { escapeTerminalText, flowPrompt, selectionOptionsFor, type InteractionContext, type InteractionFlow } from "./interaction.js";
import type { RoomChatMessage } from "@cabo-game/shared";

export interface DashboardInput extends InteractionContext {
  transientLines?: string[];
  remainingSeconds?: number | undefined;
  caboWarning?: string | undefined;
  knowledge: KnowledgeState;
  events: string[];
  chat?: RoomChatMessage[];
  notice?: string;
  flow: InteractionFlow;
  selectionIndex?: number;
  roomId?: string;
  roundResult?: RoundResultView;
}

const CHAT_INNER_WIDTH = 72;

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
  lines.push(`Mode: ${state.memoryMode} · Step timer: ${state.turnDurationSeconds || "unlimited"}${input.remainingSeconds !== undefined ? ` · ${input.remainingSeconds}s remaining` : ""}`);
  if (input.transientLines?.length) lines.push("Temporary reveal", ...input.transientLines.map(formatCardText));
  if (input.caboWarning) lines.push(input.caboWarning);
  lines.push(
    `${escapeTerminalText(state.roomName)}  Room ${escapeTerminalText(input.roomId ?? "-")}  Round ${state.round || "-"}  Target ${state.targetScore}`,
    statusLine(state, input.selfId),
    `Deck ${state.deckCount}  Discard ${formatCardText(state.discardLabel || "-")}${state.caboCallerId ? `  CABO: ${playerName(state, state.caboCallerId)}` : ""}`,
    "",
    "Players",
    ...renderPlayers(state, input.selfId),
  );

  if (input.roundResult) lines.push("", ...input.roundResult.lines.map(formatCardText), ...(input.roundResult.nextRoundPending ? [nextRoundProgress(state)] : []));
  lines.push("", ...renderEvents(input.events));
  lines.push("", ...renderChat(input.chat ?? [], input.selfId));
  if (state.phase !== "LOBBY") {
    lines.push("", "Hands", ...renderHands(state, input.selfId, input.knowledge));
    if (input.knowledge.held) lines.push(`  Drawn card: ${cardLabel(input.knowledge.held)}`);
    lines.push(...renderActions(input));
  } else {
    lines.push("", ...renderActions(input));
  }
  return lines.join("\n");
}

export function renderPlainState(state: CaboStateLike, selfId: string, knowledge: KnowledgeState, roomId: string): string {
  return renderDashboard({ state, selfId, knowledge, events: [], flow: { kind: "idle" }, roomId });
}

function statusLine(state: CaboStateLike, selfId: string): string {
  if (state.phase === "LOBBY") return "Status: Waiting for the host to start";
  if (state.phase === "ROUND_RESULT") return `Status: Round complete — ${nextRoundProgress(state)}`;
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
    const flags = playerFlags(player, selfId);
    return `${String(player.seat + 1).padStart(2)}  ${player.name.padEnd(nameWidth)}  ${String(player.score).padStart(3)} pts  ${player.cardCount} cards${flags ? `  ${flags}` : ""}`;
  });
}

function playerFlags(player: StatePlayer, selfId: string): string {
  return [
    player.id === selfId ? "YOU" : "",
    player.isHost ? "HOST" : "",
    !player.connected ? "OFFLINE (60s grace)" : "",
    player.forfeited ? "DNF" : "",
    player.nextRoundReady ? "READY" : "",
  ].filter(Boolean).map((flag) => `[${flag}]`).join(" ");
}

function nextRoundProgress(state: CaboStateLike): string {
  const active = [...state.players.values()].filter((player) => !player.forfeited);
  const ready = active.filter((player) => player.nextRoundReady).length;
  return `Waiting for next round: ${ready}/${active.length} active players ready.`;
}

function renderHands(state: CaboStateLike, selfId: string, knowledge: KnowledgeState): string[] {
  const players = [...state.players.values()].sort((a, b) => {
    if (a.id === selfId) return 1;
    if (b.id === selfId) return -1;
    return a.seat - b.seat;
  });
  return players.map((player) => {
    const knownSlots = player.id === selfId
      ? knowledge.slots
      : knowledge.opponents.find((opponent) => opponent.playerId === player.id)?.slots ?? [];
    const slots = Array.from({ length: player.cardCount }, (_, index) => knownSlots[index] ?? null);
    const turnMarker = player.id === state.currentPlayerId ? "→" : " ";
    const selfMarker = player.id === selfId ? " (you)" : "";
    const cards = slots.map((card, index) => `[${index + 1}] ${card ? cardLabel(card) : "?"}`).join("   ");
    return `${turnMarker} ${escapeTerminalText(player.name)}${selfMarker}: ${cards}`;
  });
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

function renderChat(messages: RoomChatMessage[], selfId: string): string[] {
  const lines = messages.slice(-8).flatMap((message) => {
    const date = new Date(message.sentAt);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const sender = message.playerId === selfId ? "You" : escapeTerminalText(message.playerName);
    return wrapPrefixedText(`  ${time}  ${sender}: `, escapeTerminalText(message.text), CHAT_INNER_WIDTH);
  });
  return renderBorder("Room chat", lines.length ? lines : ["  No messages yet. Press t to chat."], CHAT_INNER_WIDTH);
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

function renderBorder(title: string, lines: string[], fixedInnerWidth?: number): string[] {
  const innerWidth = fixedInnerWidth ?? Math.max(44, terminalWidth(title) + 3, ...lines.map(terminalWidth));
  const top = `┌─ ${title} ${"─".repeat(innerWidth - terminalWidth(title) - 3)}┐`;
  return [top, ...lines.map((line) => `│${padTerminalEnd(line, innerWidth)}│`), `└${"─".repeat(innerWidth)}┘`];
}

function wrapPrefixedText(prefix: string, text: string, maxWidth: number): string[] {
  const prefixWidth = terminalWidth(prefix);
  const continuation = " ".repeat(Math.min(prefixWidth, maxWidth - 1));
  const lines: string[] = [];
  let line = prefix;
  let width = prefixWidth;

  for (const character of text) {
    const characterWidth = terminalCharacterWidth(character);
    if (width + characterWidth > maxWidth && width > 0) {
      lines.push(line);
      line = continuation;
      width = terminalWidth(continuation);
    }
    line += character;
    width += characterWidth;
  }
  lines.push(line);
  return lines;
}

function padTerminalEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - terminalWidth(text)));
}

function terminalWidth(text: string): number {
  return [...text].reduce((width, character) => width + terminalCharacterWidth(character), 0);
}

function terminalCharacterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (/\p{Mark}/u.test(character) || codePoint === 0x200d || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) ? 0 : 1;
}
