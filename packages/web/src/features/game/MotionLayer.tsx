import { useEffect, useState, type CSSProperties } from "react";
import type { KnownCard, PublicActionEvent } from "@cabo-game/shared";
import { formatCardLabel } from "../../components/TablePrimitives.js";
import type { CardMotion } from "./types.js";

interface CardFlight {
  key: string;
  from: DOMRect;
  to: DOMRect;
  card: KnownCard | undefined;
  delay: number | undefined;
  peek: boolean | undefined;
}

export function MotionLayer(props: { motion: CardMotion }) {
  const [flights, setFlights] = useState<CardFlight[]>([]);

  useEffect(() => {
    setFlights(buildFlights(props.motion));
  }, [props.motion]);

  return (
    <div className="motion-layer" aria-live="polite" aria-label={motionAnnouncement(props.motion)}>
      {flights.map((flight) => {
        const style = {
          left: flight.from.left,
          top: flight.from.top,
          width: flight.from.width,
          height: flight.from.height,
          "--motion-x": `${flight.to.left - flight.from.left}px`,
          "--motion-y": `${flight.to.top - flight.from.top}px`,
          "--motion-width": `${flight.to.width}px`,
          "--motion-height": `${flight.to.height}px`,
          animationDelay: `${flight.delay ?? 0}ms`,
        } as CSSProperties;
        return <div className={`motion-card motion-${props.motion.action} ${flight.card ? "face" : "back"} ${flight.peek ? "peek" : ""}`} style={style} key={flight.key}>{flight.card ? formatCardLabel(flight.card.label) : <span>C</span>}</div>;
      })}
    </div>
  );
}

export function buildFlights(motion: CardMotion): CardFlight[] {
  const deck = anchorRect("deck");
  const discard = anchorRect("discard");
  const decision = anchorRect(`decision-${motion.playerId}`);
  const position = motion.action === "swap" ? motion.ownPosition : "position" in motion ? motion.position : motion.action === "replace" ? motion.replacementPosition : undefined;
  const slot = position ? anchorRect(`slot-${motion.playerId}-${position}`) : undefined;
  const flight = (key: string, from: DOMRect | undefined, to: DOMRect | undefined, card?: KnownCard, delay?: number, peek?: boolean): CardFlight[] => from && to ? [{ key, from, to, card, delay, peek }] : [];

  switch (motion.action) {
    case "draw-deck": return flight("draw", deck, decision);
    case "draw-discard": return flight("take-discard", discard, decision, motion.takenCard);
    case "replace": return [
      ...flight("keep-drawn", decision, slot),
      ...flight("replace-discard", slot, discard, motion.discardedCards[0], 120),
    ];
    case "discard": return flight("discard-drawn", decision, discard, motion.discardedCard);
    case "peek-self": return flight("peek-self", slot, decision, undefined, 0, true);
    case "peek-other": return flight("peek-other", anchorRect(`slot-${motion.targetPlayerId}-${motion.position}`), decision, undefined, 0, true);
    case "swap": return [
      ...flight("swap-own", slot, anchorRect(`slot-${motion.targetPlayerId}-${motion.targetPosition}`)),
      ...flight("swap-target", anchorRect(`slot-${motion.targetPlayerId}-${motion.targetPosition}`), slot, undefined, 70),
    ];
    default: return [];
  }
}

function anchorRect(name: string): DOMRect | undefined {
  const element = [...document.querySelectorAll<HTMLElement>("[data-card-anchor]")].find((candidate) => candidate.dataset.cardAnchor === name);
  return element?.getBoundingClientRect();
}

export function motionDuration(motion: PublicActionEvent): number {
  if (motion.action === "peek-self" || motion.action === "peek-other" || motion.action === "swap") return 820;
  if (motion.action === "skip" || motion.action === "cabo") return 420;
  return 720;
}

function motionAnnouncement(motion: PublicActionEvent): string {
  if (motion.action === "draw-deck") return "A card moved from the deck to the player's drawn card area.";
  if (motion.action === "draw-discard") return "The top discard moved to the player's drawn card area.";
  if (motion.action === "replace") return `The drawn card replaced positions ${motion.positions.join(", ")}.`;
  if (motion.action === "exchange-mismatch") return `Positions ${motion.positions.join(", ")} did not match and were revealed.`;
  if (motion.action === "resolve-mismatch") return "The mismatch cards were placed at the chosen ends.";
  if (motion.action === "discard") return "The drawn card moved to the discard pile.";
  if (motion.action === "peek-self" || motion.action === "peek-other") return `Card ${motion.position} was inspected.`;
  if (motion.action === "swap") return `Card ${motion.ownPosition} was swapped with opponent card ${motion.targetPosition}.`;
  return motion.action === "skip" ? "The card power was skipped." : "Cabo was called.";
}
