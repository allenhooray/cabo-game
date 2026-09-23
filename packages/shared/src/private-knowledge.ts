import type { ClientCommand } from "./protocol.js";
import type {
  Card,
  EngineEvent,
  KnownCard,
  KnownSlots,
  MemoryMode,
  Position,
  PrivateKnowledgeSnapshot,
  PublicActionEvent,
} from "./types.js";

const emptySlots = (length = 4): KnownSlots => Array.from({ length }, () => null);
const displayCard = (card: Card | KnownCard): KnownCard => ({ label: card.label, rank: card.rank });

export class PrivateKnowledgeStore {
  private mode: MemoryMode = "assisted";
  private readonly viewers = new Map<string, PrivateKnowledgeSnapshot>();

  reset(round: number, playerIds: string[], mode: MemoryMode): void {
    this.mode = mode;
    this.viewers.clear();
    for (const viewerId of playerIds) {
      this.viewers.set(viewerId, {
        memoryMode: mode,
        round,
        slots: emptySlots(),
        opponents: playerIds.filter((id) => id !== viewerId).map((playerId) => ({ playerId, slots: emptySlots() })),
        held: null,
      });
    }
  }

  applyPrivateReveal(event: Extract<EngineEvent, { type: "private-reveal" }>, command?: ClientCommand): void {
    const viewer = this.viewers.get(event.playerId);
    if (!viewer) return;
    const card = displayCard(event.card);
    if (event.reason === "draw") {
      viewer.held = card;
      return;
    }
    if (this.mode === "classic") return;
    if (!event.position) return;
    if (event.reason === "initial" || command?.type === "peek-self") {
      viewer.slots[event.position - 1] = card;
      return;
    }
    if (command?.type === "peek-other") {
      this.slotsFor(event.playerId, viewer, command.targetPlayerId)[event.position - 1] = card;
    }
  }

  applyAction(event: PublicActionEvent): void {
    for (const [viewerId, knowledge] of this.viewers) {
      if (event.action === "draw-discard") {
        continue;
      } else if (event.action === "replace") {
        const slots = this.slotsFor(viewerId, knowledge, event.playerId);
        const inserted = viewerId === event.playerId && knowledge.held
          ? { ...knowledge.held }
          : event.insertedCard ? { ...event.insertedCard } : null;
        const selected = new Set(event.positions);
        const next = slots.flatMap((card, index) => {
          const position = index + 1;
          if (!selected.has(position)) return [card];
          return position === event.replacementPosition ? [inserted] : [];
        });
        slots.splice(0, slots.length, ...next);
        if (viewerId === event.playerId) knowledge.held = null;
      } else if (event.action === "exchange-mismatch") {
        const slots = this.slotsFor(viewerId, knowledge, event.playerId);
        event.positions.forEach((position, index) => {
          slots[position - 1] = event.revealedCards[index] ? { ...event.revealedCards[index] } : null;
        });
      } else if (event.action === "resolve-mismatch") {
        const slots = this.slotsFor(viewerId, knowledge, event.playerId);
        const inserted = viewerId === event.playerId && knowledge.held
          ? { ...knowledge.held }
          : event.insertedCard ? { ...event.insertedCard } : null;
        this.insert(slots, inserted, event.drawnPlacement);
        if (event.penaltyPlacement) this.insert(slots, null, event.penaltyPlacement);
        if (viewerId === event.playerId) knowledge.held = null;
      } else if (event.action === "discard") {
        if (viewerId === event.playerId) knowledge.held = null;
      } else if (event.action === "swap") {
        const own = this.slotsFor(viewerId, knowledge, event.playerId);
        const target = this.slotsFor(viewerId, knowledge, event.targetPlayerId);
        const ownCard = own[event.ownPosition - 1] ?? null;
        const targetCard = target[event.targetPosition - 1] ?? null;
        own[event.ownPosition - 1] = targetCard;
        target[event.targetPosition - 1] = ownCard;
      }
      if (this.mode === "classic") {
        knowledge.slots.fill(null);
        for (const opponent of knowledge.opponents) opponent.slots.fill(null);
      }
    }
  }

  removePlayer(playerId: string): void {
    this.viewers.delete(playerId);
    for (const knowledge of this.viewers.values()) {
      knowledge.opponents = knowledge.opponents.filter((opponent) => opponent.playerId !== playerId);
    }
  }

  snapshot(viewerId: string): PrivateKnowledgeSnapshot | undefined {
    const value = this.viewers.get(viewerId);
    if (!value) return undefined;
    return {
      memoryMode: this.mode,
      round: value.round,
      slots: value.slots.map(copyCard),
      opponents: value.opponents.map((opponent) => ({
        playerId: opponent.playerId,
        slots: opponent.slots.map(copyCard),
      })),
      held: copyCard(value.held),
    };
  }

  private slotsFor(viewerId: string, knowledge: PrivateKnowledgeSnapshot, ownerId: string): KnownSlots {
    if (viewerId === ownerId) return knowledge.slots;
    let opponent = knowledge.opponents.find((entry) => entry.playerId === ownerId);
    if (!opponent) {
      opponent = { playerId: ownerId, slots: emptySlots() };
      knowledge.opponents.push(opponent);
    }
    return opponent.slots;
  }

  private insert(slots: KnownSlots, card: KnownCard | null, placement: "left" | "right"): void {
    if (placement === "left") slots.unshift(card);
    else slots.push(card);
  }
}

export function publicAction(
  command: ClientCommand,
  playerId: string,
  events: EngineEvent[],
  discardBefore?: Card,
  pendingDraw?: { card: Card; source: "deck" | "discard" },
): PublicActionEvent | undefined {
  const discarded = events.filter((event): event is Extract<EngineEvent, { type: "discard" }> => event.type === "discard").map((event) => event.card);
  switch (command.type) {
    case "draw-deck": return { type: "action", action: command.type, playerId };
    case "draw-discard": return discardBefore
      ? { type: "action", action: command.type, playerId, takenCard: displayCard(discardBefore) }
      : undefined;
    case "replace": {
      const mismatch = events.find((event): event is Extract<EngineEvent, { type: "exchange-mismatch" }> => event.type === "exchange-mismatch");
      if (mismatch) return {
        type: "action",
        action: "exchange-mismatch",
        playerId,
        positions: [...mismatch.positions],
        revealedCards: mismatch.cards.map(displayCard),
        penaltyCardPending: mismatch.penaltyCardPending,
      };
      return discarded.length ? {
        type: "action",
        action: command.type,
        playerId,
        positions: [...command.positions] as Position[],
        replacementPosition: command.replacementPosition as Position,
        discardedCards: discarded.map(displayCard),
        ...(pendingDraw?.source === "discard" ? { insertedCard: displayCard(pendingDraw.card) } : {}),
      } : undefined;
    }
    case "resolve-mismatch": return {
      type: "action",
      action: command.type,
      playerId,
      drawnPlacement: command.drawnPlacement,
      ...(command.penaltyPlacement ? { penaltyPlacement: command.penaltyPlacement } : {}),
      ...(pendingDraw?.source === "discard" ? { insertedCard: displayCard(pendingDraw.card) } : {}),
    };
    case "discard": return discarded[0] ? { type: "action", action: command.type, playerId, discardedCard: displayCard(discarded[0]) } : undefined;
    case "peek-self": return { type: "action", action: command.type, playerId, position: command.position as Position };
    case "peek-other": return { type: "action", action: command.type, playerId, targetPlayerId: command.targetPlayerId, position: command.position as Position };
    case "swap": return { type: "action", action: command.type, playerId, targetPlayerId: command.targetPlayerId, ownPosition: command.ownPosition, targetPosition: command.targetPosition };
    case "skip": return { type: "action", action: command.type, playerId };
    case "cabo": return { type: "action", action: command.type, playerId };
    default: return undefined;
  }
}

function copyCard(card: KnownCard | null): KnownCard | null {
  return card ? { ...card } : null;
}
