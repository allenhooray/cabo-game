import type { PublicActionEvent } from "@cabo-game/shared";
import type { TFunction } from "i18next";
import type { ClientEvent } from "./types.js";

export function formatEvent(event: ClientEvent, name: (id: string) => string, t: TFunction): string | undefined {
  switch (event.type) {
    case "joined": return t("event.joined", { name: event.name });
    case "disconnected": return t("event.disconnected", { name: name(event.playerId) });
    case "reconnected": return t("event.reconnected", { name: name(event.playerId) });
    case "turn": return t(event.finalTurn ? "event.finalTurn" : "event.turn", { name: name(event.playerId) });
    case "turn-timeout": return t("event.timeout", { name: name(event.playerId) });
    case "action": return formatActionEvent(event, name, t);
    case "discard": case "swap": case "cabo": return undefined;
    case "forfeit": return t("event.forfeit", { name: name(event.playerId) });
    default: return undefined;
  }
}

function formatActionEvent(event: PublicActionEvent, name: (id: string) => string, t: TFunction): string | undefined {
  const actor = name(event.playerId);
  switch (event.action) {
    case "draw-deck": return t("event.drawDeck", { name: actor });
    case "draw-discard": return t("event.drawDiscard", { name: actor, card: event.takenCard.label });
    case "replace": return t("event.replace", { name: actor, positions: event.positions.join(", "), position: event.replacementPosition });
    case "exchange-mismatch": return t("event.exchangeMismatch", { name: actor });
    case "resolve-mismatch": return t("event.resolveMismatch", { name: actor });
    case "discard": return t("event.discard", { name: actor, card: event.discardedCard.label });
    case "peek-self": return t("event.peekSelf", { name: actor, position: event.position });
    case "peek-other": return t("event.peekOther", { name: actor, target: name(event.targetPlayerId), position: event.position });
    case "swap": return t("event.swap", { name: actor, own: event.ownPosition, target: name(event.targetPlayerId), position: event.targetPosition });
    case "skip": return t("event.skip", { name: actor });
    case "cabo": return t("event.cabo", { name: actor });
  }
}
