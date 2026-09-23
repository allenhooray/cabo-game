import type { CaboStateLike } from "@cabo-game/client-core";
import { formatCardLabel, Modal } from "../../components/TablePrimitives.js";
import type { ResultEvent } from "../game/types.js";

export function Results(props: { result: ResultEvent; state: CaboStateLike; selfId?: string; playerName(id: string): string; busy: boolean; remainingSeconds?: number | undefined; onReady?(): void; onLeave(): Promise<void> }) {
  if (props.result.type === "match-result") {
    const ranking = Object.entries(props.result.totals).sort(([, a], [, b]) => a - b);
    return <Modal title="Match complete"><p className="result-lede">{props.result.winners.map(props.playerName).join(" & ")} {props.result.winners.length > 1 ? "share" : "takes"} the table.</p><div className="score-list">{ranking.map(([id, score], index) => <div key={id}><span>0{index + 1} · {props.playerName(id)}</span><strong>{score} pts</strong></div>)}</div><div className="modal-actions"><button className="button primary" type="button" disabled={props.busy} onClick={() => void props.onLeave()}>{props.busy ? "Leaving…" : "Back to rooms"}</button></div></Modal>;
  }
  const round = props.result;
  const headline = round.outcome.type === "shooting-the-moon"
    ? `${props.playerName(round.outcome.playerId)} shot the moon.`
    : `Cabo ${round.outcome.succeeded ? "succeeded." : "was challenged."}`;
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">{headline} Confirm when you are ready to continue.</p><div className="result-hands">{round.hands.map((hand) => <div key={hand.playerId}><div><strong>{props.playerName(hand.playerId)}</strong><span>+{round.roundScores[hand.playerId] ?? 0} · {round.totals[hand.playerId] ?? 0} total</span></div><div className="result-cards">{hand.cards.map((card, index) => <span key={`${card.label}-${index}`}>{formatCardLabel(card.label)}</span>)}</div></div>)}</div><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} remainingSeconds={props.remainingSeconds} onReady={props.onReady} /></Modal>;
}

export function ScoreFallback(props: { state: CaboStateLike; selfId: string; busy: boolean; remainingSeconds?: number | undefined; onReady(): void }) {
  const players = [...props.state.players.values()].sort((a, b) => a.score - b.score);
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">The private result arrived before this page reconnected. Current totals are shown while everyone confirms the next round.</p><div className="score-list">{players.map((player) => <div key={player.id}><span>{player.name}</span><strong>{player.score} pts</strong></div>)}</div><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} remainingSeconds={props.remainingSeconds} onReady={props.onReady} /></Modal>;
}

function NextRoundReady(props: { state: CaboStateLike; selfId: string | undefined; busy: boolean; remainingSeconds?: number | undefined; onReady: (() => void) | undefined }) {
  const active = [...props.state.players.values()].filter((player) => !player.forfeited);
  const ready = active.filter((player) => player.nextRoundReady).length;
  const self = props.selfId ? props.state.players.get(props.selfId) : undefined;
  const confirmed = Boolean(self?.nextRoundReady);
  return <><div className="modal-actions"><span>{ready} of {active.length} active players ready</span>{self && !self.forfeited && <button className="button primary" type="button" disabled={props.busy || confirmed || !props.onReady} onClick={props.onReady}>{confirmed ? "Waiting for others…" : props.busy ? "Confirming…" : "Ready for next round"}</button>}</div>{props.remainingSeconds !== undefined && <div className="next-round-timer" role="timer">Next round in {props.remainingSeconds}s</div>}</>;
}
