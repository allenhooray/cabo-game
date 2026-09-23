import { useCallback, useEffect, useRef, useState } from "react";
import type { CaboStateLike } from "@cabo-game/client-core";
import type { PrivateRevealMessage } from "@cabo-game/shared";
import { formatEvent } from "./events.js";
import { motionDuration } from "./MotionLayer.js";
import type { CardMotion, ClientEvent, ResultEvent, TemporaryCard } from "./types.js";

export function useGameEffects() {
  const [temporaryCards, setTemporaryCards] = useState<TemporaryCard[]>([]);
  const [clockNow, setClockNow] = useState(Date.now);
  const [events, setEvents] = useState<string[]>([]);
  const [result, setResult] = useState<ResultEvent>();
  const [privateReveal, setPrivateReveal] = useState<PrivateRevealMessage>();
  const [cardMotion, setCardMotion] = useState<CardMotion>();
  const [motionQueue, setMotionQueue] = useState<CardMotion[]>([]);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionId = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setClockNow(Date.now());
      setTemporaryCards((cards) => cards.filter((card) => card.expiresAt > Date.now()));
    }, 200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (cardMotion || motionQueue.length === 0) return;
    const next = motionQueue[0];
    if (!next) return;
    setMotionQueue((current) => current.slice(1));
    setCardMotion(next);
    motionTimer.current = setTimeout(() => setCardMotion((current) => current?.id === next.id ? undefined : current), motionDuration(next));
  }, [cardMotion, motionQueue]);

  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (motionTimer.current) clearTimeout(motionTimer.current);
  }, []);

  const handleState = useCallback((state: CaboStateLike) => {
    setTemporaryCards((cards) => cards.filter((card) => card.round === state.round));
    if (state.phase !== "ROUND_RESULT" && state.phase !== "MATCH_RESULT") setResult(undefined);
  }, []);

  const handleReveal = useCallback((message: PrivateRevealMessage) => {
    if (message.memoryMode === "classic" && message.reason !== "draw" && message.position) {
      const position = message.position;
      setTemporaryCards((cards) => [
        ...cards.filter((entry) => entry.round === message.round && !(entry.ownerId === message.ownerId && entry.position === position)),
        { ownerId: message.ownerId, position, card: message.card, round: message.round, expiresAt: Date.now() + (message.reason === "initial" ? 5000 : 3200) },
      ]);
    }
    if (message.reason === "peek") {
      setPrivateReveal(message);
      if (revealTimer.current) clearTimeout(revealTimer.current);
      revealTimer.current = setTimeout(() => setPrivateReveal(undefined), 3_200);
    }
  }, []);

  const handleEvent = useCallback((event: ClientEvent, state: CaboStateLike | undefined) => {
    if (event.type === "action" && event.action === "exchange-mismatch" && state?.memoryMode === "classic") {
      const round = state.round;
      setTemporaryCards((cards) => [
        ...cards.filter((card) => card.ownerId !== event.playerId),
        ...event.positions.flatMap((position, index) => {
          const card = event.revealedCards[index];
          return card ? [{ ownerId: event.playerId, position, card, round, expiresAt: Date.now() + 3200 }] : [];
        }),
      ]);
    } else if (event.type === "action" && (event.action === "replace" || event.action === "resolve-mismatch" || event.action === "swap")) {
      const targetPlayerId = "targetPlayerId" in event ? event.targetPlayerId : undefined;
      setTemporaryCards((cards) => cards.filter((card) => card.ownerId !== event.playerId && card.ownerId !== targetPlayerId));
    }
    if (event.type === "round-result" || event.type === "match-result") setResult(event);
    if (event.type === "action") setMotionQueue((current) => [...current, { ...event, id: ++motionId.current }]);
    const label = formatEvent(event, (id) => state?.players.get(id)?.name ?? id);
    if (label) setEvents((current) => [...current.slice(-5), label]);
  }, []);

  const reset = useCallback(() => {
    setEvents([]);
    setResult(undefined);
  }, []);

  return {
    temporaryCards,
    clockNow,
    events,
    result,
    privateReveal,
    cardMotion,
    handleState,
    handleReveal,
    handleEvent,
    reset,
    clearPrivateReveal: () => setPrivateReveal(undefined),
  };
}
