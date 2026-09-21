import type { ClientCommand, PrivateRevealMessage } from "@cabo-game/shared";
import type { DisplayCard } from "./model.js";

export interface KnowledgeState {
  round: number;
  slots: Array<DisplayCard | null>;
  held: DisplayCard | null;
}

export interface StoredKnowledge {
  round: number;
  slots: Array<DisplayCard | null>;
}

export interface PendingGameAction {
  command: ClientCommand;
  discard?: DisplayCard;
}

const emptySlots = (): Array<DisplayCard | null> => [null, null, null, null];

export function createKnowledge(round = 0, stored?: StoredKnowledge): KnowledgeState {
  if (stored && stored.round === round && validSlots(stored.slots)) {
    return { round, slots: stored.slots.map((card) => card ? { ...card } : null), held: null };
  }
  return { round, slots: emptySlots(), held: null };
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
  const isOwnReveal = message.reason === "initial" || pending?.command.type === "peek-self";
  if (!isOwnReveal || !message.position) return base;
  const slots = [...base.slots];
  slots[message.position - 1] = card;
  return { ...base, slots };
}

export function applyOwnActionEvent(state: KnowledgeState, pending?: PendingGameAction): KnowledgeState {
  if (!pending) return state;
  const command = pending.command;
  if (command.type === "replace") {
    const slots = [...state.slots];
    slots[command.position - 1] = state.held;
    return { ...state, slots, held: null };
  }
  if (command.type === "draw-discard") {
    const slots = [...state.slots];
    slots[command.position - 1] = pending.discard ?? null;
    return { ...state, slots };
  }
  if (command.type === "discard") return { ...state, held: null };
  return state;
}

export function applySwapEvent(state: KnowledgeState, position: number, involvesSelf: boolean): KnowledgeState {
  if (!involvesSelf || position < 1 || position > 4) return state;
  const slots = [...state.slots];
  slots[position - 1] = null;
  return { ...state, slots };
}

export function storedKnowledge(state: KnowledgeState): StoredKnowledge {
  return { round: state.round, slots: state.slots.map((card) => card ? { ...card } : null) };
}

export function isStoredKnowledge(value: unknown): value is StoredKnowledge {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredKnowledge>;
  return Number.isInteger(candidate.round) && validSlots(candidate.slots);
}

function validSlots(value: unknown): value is Array<DisplayCard | null> {
  return Array.isArray(value) && value.length === 4 && value.every((card) => {
    if (card === null) return true;
    if (!card || typeof card !== "object") return false;
    const candidate = card as Partial<DisplayCard>;
    return typeof candidate.label === "string" && typeof candidate.rank === "number";
  });
}
