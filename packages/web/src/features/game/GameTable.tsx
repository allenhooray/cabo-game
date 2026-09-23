import { useEffect, useState } from "react";
import { CaboClientCore, caboRisk, formatCaboRisk, legalActions, type CaboStateLike, type StatePlayer } from "@cabo-game/client-core";
import type { ClientCommand, KnownCard } from "@cabo-game/shared";
import { Avatar, CardFace, formatCardLabel } from "../../components/TablePrimitives.js";
import { MotionLayer } from "./MotionLayer.js";
import type { CardMotion, Confirmation, Selection, TemporaryCard } from "./types.js";

export interface GameTableProps {
  temporaryCards?: TemporaryCard[];
  state: CaboStateLike;
  selfId: string;
  players: StatePlayer[];
  core: Pick<CaboClientCore, "knowledge">;
  busy: boolean;
  selection: Selection;
  targetId: string | undefined;
  events: string[];
  cardMotion: CardMotion | undefined;
  remainingSeconds?: number | undefined;
  onSelection(value: Selection): void;
  onTarget(value: string): void;
  onExecute(command: ClientCommand): void;
  onConfirm(confirmation: Confirmation): void;
  onLeave(): void;
}

export function GameTable(props: GameTableProps) {
  const { state, selfId } = props;
  const self = state.players.get(selfId);
  const opponents = props.players.filter((player) => player.id !== selfId);
  const actions = legalActions(state, selfId);
  const myTurn = state.currentPlayerId === selfId;
  const power = state.discardRank;
  const selectedTarget = props.targetId ? state.players.get(props.targetId) : undefined;
  const phaseCopy = gameStatus(state, selfId);
  const [exchangePositions, setExchangePositions] = useState<number[]>([]);
  const [replacementPosition, setReplacementPosition] = useState<number>();
  const [swapOwnPosition, setSwapOwnPosition] = useState<number>();
  const [mismatchDrawnPlacement, setMismatchDrawnPlacement] = useState<"left" | "right">();

  const hasAction = (type: ClientCommand["type"]) => actions.some((action) => action.type === type);
  const canReplace = myTurn && hasAction("replace");

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
        title: `Swap with ${selectedTarget.name}?`,
        body: `Your card ${swapOwnPosition} and ${selectedTarget.name}'s card ${position} will be swapped without revealing either card.`,
        label: "Blind swap",
        action: async () => props.onExecute({ type: "swap", targetPlayerId: selectedTarget.id, ownPosition: swapOwnPosition, targetPosition: position }),
      });
    }
  };

  return (
    <main className="game-shell">
      <section className="opponents" aria-label="Other players">
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
                <span className="player-copy"><strong>{player.name}</strong><small>{player.forfeited ? "DNF" : !player.connected ? "Offline · 60s grace" : `${player.score} pts`}</small></span>
                <span className="opponent-hand" aria-label={`${player.cardCount} cards`}>
                  {Array.from({ length: player.cardCount }, (_, index) => {
                    const card = displayedCard(player.id, index + 1, known[index]);
                    return <span className={`opponent-slot ${card ? "known" : ""}`} data-card-anchor={`slot-${player.id}-${index + 1}`} key={index}>{card ? formatCardLabel(card.label) : ""}</span>;
                  })}
                  <span className={`opponent-decision ${state.phase === "DRAWN" && state.currentPlayerId === player.id ? "occupied" : ""}`} data-card-anchor={`decision-${player.id}`} aria-label="Drawn card" />
                </span>
              </button>
              {selected && <PositionPicker count={player.cardCount} onChoose={chooseOpponentPosition} disabled={props.busy} label={`Choose ${player.name}'s card`} />}
            </article>
          );
        })}
      </section>

      <section className="table-surface">
        <div className="turn-label"><span>{phaseCopy.eyebrow}</span><strong>{phaseCopy.title}</strong></div>
        <div className="piles">
          <div className="pile-wrap">
            <button className="playing-card card-back" data-card-anchor="deck" type="button" disabled={!hasAction("draw-deck") || props.busy} onClick={() => props.onExecute({ type: "draw-deck" })} aria-label={`Draw pile, ${state.deckCount} cards`}><span>{state.deckCount}</span></button>
            <small>Deck</small>
          </div>
          <div className="pile-wrap">
            <button className="playing-card" data-card-anchor="discard" type="button" disabled={!hasAction("draw-discard") || props.busy} onClick={() => props.onExecute({ type: "draw-discard" })} aria-label={`Discard pile, ${state.discardLabel || "empty"}`}><CardFace label={state.discardLabel || "—"} rank={state.discardRank} /></button>
            <small>Discard</small>
          </div>
        </div>
        {hasAction("cabo") && <button className="cabo-button" type="button" disabled={props.busy} onClick={() => { const risk = caboRisk(state, selfId, props.core.knowledge); if (risk) props.onConfirm({ revision: state.revision, title: "Call Cabo?", body: formatCaboRisk(risk), label: "Call Cabo", action: async () => props.onExecute({ type: "cabo" }) }); }}>Call Cabo</button>}
        <button className="leave-button" type="button" onClick={props.onLeave}>Leave</button>
      </section>

      <section className="player-dock" aria-label="Your hand and actions">
        {myTurn && props.remainingSeconds !== undefined && <TurnTimer seconds={props.remainingSeconds} />}
        <div className="hand-block">
          <div className="hand-heading"><strong>{self?.name ?? "Your hand"} · {self?.score ?? 0} pts</strong><span>{props.core.knowledge.slots.filter(Boolean).length} known · {Math.max(0, (self?.cardCount ?? 0) - props.core.knowledge.slots.filter(Boolean).length)} hidden</span></div>
          <div className={`exchange-controls ${canReplace && exchangePositions.length > 0 ? "" : "is-empty"}`} aria-hidden={canReplace && exchangePositions.length > 0 ? undefined : true}>
            {canReplace && exchangePositions.length > 0 && <><span>Discard positions: {exchangePositions.join(", ")} · Drawn card → {replacementPosition ?? "choose"}</span><div>{exchangePositions.length > 1 && <label>Drawn card destination<select aria-label="Drawn card destination" value={replacementPosition ?? ""} onChange={(event) => setReplacementPosition(Number(event.target.value))}><option value="" disabled>Choose position</option>{exchangePositions.map((position) => <option key={position} value={position}>{position}</option>)}</select></label>}<button className="button primary" type="button" disabled={props.busy || !replacementPosition} onClick={() => props.onExecute({ type: "replace", positions: exchangePositions, replacementPosition: replacementPosition! })}>Confirm exchange</button><button className="text-button" type="button" onClick={() => setExchangePositions([])}>Clear</button></div></>}
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
            <div className={`decision-card ${props.core.knowledge.held ? "occupied" : ""}`} data-card-anchor={`decision-${selfId}`} aria-label="Drawn card">
              {props.core.knowledge.held ? <CardFace label={props.core.knowledge.held.label} rank={props.core.knowledge.held.rank} /> : <span>Draw</span>}
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

      <aside className="event-strip" aria-label="Recent activity"><span>Recent</span><p>{props.events.length ? props.events.slice(-2).join(" · ") : "The table is quiet."}</p></aside>
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
  if (props.state.phase === "FINAL_TURNS" && props.actions.some((action) => action.type === "skip")) return <><h3>No cards left to draw.</h3><button className="button primary" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Finish final turn</button></>;
  const { state, selfId } = props;
  if (state.currentPlayerId !== selfId) return <><p className="action-kicker">Waiting</p><h3>{props.phaseCopy.title}</h3><p>{props.phaseCopy.detail}</p></>;
  if (props.selection === "swap" && !props.swapOwnPosition) return <><h3>Choose your card to swap.</h3><p>Then choose another player and any of their cards.</p><button className="text-button" type="button" onClick={() => props.onSelection("idle")}>Cancel</button></>;
  if (props.selection === "peek-other" || props.selection === "swap") return <><p className="action-kicker">{props.selection === "swap" ? "Blind swap" : "Private peek"}</p><h3>{props.targetId ? "Choose one of their cards." : "Choose another player."}</h3><p>{props.selection === "swap" ? "Neither card will be revealed." : "Only you will see the selected card."}</p><button className="text-button" type="button" onClick={() => props.onSelection("idle")}>Cancel</button></>;
  if (state.phase === "DRAWN") return <><p className="action-kicker">Card drawn</p><h3>Choose what it replaces.</h3><p>Select up to four cards directly from your hand. Multiple cards must share the same rank.</p>{state.drawSource === "deck" && <button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "discard" })}>Discard drawn card</button>}</>;
  if (state.phase === "MISMATCH_PENDING") {
    if (!props.mismatchDrawnPlacement) return <><p className="action-kicker">Cards did not match</p><h3>Place the drawn card.</h3><p>The selected cards are now public.</p><div className="action-buttons">{(["left", "right"] as const).map((placement) => <button className="button primary" type="button" key={placement} onClick={() => state.mismatchPenaltyCardPending ? props.onMismatchDrawnPlacement(placement) : props.onExecute({ type: "resolve-mismatch", drawnPlacement: placement })}>{placement === "left" ? "Left end" : "Right end"}</button>)}</div></>;
    return <><p className="action-kicker">Penalty card</p><h3>Place the facedown penalty.</h3><p>The drawn card will go to the {props.mismatchDrawnPlacement} end.</p><div className="action-buttons">{(["left", "right"] as const).map((placement) => <button className="button primary" type="button" key={placement} onClick={() => props.onExecute({ type: "resolve-mismatch", drawnPlacement: props.mismatchDrawnPlacement as "left" | "right", penaltyPlacement: placement })}>{placement === "left" ? "Left end" : "Right end"}</button>)}</div><button className="text-button" type="button" onClick={() => props.onMismatchDrawnPlacement(undefined)}>Back</button></>;
  }
  if (state.phase === "POWER_PENDING") {
    const rank = state.discardRank;
    if (rank === 7 || rank === 8) return <><p className="action-kicker">Memory power</p><h3>Peek at one of your cards.</h3><p>Choose a position, or skip the power.</p><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip power</button></>;
    if (rank === 9 || rank === 10) return <><p className="action-kicker">Insight power</p><h3>Peek at another player's card.</h3><div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("peek-other")}>Choose player</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip</button></div></>;
    if (rank === 11 || rank === 12) return <><p className="action-kicker">Exchange power</p><h3>Blind-swap any two positions.</h3><div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("swap")}>Choose your card</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip</button></div></>;
    return <><p className="action-kicker">No power</p><h3>Continue the table.</h3><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Continue</button></>;
  }
  return <><p className="action-kicker">Your turn</p><h3>Draw with intention.</h3><p>Take a hidden card from the deck, choose the discard, or call Cabo.</p></>;
}

function PositionPicker(props: { count: number; onChoose(position: number): void; disabled: boolean; label: string }) {
  return <div className="position-picker" aria-label={props.label}>{Array.from({ length: props.count }, (_, index) => index + 1).map((position) => <button type="button" disabled={props.disabled} key={position} onClick={() => props.onChoose(position)}>{String(position).padStart(2, "0")}</button>)}</div>;
}

function TurnTimer(props: { seconds: number }) {
  return <span className="turn-timer" role="timer" aria-label={`${props.seconds} seconds remaining`}>{props.seconds}s</span>;
}

function gameStatus(state: CaboStateLike, selfId: string) {
  const current = state.players.get(state.currentPlayerId)?.name ?? "The table";
  if (state.phase === "ROUND_RESULT") return { eyebrow: "Round complete", title: "Count the cards.", detail: "The next round begins when every active player is ready." };
  if (state.phase === "MATCH_RESULT") return { eyebrow: "Match complete", title: "The table has spoken.", detail: "Review the final scores." };
  if (state.currentPlayerId !== selfId) return { eyebrow: state.phase === "FINAL_TURNS" ? "Final turns" : "In play", title: `${current}'s turn`, detail: "Watch the table and remember what changes." };
  if (state.phase === "DRAWN") return { eyebrow: "Your turn · card drawn", title: "Make the exchange.", detail: `Replace 1–4 cards${state.drawSource === "deck" ? " or discard the draw" : ""}.` };
  if (state.phase === "MISMATCH_PENDING") return { eyebrow: "Your turn · mismatch", title: "Place the penalty.", detail: "The selected cards are public; choose where the new cards go." };
  if (state.phase === "POWER_PENDING") return { eyebrow: "Your turn · power", title: "Use what you revealed.", detail: "Resolve the card power or skip it." };
  return { eyebrow: state.phase === "FINAL_TURNS" ? "Your final turn" : "Your turn", title: "Choose where to draw.", detail: "The deck hides possibility; the discard offers certainty." };
}
