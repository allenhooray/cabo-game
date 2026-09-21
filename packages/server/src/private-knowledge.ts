import type {
  Card,
  ClientCommand,
  EngineEvent,
  KnownCard,
  KnownSlots,
  Position,
  PrivateKnowledgeSnapshot,
  PublicActionEvent,
} from "@cabo-game/shared";

const emptySlots = (): KnownSlots => [null, null, null, null];
const displayCard = (card: Card | KnownCard): KnownCard => ({ label: card.label, rank: card.rank });

export class PrivateKnowledgeStore {
  private readonly viewers = new Map<string, PrivateKnowledgeSnapshot>();

  reset(round: number, playerIds: string[]): void {
    this.viewers.clear();
    for (const viewerId of playerIds) {
      this.viewers.set(viewerId, {
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
        this.slotsFor(viewerId, knowledge, event.playerId)[event.position - 1] = { ...event.takenCard };
      } else if (event.action === "replace") {
        this.slotsFor(viewerId, knowledge, event.playerId)[event.position - 1] = viewerId === event.playerId && knowledge.held
          ? { ...knowledge.held }
          : null;
        if (viewerId === event.playerId) knowledge.held = null;
      } else if (event.action === "discard") {
        if (viewerId === event.playerId) knowledge.held = null;
      } else if (event.action === "swap") {
        const own = this.slotsFor(viewerId, knowledge, event.playerId);
        const target = this.slotsFor(viewerId, knowledge, event.targetPlayerId);
        const index = event.position - 1;
        const ownCard = own[index] ?? null;
        const targetCard = target[index] ?? null;
        own[index] = targetCard;
        target[index] = ownCard;
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
      round: value.round,
      slots: value.slots.map(copyCard) as KnownSlots,
      opponents: value.opponents.map((opponent) => ({
        playerId: opponent.playerId,
        slots: opponent.slots.map(copyCard) as KnownSlots,
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
}

export function publicAction(command: ClientCommand, playerId: string, events: EngineEvent[], discardBefore?: Card): PublicActionEvent | undefined {
  const discarded = events.find((event): event is Extract<EngineEvent, { type: "discard" }> => event.type === "discard")?.card;
  switch (command.type) {
    case "draw-deck": return { type: "action", action: command.type, playerId };
    case "draw-discard": return discardBefore && discarded
      ? { type: "action", action: command.type, playerId, position: command.position as Position, takenCard: displayCard(discardBefore), discardedCard: displayCard(discarded) }
      : undefined;
    case "replace": return discarded ? { type: "action", action: command.type, playerId, position: command.position as Position, discardedCard: displayCard(discarded) } : undefined;
    case "discard": return discarded ? { type: "action", action: command.type, playerId, discardedCard: displayCard(discarded) } : undefined;
    case "peek-self": return { type: "action", action: command.type, playerId, position: command.position as Position };
    case "peek-other": return { type: "action", action: command.type, playerId, targetPlayerId: command.targetPlayerId, position: command.position as Position };
    case "swap": return { type: "action", action: command.type, playerId, targetPlayerId: command.targetPlayerId, position: command.position as Position };
    case "skip": return { type: "action", action: command.type, playerId };
    case "cabo": return { type: "action", action: command.type, playerId };
    default: return undefined;
  }
}

function copyCard(card: KnownCard | null): KnownCard | null {
  return card ? { ...card } : null;
}
