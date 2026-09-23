import type { PublicActionEvent } from "@cabo-game/shared";
import type { ClientEvent } from "./types.js";

export function formatEvent(event: ClientEvent, name: (id: string) => string): string | undefined {
  switch (event.type) {
    case "joined": return `${event.name} joined the table.`;
    case "disconnected": return `${name(event.playerId)} went offline.`;
    case "reconnected": return `${name(event.playerId)} reconnected.`;
    case "turn": return `${name(event.playerId)} is playing${event.finalTurn ? " their final turn" : ""}.`;
    case "turn-timeout": return `${name(event.playerId)} timed out; the server completed their turn.`;
    case "action": return formatActionEvent(event, name);
    case "discard": case "swap": case "cabo": return undefined;
    case "forfeit": return `${name(event.playerId)} forfeited.`;
    default: return undefined;
  }
}

function formatActionEvent(event: PublicActionEvent, name: (id: string) => string): string | undefined {
  const actor = name(event.playerId);
  switch (event.action) {
    case "draw-deck": return `${actor} drew a hidden card from the deck.`;
    case "draw-discard": return `${actor} took ${event.takenCard.label} from the discard pile.`;
    case "replace": return `${actor} replaced positions ${event.positions.join(", ")}; drawn card placed at ${event.replacementPosition}.`;
    case "exchange-mismatch": return `${actor}'s selected cards did not match and were revealed.`;
    case "resolve-mismatch": return `${actor} placed the mismatch cards at the chosen ends.`;
    case "discard": return `${actor} discarded the drawn ${event.discardedCard.label}.`;
    case "peek-self": return `${actor} looked at their card ${event.position}.`;
    case "peek-other": return `${actor} looked at ${name(event.targetPlayerId)}'s card ${event.position}.`;
    case "swap": return `${actor} swapped card ${event.ownPosition} with ${name(event.targetPlayerId)}'s card ${event.targetPosition}.`;
    case "skip": return `${actor} skipped the card power.`;
    case "cabo": return `${actor} called Cabo.`;
  }
}
