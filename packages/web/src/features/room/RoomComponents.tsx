import { useEffect, useRef, useState } from "react";
import type { CaboStateLike, StatePlayer } from "@cabo-game/client-core";
import { copyText, invitationLink } from "../../invitation.js";
import { Avatar, formatCardLabel } from "../../components/TablePrimitives.js";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../../i18n/I18nProvider.js";
import { useDisclosure } from "../../components/useDisclosure.js";

export function ShareRoom(props: { roomId: string; server: string }) {
  const { t } = useTranslation();
  const [fallback, setFallback] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copy = async (value: string) => {
    const ok = await copyText(value);
    setCopied(ok); setFallback(ok ? undefined : value);
  };
  return <div className="share-room">
    <button className="share-room-trigger" type="button" aria-haspopup="true">{t("room.share")}</button>
    <div className="share-room-panel">
      <div className="share-room-context">
        <span>{t("home.roomCode")}</span>
        <strong className="room-id">{props.roomId}</strong>
      </div>
      <button className="button" type="button" onClick={() => void copy(props.roomId)}>{t("room.copyCode")}</button>
      <button className="button" type="button" onClick={() => void copy(invitationLink(props.roomId, props.server))}>{t("room.copyLink")}</button>
      {copied && <span role="status">{t("room.copied")}</span>}
      {fallback && <label>{t("room.copyManually")}<input aria-label={t("room.copyManually")} readOnly value={fallback} onFocus={(event) => event.target.select()} /></label>}
    </div>
  </div>;
}

export function Lobby(props: { roomId: string; roomName: string; targetScore: number; players: StatePlayer[]; selfId: string; canStart: boolean; busy: boolean; onStart(): void; onLeave(): void }) {
  const { t } = useTranslation();
  return (
    <main className="lobby-shell">
      <section className="lobby-copy"><p className="eyebrow room-name">{props.roomName}</p><p className="room-code">{t("home.roomCode")} <span className="room-id">{props.roomId}</span></p><h1>{t("room.lobbyTitle")}</h1><p>{t("room.lobbyDetail")}</p></section>
      <section className="lobby-panel">
        <div className="lobby-score"><span>{t("home.targetScore")}</span><strong>{props.targetScore}</strong></div>
        <div className="seat-list">
          {[0, 1, 2, 3, 4].map((seat) => {
            const player = props.players.find((candidate) => candidate.seat === seat);
            return <div className={`seat ${player ? "seat-filled" : ""}`} key={seat}>{player ? <><Avatar player={player} /><div><strong>{player.name}{player.id === props.selfId ? ` · ${t("room.you")}` : ""}</strong><span>{player.isHost ? t("room.host") : player.connected ? t("room.ready") : t("room.offline")}</span></div></> : <span className="open-seat">{t("room.openSeat")}</span>}</div>;
          })}
        </div>
        <div className="lobby-actions"><button className="button ghost" type="button" onClick={props.onLeave}>{t("common.leave")}</button>{props.canStart ? <button className="button primary" type="button" disabled={props.busy} onClick={props.onStart}>{t("room.start")}</button> : <span>{props.players[0]?.isHost ? t("room.waitPlayers") : t("room.waitHost")}</span>}</div>
      </section>
    </main>
  );
}

export function RulesPopover() {
  const { t } = useTranslation();
  const { locale } = usePreferences();
  const disclosure = useDisclosure({ hover: true, clickMode: "toggle", closePinnedOnLeave: true });

  return (
    <div
      className="rules-popover"
      ref={disclosure.rootRef}
      {...disclosure.rootProps}
    >
      <button ref={disclosure.triggerRef} className="rules-trigger" type="button" aria-expanded={disclosure.open} aria-controls="quick-rules" {...disclosure.triggerProps}>{t("nav.rules")}</button>
      <aside id="quick-rules" className="rules-panel" hidden={!disclosure.open} aria-label={t("room.quickRules")}>
        <p className="eyebrow">{t("room.quickRules")}</p>
        <ul>
          {[1, 2, 3, 4, 5, 6].map((number) => <li key={number}>{t(`room.rules${number}`)}</li>)}
        </ul>
        <a href={`/${locale}/docs/rules/`} target="_blank" rel="noreferrer">{t("room.fullRules")} <span aria-hidden="true">↗</span></a>
      </aside>
    </div>
  );
}

export function ScoreHistoryPanel(props: { state: CaboStateLike; selfId: string }) {
  const { t } = useTranslation();
  const [revealedCell, setRevealedCell] = useState<string>();
  const matrix = useRef<HTMLDivElement>(null);
  const disclosure = useDisclosure({ hover: true, clickMode: "pin", closePinnedOnLeave: true });
  const history = [...(props.state.roundHistory ?? [])].sort((a, b) => a.round - b.round);
  const players = [...props.state.players.values()].sort((a, b) => a.seat - b.seat);
  const self = props.state.players.get(props.selfId);
  const open = disclosure.open;

  useEffect(() => {
    if (!open || !matrix.current) return;
    const frame = requestAnimationFrame(() => {
      if (matrix.current) matrix.current.scrollLeft = matrix.current.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, history.length]);

  return (
    <div
      ref={disclosure.rootRef}
      className={`score-history ${open ? "is-open" : ""} ${disclosure.pinned ? "is-pinned" : ""}`}
      {...disclosure.rootProps}
    >
      <div className="score-history-shell">
        <button
          className="score-history-trigger"
          type="button"
          aria-expanded={open}
          aria-controls="score-history-matrix"
          ref={disclosure.triggerRef}
          {...disclosure.triggerProps}
        >
          <span>{t("game.scores")}</span>
          <strong>R{props.state.round}</strong>
          <small>{self ? `${self.score} / ${props.state.targetScore}` : `— / ${props.state.targetScore}`}</small>
        </button>
        <div className="score-history-content" aria-hidden={!open}>
          <div className="score-history-heading">
            <div><p className="eyebrow">{t("game.roundArchive")}</p><h2>{t("game.everyPoint")}</h2></div>
            <span>{t("game.completedRounds", { count: history.length })}</span>
          </div>
          {history.length ? (
            <div className="score-matrix-scroll" id="score-history-matrix" ref={matrix}>
              <table className="score-matrix">
                <colgroup><col className="score-matrix-player-column" /><col span={history.length} /></colgroup>
                <thead><tr><th scope="col">{t("game.player")}</th>{history.map((entry) => (
                  <th scope="col" className={entry === history.at(-1) ? "latest" : ""} key={entry.round}>
                    <strong>{t("game.round", { count: entry.round })}</strong>
                    <span>{roundOutcome(entry, props.state)}</span>
                  </th>
                ))}</tr></thead>
                <tbody>{players.map((player) => (
                  <tr key={player.id}>
                    <th scope="row" aria-label={`${player.name}, ${player.forfeited ? "DNF" : `${player.score} points now`}`}><div className="score-matrix-player"><Avatar player={player} /><span className="score-player-copy"><strong>{player.name}</strong><small>{player.forfeited ? "DNF" : `${player.score} pts now`}</small></span></div></th>
                    {history.map((entry) => {
                      const result = [...entry.players].find((candidate) => candidate.playerId === player.id);
                      const key = `${entry.round}:${player.id}`;
                      if (!result) return <td className="score-cell-empty" key={key}><span>—</span><small>DNF</small></td>;
                      return (
                        <td className={entry === history.at(-1) ? "latest" : ""} key={key}>
                          <button
                            className={`score-cell ${revealedCell === key ? "is-revealed" : ""}`}
                            type="button"
                            tabIndex={open ? 0 : -1}
                            aria-label={`${player.name}, round ${entry.round}: plus ${result.roundScore}, ${result.totalScore} total, hand score ${result.handScore}`}
                            onClick={() => setRevealedCell((current) => current === key ? undefined : key)}
                          >
                            <span className="score-numbers"><strong>+{result.roundScore}</strong><small>→ {result.totalScore} total</small></span>
                            <span className="score-mini-cards" aria-hidden="true">{[...result.cards].map((card, index) => <i key={`${card.label}-${index}`}>{formatCardLabel(card.label)}</i>)}</span>
                            <span className="score-hand-total">Hand {result.handScore}</span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="score-history-empty" id="score-history-matrix">{t("game.noHistory")}</p>}
        </div>
      </div>
    </div>
  );
}

function roundOutcome(entry: NonNullable<CaboStateLike["roundHistory"]>[number], state: CaboStateLike): string {
  const name = state.players.get(entry.outcomePlayerId)?.name ?? entry.outcomePlayerId;
  if (entry.outcomeType === "shooting-the-moon") return `${name} · Moon`;
  return entry.caboSucceeded ? `${name} · Cabo ✓` : `${name} · Cabo ×`;
}
