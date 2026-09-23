import { useEffect, useState } from "react";
import { CaboClientCore, caboRisk, legalActions, type CaboStateLike, type StatePlayer } from "@cabo-game/client-core";
import type { ClientCommand, KnownCard } from "@cabo-game/shared";
import { Avatar, CardFace, formatCardLabel } from "../../components/TablePrimitives.js";
import { ActionPrompt } from "../../components/ActionPrompt.js";
import { CountdownLabel } from "../../components/CountdownLabel.js";
import { MotionLayer } from "./MotionLayer.js";
import type { CardMotion, ClientEvent, Confirmation, Selection, TemporaryCard } from "./types.js";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatEvent } from "./events.js";

export interface GameTableProps {
  temporaryCards?: TemporaryCard[];
  state: CaboStateLike;
  selfId: string;
  players: StatePlayer[];
  core: Pick<CaboClientCore, "knowledge">;
  busy: boolean;
  selection: Selection;
  targetId: string | undefined;
  events: ClientEvent[];
  cardMotion: CardMotion | undefined;
  remainingSeconds?: number | undefined;
  onSelection(value: Selection): void;
  onTarget(value: string): void;
  onExecute(command: ClientCommand): void;
  onConfirm(confirmation: Confirmation): void;
  onLeave(): void;
}

export function GameTable(props: GameTableProps) {
  const { t } = useTranslation();
  const { state, selfId } = props;
  const self = state.players.get(selfId);
  const opponents = props.players.filter((player) => player.id !== selfId);
  const actions = legalActions(state, selfId);
  const myTurn = state.currentPlayerId === selfId;
  const power = state.discardRank;
  const selectedTarget = props.targetId ? state.players.get(props.targetId) : undefined;
  const phaseCopy = gameStatus(state, selfId, t);
  const [exchangePositions, setExchangePositions] = useState<number[]>([]);
  const [replacementPosition, setReplacementPosition] = useState<number>();
  const [swapOwnPosition, setSwapOwnPosition] = useState<number>();
  const [mismatchDrawnPlacement, setMismatchDrawnPlacement] = useState<"left" | "right">();

  const hasAction = (type: ClientCommand["type"]) => actions.some((action) => action.type === type);
  const canReplace = myTurn && hasAction("replace");
  const name = (id: string) => state.players.get(id)?.name ?? id;

  useEffect(() => {
    setExchangePositions([]);
    setReplacementPosition(undefined);
    setSwapOwnPosition(undefined);
    if (state.phase !== "MISMATCH_PENDING") setMismatchDrawnPlacement(undefined);
  }, [canReplace, state.phase, state.round, state.revision]);

  useEffect(() => {
    if (exchangePositions.length === 1) setReplacementPosition(exchangePositions[0]);
    else if (replacementPosition !== undefined && !exchangePositions.includes(replacementPosition)) setReplacementPosition(undefined);
  }, [exchangePositions, replacementPosition]);

  const displayedCard = (ownerId: string, position: number, known: KnownCard | null | undefined) => {
    if (state.memoryMode === "assisted") return known;
    return props.temporaryCards?.find((entry) => entry.ownerId === ownerId && entry.position === position && entry.round === state.round && entry.expiresAt > Date.now())?.card;
  };

  const chooseOwnPosition = (position: number) => {
    if (props.selection === "swap") { setSwapOwnPosition(position); return; }
    if (canReplace) {
      setExchangePositions((current) => {
        if (current.includes(position)) return current.filter((candidate) => candidate !== position);
        if (current.length >= 4) return current;
        if (current.length === 1) setReplacementPosition(undefined);
        return [...current, position];
      });
    } else if (state.phase === "POWER_PENDING" && (power === 7 || power === 8)) {
      props.onExecute({ type: "peek-self", position });
    }
  };

  const chooseOpponentPosition = (position: number) => {
    if (!selectedTarget) return;
    if (props.selection === "peek-other") props.onExecute({ type: "peek-other", targetPlayerId: selectedTarget.id, position });
    if (props.selection === "swap") {
      if (!swapOwnPosition) return;
      props.onConfirm({
        revision: state.revision,
        title: t("game.swapTitle", { name: selectedTarget.name }),
        body: t("game.swapBody", { own: swapOwnPosition, name: selectedTarget.name, position }),
        label: t("game.blindSwap"),
        action: async () => props.onExecute({ type: "swap", targetPlayerId: selectedTarget.id, ownPosition: swapOwnPosition, targetPosition: position }),
      });
    }
  };

  return (
    <main className="game-shell">
      <section className="opponents" aria-label={t("game.otherPlayers")}>
        {opponents.map((player) => {
          const targetable = (props.selection === "peek-other" || (props.selection === "swap" && Boolean(swapOwnPosition))) && !player.forfeited;
          const selected = props.targetId === player.id;
          const playerMotion = props.cardMotion && (props.cardMotion.playerId === player.id || ("targetPlayerId" in props.cardMotion && props.cardMotion.targetPlayerId === player.id)) ? props.cardMotion : undefined;
          const known = props.core.knowledge.opponents.find((entry) => entry.playerId === player.id)?.slots ?? [null, null, null, null];
          return (
            <article className={`player-card ${state.currentPlayerId === player.id ? "active" : ""} ${selected ? "selected" : ""} ${playerMotion ? `motion-${playerMotion.action}` : ""}`} key={player.id}>
              {state.currentPlayerId === player.id && props.remainingSeconds !== undefined && <TurnTimer seconds={props.remainingSeconds} />}
              <button className="player-main" type="button" disabled={!targetable || props.busy} onClick={() => props.onTarget(player.id)}>
                <Avatar player={player} />
                <span className="player-copy"><strong>{player.name}</strong><small>{player.forfeited ? t("game.dnf") : !player.connected ? t("game.offlineGrace") : t("common.points", { count: player.score })}</small></span>
                <span className="opponent-hand" aria-label={t("game.cards", { count: player.cardCount })}>
                  {Array.from({ length: player.cardCount }, (_, index) => {
                    const card = displayedCard(player.id, index + 1, known[index]);
                    return <span className={`opponent-slot ${card ? "known" : ""}`} data-card-anchor={`slot-${player.id}-${index + 1}`} key={index}>{card ? formatCardLabel(card.label) : ""}</span>;
                  })}
                  <span className={`opponent-decision ${state.phase === "DRAWN" && state.currentPlayerId === player.id ? "occupied" : ""}`} data-card-anchor={`decision-${player.id}`} aria-label={t("game.drawnCard")} />
                </span>
              </button>
              {selected && <PositionPicker count={player.cardCount} onChoose={chooseOpponentPosition} disabled={props.busy} label={t("game.chooseCard", { name: player.name })} />}
            </article>
          );
        })}
      </section>

      <section className="table-surface">
        <div className="turn-label"><span>{phaseCopy.eyebrow}</span><strong>{phaseCopy.title}</strong></div>
        <div className="piles">
          <div className="pile-wrap">
            <button className="playing-card card-back" data-card-anchor="deck" type="button" disabled={!hasAction("draw-deck") || props.busy} onClick={() => props.onExecute({ type: "draw-deck" })} aria-label={t("game.drawPile", { count: state.deckCount })}><span>{state.deckCount}</span></button>
            <small>{t("game.deck")}</small>
          </div>
          <div className="pile-wrap">
            <button className="playing-card" data-card-anchor="discard" type="button" disabled={!hasAction("draw-discard") || props.busy} onClick={() => props.onExecute({ type: "draw-discard" })} aria-label={t("game.discardPile", { card: state.discardLabel || t("game.empty") })}><CardFace label={state.discardLabel || "—"} rank={state.discardRank} /></button>
            <small>{t("game.discard")}</small>
          </div>
        </div>
        {hasAction("cabo") && <button className="cabo-button" type="button" disabled={props.busy} onClick={() => { const risk = caboRisk(state, selfId, props.core.knowledge); if (risk) { const summary = risk.knownScore === null ? t("game.risk.cards", { count: risk.unknownCount }) : risk.unknownCount === 0 ? t("game.risk.exact", { score: risk.knownScore }) : t("game.risk.subtotal", { score: risk.knownScore, count: risk.unknownCount }); props.onConfirm({ revision: state.revision, title: `${t("game.callCabo")}?`, body: `${summary} ${t("game.risk.rules", { penalty: risk.failurePenalty })}`, label: t("game.callCabo"), action: async () => props.onExecute({ type: "cabo" }) }); } }}>{t("game.callCabo")}</button>}
        <button className="leave-button" type="button" onClick={props.onLeave}>{t("common.leave")}</button>
      </section>

      <section className="player-dock" aria-label={t("game.yourHandActions")}>
        {myTurn && props.remainingSeconds !== undefined && <TurnTimer seconds={props.remainingSeconds} />}
        <div className="hand-block">
          <div className="hand-heading"><strong>{self?.name ?? t("game.yourHand")} · {t("common.points", { count: self?.score ?? 0 })}</strong><span>{t("game.knownHidden", { known: props.core.knowledge.slots.filter(Boolean).length, hidden: Math.max(0, (self?.cardCount ?? 0) - props.core.knowledge.slots.filter(Boolean).length) })}</span></div>
          <div className={`exchange-controls ${canReplace && exchangePositions.length > 0 ? "" : "is-empty"}`} aria-hidden={canReplace && exchangePositions.length > 0 ? undefined : true}>
            {canReplace && exchangePositions.length > 0 && <><span>{t("game.discardPositions", { positions: exchangePositions.join(", "), destination: replacementPosition ?? t("game.choose") })}</span><div>{exchangePositions.length > 1 && <label>{t("game.drawDestination")}<select aria-label={t("game.drawDestination")} value={replacementPosition ?? ""} onChange={(event) => setReplacementPosition(Number(event.target.value))}><option value="" disabled>{t("game.choosePosition")}</option>{exchangePositions.map((position) => <option key={position} value={position}>{position}</option>)}</select></label>}<button className="button primary" type="button" disabled={props.busy || !replacementPosition} onClick={() => props.onExecute({ type: "replace", positions: exchangePositions, replacementPosition: replacementPosition! })}>{t("game.confirmExchange")}</button><button className="text-button" type="button" onClick={() => setExchangePositions([])}>{t("game.clear")}</button></div></>}
          </div>
          <div className="own-hand">
            {Array.from({ length: self?.cardCount ?? props.core.knowledge.slots.length }, (_, index) => displayedCard(selfId, index + 1, props.core.knowledge.slots[index]) ?? null).map((card, index) => {
              const position = index + 1;
              const selectable = canReplace || (state.phase === "POWER_PENDING" && myTurn && (power === 7 || power === 8 || props.selection === "swap"));
              const motion = props.cardMotion;
              const motionPosition = motion?.action === "swap" ? (motion.playerId === selfId ? motion.ownPosition : motion.targetPlayerId === selfId ? motion.targetPosition : undefined) : motion && "position" in motion ? motion.position : undefined;
              const slotMotion = motionPosition === position ? motion : undefined;
              const selected = props.selection === "swap" ? swapOwnPosition === position : exchangePositions.includes(position);
              return <button aria-pressed={selectable ? selected : undefined} className={`hand-slot ${card ? "known" : ""} ${selectable ? "selectable" : ""} ${selected ? "selected" : ""} ${slotMotion ? `motion-${slotMotion.action}` : ""}`} data-card-anchor={`slot-${selfId}-${position}`} type="button" disabled={!selectable || props.busy} key={`${position}-${card?.label ?? "hidden"}`} onClick={() => chooseOwnPosition(position)}><small>{String(position).padStart(2, "0")}</small><span className="card-memory">{card ? formatCardLabel(card.label) : "?"}</span></button>;
            })}
            <div className={`decision-card ${props.core.knowledge.held ? "occupied" : ""}`} data-card-anchor={`decision-${selfId}`} aria-label={t("game.drawnCard")}>
              {props.core.knowledge.held ? <CardFace label={props.core.knowledge.held.label} rank={props.core.knowledge.held.rank} /> : <span>{t("game.deck")}</span>}
            </div>
          </div>
        </div>
        <div className="action-zone">
          <ActionPanel
            {...props}
            swapOwnPosition={swapOwnPosition}
            actions={actions}
            phaseCopy={phaseCopy}
            mismatchDrawnPlacement={mismatchDrawnPlacement}
            onMismatchDrawnPlacement={setMismatchDrawnPlacement}
          />
        </div>
      </section>

      <aside className="event-strip" aria-label={t("game.recent")}><span>{t("game.recent")}</span><p>{props.events.length ? props.events.slice(-2).map((event) => formatEvent(event, name, t)).filter(Boolean).join(" · ") : t("game.quiet")}</p></aside>
      {props.cardMotion && <MotionLayer motion={props.cardMotion} />}
    </main>
  );
}

function ActionPanel(props: GameTableProps & {
  swapOwnPosition: number | undefined;
  actions: ReturnType<typeof legalActions>;
  phaseCopy: { eyebrow: string; title: string; detail: string };
  mismatchDrawnPlacement: "left" | "right" | undefined;
  onMismatchDrawnPlacement(placement: "left" | "right" | undefined): void;
}) {
  const { t } = useTranslation();
  if (props.state.phase === "FINAL_TURNS" && props.actions.some((action) => action.type === "skip")) return <ActionPrompt title={t("game.noCards")} actions={<button className="button primary" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>{t("game.finishFinal")}</button>} />;
  const { state, selfId } = props;
  if (state.currentPlayerId !== selfId) return <ActionPrompt eyebrow={t("game.waiting")} title={props.phaseCopy.title} detail={props.phaseCopy.detail} />;
  if (props.selection === "swap" && !props.swapOwnPosition) return <ActionPrompt title={t("game.chooseOwnSwap")} detail={t("game.thenChoose")} actions={<button className="text-button" type="button" onClick={() => props.onSelection("idle")}>{t("common.cancel")}</button>} />;
  if (props.selection === "peek-other" || props.selection === "swap") return <ActionPrompt eyebrow={props.selection === "swap" ? t("game.blindSwap") : t("game.privatePeek")} title={props.targetId ? t("game.chooseTheirCard") : t("game.choosePlayer")} detail={props.selection === "swap" ? t("game.neitherRevealed") : t("game.onlyYouSee")} actions={<button className="text-button" type="button" onClick={() => props.onSelection("idle")}>{t("common.cancel")}</button>} />;
  if (state.phase === "DRAWN") return <ActionPrompt eyebrow={t("game.cardDrawn")} title={t("game.chooseReplace")} detail={t("game.selectUpTo")} actions={state.drawSource === "deck" ? <button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "discard" })}>{t("game.discardDrawn")}</button> : undefined} />;
  if (state.phase === "MISMATCH_PENDING") {
    if (!props.mismatchDrawnPlacement) return <ActionPrompt eyebrow={t("game.mismatch")} title={t("game.placeDrawn")} detail={t("game.selectedPublic")} actions={<div className="action-buttons">{(["left", "right"] as const).map((placement) => <button className="button primary" type="button" key={placement} onClick={() => state.mismatchPenaltyCardPending ? props.onMismatchDrawnPlacement(placement) : props.onExecute({ type: "resolve-mismatch", drawnPlacement: placement })}>{t(placement === "left" ? "game.leftEnd" : "game.rightEnd")}</button>)}</div>} />;
    return <ActionPrompt eyebrow={t("game.penaltyCard")} title={t("game.placePenalty")} detail={t("game.drawnGoes", { side: t(props.mismatchDrawnPlacement === "left" ? "game.leftEnd" : "game.rightEnd") })} actions={<><div className="action-buttons">{(["left", "right"] as const).map((placement) => <button className="button primary" type="button" key={placement} onClick={() => props.onExecute({ type: "resolve-mismatch", drawnPlacement: props.mismatchDrawnPlacement as "left" | "right", penaltyPlacement: placement })}>{t(placement === "left" ? "game.leftEnd" : "game.rightEnd")}</button>)}</div><button className="text-button" type="button" onClick={() => props.onMismatchDrawnPlacement(undefined)}>{t("game.back")}</button></>} />;
  }
  if (state.phase === "POWER_PENDING") {
    const rank = state.discardRank;
    if (rank === 7 || rank === 8) return <ActionPrompt eyebrow={t("game.memoryPower")} title={t("game.peekOwn")} detail={t("game.chooseOrSkip")} actions={<button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>{t("game.skipPower")}</button>} />;
    if (rank === 9 || rank === 10) return <ActionPrompt eyebrow={t("game.insightPower")} title={t("game.peekOther")} actions={<div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("peek-other")}>{t("game.choosePlayer")}</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>{t("game.skip")}</button></div>} />;
    if (rank === 11 || rank === 12) return <ActionPrompt eyebrow={t("game.exchangePower")} title={t("game.blindSwapAny")} actions={<div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("swap")}>{t("game.chooseYourCard")}</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>{t("game.skip")}</button></div>} />;
    return <ActionPrompt eyebrow={t("game.noPower")} title={t("game.continueTable")} actions={<button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>{t("game.continue")}</button>} />;
  }
  return <ActionPrompt eyebrow={t("game.yourTurn")} title={t("game.drawIntention")} detail={t("game.takeHidden")} />;
}

function PositionPicker(props: { count: number; onChoose(position: number): void; disabled: boolean; label: string }) {
  return <div className="position-picker" aria-label={props.label}>{Array.from({ length: props.count }, (_, index) => index + 1).map((position) => <button type="button" disabled={props.disabled} key={position} onClick={() => props.onChoose(position)}>{String(position).padStart(2, "0")}</button>)}</div>;
}

function TurnTimer(props: { seconds: number }) {
  const { t } = useTranslation();
  return <CountdownLabel className="turn-timer" variant="compact" seconds={props.seconds} ariaLabel={t("common.secondsRemaining", { count: props.seconds })} />;
}

function gameStatus(state: CaboStateLike, selfId: string, t: TFunction) {
  const current = state.players.get(state.currentPlayerId)?.name ?? t("game.table");
  if (state.phase === "ROUND_RESULT") return { eyebrow: t("game.status.roundComplete"), title: t("game.status.countCards"), detail: t("game.status.nextReady") };
  if (state.phase === "MATCH_RESULT") return { eyebrow: t("game.status.matchComplete"), title: t("game.status.tableSpoken"), detail: t("game.status.reviewScores") };
  if (state.currentPlayerId !== selfId) return { eyebrow: t(state.phase === "FINAL_TURNS" ? "game.status.finalTurns" : "game.status.inPlay"), title: t("game.status.playerTurn", { name: current }), detail: t("game.status.watch") };
  if (state.phase === "DRAWN") return { eyebrow: t("game.status.drawn"), title: t("game.status.exchange"), detail: t("game.status.replace", { discard: state.drawSource === "deck" ? t("game.status.orDiscard") : "" }) };
  if (state.phase === "MISMATCH_PENDING") return { eyebrow: t("game.status.mismatch"), title: t("game.status.placePenalty"), detail: t("game.status.cardsPublic") };
  if (state.phase === "POWER_PENDING") return { eyebrow: t("game.status.power"), title: t("game.status.useRevealed"), detail: t("game.status.resolvePower") };
  return { eyebrow: t(state.phase === "FINAL_TURNS" ? "game.status.finalTurn" : "game.yourTurn"), title: t("game.status.chooseDraw"), detail: t("game.status.drawDetail") };
}
