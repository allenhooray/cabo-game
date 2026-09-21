import type { ClientCommand, KnownSlots, OpponentKnowledge, PrivateKnowledgeSnapshot, PrivateRevealMessage } from "@cabo-game/shared";
import type { DisplayCard } from "./model.js";

export interface KnowledgeState extends PrivateKnowledgeSnapshot {}

export interface StoredKnowledge {
  round: number;
  slots: Array<DisplayCard | null>;
  opponents?: OpponentKnowledge[];
}

export interface PendingGameAction {
  command: ClientCommand;
}

const emptySlots = (): KnownSlots => [null, null, null, null];

export function createKnowledge(round = 0, stored?: StoredKnowledge): KnowledgeState {
  if (stored && stored.round === round && validSlots(stored.slots)) {
    return {
      round,
      slots: copySlots(stored.slots),
      opponents: copyOpponents(stored.opponents ?? []),
      held: null,
    };
  }
  return { round, slots: emptySlots(), opponents: [], held: null };
}

export function applyKnowledgeSnapshot(snapshot: PrivateKnowledgeSnapshot): KnowledgeState {
  return {
    round: snapshot.round,
    slots: copySlots(snapshot.slots),
    opponents: copyOpponents(snapshot.opponents),
    held: snapshot.held ? { ...snapshot.held } : null,
  };
}

export function resetForRound(state: KnowledgeState, round: number): KnowledgeState {
  if (state.round === round) return state;
  return createKnowledge(round);
}

export function applyReveal(
  state: KnowledgeState,
  message: PrivateRevealMessage,
  publicRound: number,
  publicPhase: string,
  pending?: PendingGameAction,
): KnowledgeState {
  const card = { label: message.card.label, rank: message.card.rank };
  if (message.reason === "draw") return { ...state, held: card };

  const revealPrecedesNextRound = message.reason === "initial" && (publicPhase === "LOBBY" || publicPhase === "ROUND_RESULT");
  const targetRound = revealPrecedesNextRound ? publicRound + 1 : publicRound;
  const base = resetForRound(state, targetRound);
  if (!message.position) return base;
  const isOwnReveal = message.reason === "initial" || pending?.command.type === "peek-self";
  if (isOwnReveal) {
    const slots = [...base.slots] as KnownSlots;
    slots[message.position - 1] = card;
    return { ...base, slots };
  }
  if (pending?.command.type === "peek-other") {
    const targetPlayerId = pending.command.targetPlayerId;
    const opponents = copyOpponents(base.opponents);
    let opponent = opponents.find((entry) => entry.playerId === targetPlayerId);
    if (!opponent) {
      opponent = { playerId: targetPlayerId, slots: emptySlots() };
      opponents.push(opponent);
    }
    opponent.slots[message.position - 1] = card;
    return { ...base, opponents };
  }
  return base;
}

export function applyOwnActionEvent(state: KnowledgeState, pending?: PendingGameAction): KnowledgeState {
  if (!pending) return state;
  const command = pending.command;
  if (command.type === "replace") {
    const selected = new Set(command.positions);
    const slots = state.slots.flatMap((card, index) => {
      const position = index + 1;
      if (!selected.has(position)) return [card];
      return position === command.replacementPosition ? [state.held] : [];
    });
    return { ...state, slots, held: null };
  }
  if (command.type === "discard") return { ...state, held: null };
  return state;
}

export function applySwapEvent(state: KnowledgeState, position: number, involvesSelf: boolean): KnowledgeState {
  if (!involvesSelf || position < 1 || position > state.slots.length) return state;
  const slots = [...state.slots] as KnownSlots;
  slots[position - 1] = null;
  return { ...state, slots };
}

export function storedKnowledge(state: KnowledgeState): StoredKnowledge {
  return { round: state.round, slots: copySlots(state.slots), opponents: copyOpponents(state.opponents) };
}

export function isStoredKnowledge(value: unknown): value is StoredKnowledge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredKnowledge>;
  return Number.isInteger(candidate.round)
    && validSlots(candidate.slots)
    && (candidate.opponents === undefined || validOpponents(candidate.opponents));
}

function validSlots(value: unknown): value is Array<DisplayCard | null> {
  return Array.isArray(value) && value.every((card) => {
    if (card === null) return true;
    if (!card || typeof card !== "object") return false;
    const candidate = card as Partial<DisplayCard>;
    return typeof candidate.label === "string" && typeof candidate.rank === "number";
  });
}

function validOpponents(value: unknown): value is OpponentKnowledge[] {
  return Array.isArray(value) && value.every((entry) => Boolean(
    entry
    && typeof entry === "object"
    && typeof (entry as OpponentKnowledge).playerId === "string"
    && validSlots((entry as OpponentKnowledge).slots),
  ));
}

function copySlots(slots: Array<DisplayCard | null>): KnownSlots {
  return slots.map((card) => card ? { ...card } : null);
}

function copyOpponents(opponents: OpponentKnowledge[]): OpponentKnowledge[] {
  return opponents.map((entry) => ({ playerId: entry.playerId, slots: copySlots(entry.slots) }));
}
