import type { CaboStateLike } from "@cabo-game/client-core";
import { useTranslation } from "react-i18next";
import { formatCardLabel, Modal } from "../../components/TablePrimitives.js";
import type { ResultEvent } from "../game/types.js";
import { PlayerScoreRow, ScoreList } from "../../components/ScoreList.js";

export function Results(props: { result: ResultEvent; state: CaboStateLike; selfId?: string; playerName(id: string): string; busy: boolean; remainingSeconds?: number | undefined; onReady?(): void; onLeave(): Promise<void> }) {
  const { t } = useTranslation();
  if (props.result.type === "match-result") {
    const ranking = Object.entries(props.result.totals).sort(([, a], [, b]) => a - b);
    const names = props.result.winners.map(props.playerName).join(" & ");
    return <Modal title={t("result.matchComplete")}><p className="result-lede">{t("result.winners", { names, verb: props.result.winners.length > 1 ? t("result.share") : t("result.takes") })}</p><ScoreList>{ranking.map(([id, score], index) => <PlayerScoreRow key={id} label={`0${index + 1} · ${props.playerName(id)}`} score={t("common.points", { count: score })} />)}</ScoreList><div className="modal-actions"><button className="button primary" type="button" disabled={props.busy} onClick={() => void props.onLeave()}>{props.busy ? t("result.leaving") : t("result.back")}</button></div></Modal>;
  }
  const round = props.result;
  const headline = round.outcome.type === "shooting-the-moon"
    ? t("result.moon", { name: props.playerName(round.outcome.playerId) })
    : t(round.outcome.succeeded ? "result.caboSucceeded" : "result.caboChallenged");
  return <Modal title={t("result.roundComplete", { count: props.state.round })}><p className="result-lede">{headline} {t("result.confirm")}</p><div className="result-hands">{round.hands.map((hand) => <div key={hand.playerId}><div><strong>{props.playerName(hand.playerId)}</strong><span>+{round.roundScores[hand.playerId] ?? 0} · {round.totals[hand.playerId] ?? 0}</span></div><div className="result-cards">{hand.cards.map((card, index) => <span key={`${card.label}-${index}`}>{formatCardLabel(card.label)}</span>)}</div></div>)}</div><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} remainingSeconds={props.remainingSeconds} onReady={props.onReady} /></Modal>;
}

export function ScoreFallback(props: { state: CaboStateLike; selfId: string; busy: boolean; remainingSeconds?: number | undefined; onReady(): void }) {
  const { t } = useTranslation();
  const players = [...props.state.players.values()].sort((a, b) => a.score - b.score);
  return <Modal title={t("result.roundComplete", { count: props.state.round })}><p className="result-lede">{t("result.fallback")}</p><ScoreList>{players.map((player) => <PlayerScoreRow key={player.id} label={player.name} score={t("common.points", { count: player.score })} />)}</ScoreList><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} remainingSeconds={props.remainingSeconds} onReady={props.onReady} /></Modal>;
}

function NextRoundReady(props: { state: CaboStateLike; selfId: string | undefined; busy: boolean; remainingSeconds?: number | undefined; onReady: (() => void) | undefined }) {
  const { t } = useTranslation();
  const active = [...props.state.players.values()].filter((player) => !player.forfeited);
  const ready = active.filter((player) => player.nextRoundReady).length;
  const self = props.selfId ? props.state.players.get(props.selfId) : undefined;
  const confirmed = Boolean(self?.nextRoundReady);
  return <><div className="modal-actions"><span>{t("result.readyCount", { ready, count: active.length })}</span>{self && !self.forfeited && <button className="button primary" type="button" disabled={props.busy || confirmed || !props.onReady} onClick={props.onReady}>{confirmed ? t("result.waitOthers") : props.busy ? t("result.confirming") : t("result.readyNext")}</button>}</div>{props.remainingSeconds !== undefined && <div className="next-round-timer" role="timer">{t("result.nextIn", { count: props.remainingSeconds })}</div>}</>;
}
