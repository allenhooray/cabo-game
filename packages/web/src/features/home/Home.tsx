import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ListedRoom } from "@cabo-game/client-core";
import type { MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { defaultServerUrl } from "../../browser-session.js";
import type { readInvitation } from "../../invitation.js";
import type { ConnectionState } from "../game/types.js";
import { SiteHeader } from "../../components/SiteHeader.js";

interface HomeProps {
  invitation: ReturnType<typeof readInvitation>;
  serverUrl: string;
  serverDraft: string;
  name: string;
  rooms: ListedRoom[];
  busy: boolean;
  roomsBusy: boolean;
  connection: ConnectionState;
  notice: string | undefined;
  onName(value: string): void;
  onSaveName(): void;
  onServerDraft(value: string): void;
  onApplyServer(event: FormEvent): void;
  onResetServer(): void;
  onRefresh(): void;
  onCreate(visibility: "public" | "private", targetScore: number, roomName: string, memoryMode: MemoryMode, turnDurationSeconds: TurnDurationSeconds, password?: string): void;
  onJoin(roomId: string, password?: string, targetServer?: string): void;
}

export function Home(props: HomeProps) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(Boolean(props.invitation));
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("classic");
  const [turnDurationSeconds, setTurnDurationSeconds] = useState<TurnDurationSeconds>(60);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [targetScore, setTargetScore] = useState(100);
  const [roomName, setRoomName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [roomCode, setRoomCode] = useState(props.invitation?.roomId ?? "");
  const [joinPassword, setJoinPassword] = useState("");

  return (
    <div className="home-shell">
      <SiteHeader activePage="play" className="home-header" />
      <main className="home-main">
        <section className="intro">
          <p className="eyebrow">{t("home.kicker")}</p>
          <h1>{t("home.title").split("\n").map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}</h1>
          <p className="lede">{t("home.lede")}</p>
          {props.connection === "reconnecting" && <p className="reconnecting" role="status">{t("home.reconnecting")}</p>}
        </section>

        <div className="entry-stack">
          <section className="entry-panel" aria-labelledby="quick-start-heading">
            <p className="eyebrow">{t("home.playCabo")}</p>
            <h2 id="quick-start-heading" className="module-heading">{t("home.quickStart")}</h2>
            <label className="field-label" htmlFor="player-name">{t("home.playerName")}</label>
            <input
              id="player-name"
              className="input hero-input"
              value={props.name}
              maxLength={20}
              placeholder={t("home.yourName")}
              onChange={(event) => props.onName(event.target.value)}
              onBlur={props.onSaveName}
            />
            <div className="entry-actions">
              <button className={`button ${joinOpen ? "" : "primary"}`} type="button" aria-expanded={createOpen} aria-controls="create-room-form" onClick={() => { setRoomName(`${props.name.trim() || "Player"}'s room`); setCreateOpen(true); setJoinOpen(false); }}>{t("home.createRoom")}</button>
              <button className={`button ${joinOpen ? "primary" : ""}`} type="button" aria-expanded={joinOpen} aria-controls="join-room-form" onClick={() => { setJoinOpen(true); setCreateOpen(false); }}>{t("home.joinByCode")}</button>
            </div>
            {props.notice && <p className="form-notice" role="alert">{props.notice}</p>}

            {createOpen && (
              <form id="create-room-form" className="inline-form" onSubmit={(event) => {
                event.preventDefault();
                props.onCreate(visibility, targetScore, roomName, memoryMode, turnDurationSeconds, visibility === "private" ? createPassword : undefined);
              }}>
                <div className="segmented" aria-label={t("home.roomVisibility")}>
                  <button type="button" aria-pressed={visibility === "public"} onClick={() => setVisibility("public")}>{t("home.public")}</button>
                  <button type="button" aria-pressed={visibility === "private"} onClick={() => setVisibility("private")}>{t("home.private")}</button>
                </div>
                <div className="create-fields create-fields-primary">
                  <label className="field-label" htmlFor="create-room-name">{t("home.roomName")} <span>{t("home.roomNameHint")}</span><input id="create-room-name" className="input" value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
                  <label className="field-label">{t("home.targetScore")}<input className="input" type="number" min={20} max={500} value={targetScore} onChange={(event) => setTargetScore(Number(event.target.value))} /></label>
                </div>
                <div className="create-fields">
                  <label className="field-label">{t("home.memoryMode")}<select className="input" value={memoryMode} onChange={(event) => setMemoryMode(event.target.value as MemoryMode)}><option value="classic">{t("home.classic")}</option><option value="assisted">{t("home.assisted")}</option></select></label>
                  <label className="field-label">{t("home.stepTimer")}<select className="input" value={turnDurationSeconds} onChange={(event) => setTurnDurationSeconds(Number(event.target.value) as TurnDurationSeconds)}>{[0, 30, 60, 90].map((seconds) => <option key={seconds} value={seconds}>{seconds ? t("common.seconds", { count: seconds }) : t("home.unlimited")}</option>)}</select></label>
                </div>
                {visibility === "private" && <label className="field-label">{t("home.passwordSix")}<input className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={createPassword} onChange={(event) => setCreatePassword(event.target.value.replace(/\D/g, ""))} /></label>}
                <button className="button primary" disabled={props.busy || Array.from(roomName.trim()).length > 40 || targetScore < 20 || targetScore > 500 || (visibility === "private" && !/^\d{6}$/.test(createPassword))}>{t("home.createTable")}</button>
              </form>
            )}

            {joinOpen && (
              <form id="join-room-form" className="inline-form" onSubmit={(event) => { event.preventDefault(); if (!props.invitation?.error) props.onJoin(roomCode.trim(), joinPassword || undefined, props.invitation?.server); }}>
                {props.invitation && <p role={props.invitation.error ? "alert" : undefined}>{t("home.invitationServer")} <strong>{props.invitation.server}</strong>{props.invitation.error ? ` — ${props.invitation.error}` : ` — ${t("home.invitationConfirm")}`}</p>}
                <label className="field-label">{t("home.roomCode")}<input className="input code-input" autoCapitalize="none" value={roomCode} onChange={(event) => setRoomCode(event.target.value)} /></label>
                <label className="field-label">{t("home.password")} <span>{t("home.optional")}</span><input className="input" inputMode="numeric" maxLength={6} value={joinPassword} onChange={(event) => setJoinPassword(event.target.value.replace(/\D/g, ""))} /></label>
                <button className="button primary" disabled={props.busy || !roomCode.trim() || Boolean(props.invitation?.error)}>{t("home.joinTable")}</button>
              </form>
            )}
          </section>
        </div>

        <section className="rooms-section">
          <div className="section-heading"><div><p className="eyebrow">{t("home.openTables")}</p><h2>{t("home.publicRooms")}</h2></div><button className="text-button" type="button" onClick={props.onRefresh} disabled={props.roomsBusy}>{props.roomsBusy ? t("home.refreshing") : t("home.refresh")}</button></div>
          <div className="room-list">
            {props.rooms.length ? props.rooms.map((room) => (
              <article className="room-row" key={room.roomId}>
                <div><strong>{room.roomName}</strong><span>{t("home.roomSummary", { id: room.roomId, score: room.targetScore, mode: room.memoryMode === "classic" ? t("home.classic") : t("home.assisted"), timer: room.turnDurationSeconds ? t("common.seconds", { count: room.turnDurationSeconds }) : t("home.unlimited") })}</span></div>
                <span>{t("home.roomState", { capacity: room.isFull ? t("home.full") : t("home.open"), state: room.isStarted ? t("home.started") : t("home.waiting"), count: room.playerCount, max: room.maxClients })}</span>
                <button className="button small" type="button" disabled={props.busy || !room.canJoin} onClick={() => props.onJoin(room.roomId)}>{t("home.join")}</button>
              </article>
            )) : <p className="empty-state">{t("home.noRooms")}</p>}
          </div>
        </section>

        <details className="server-settings">
          <summary>{t("home.serverSettings")} <span>{props.serverUrl}</span></summary>
          <form onSubmit={props.onApplyServer}>
            <label className="field-label" htmlFor="server-url">{t("home.gameServer")}</label>
            <input id="server-url" className="input" type="url" value={props.serverDraft} onChange={(event) => props.onServerDraft(event.target.value)} />
            <div className="entry-actions"><button className="button" type="submit">{t("home.apply")}</button><button className="text-button" type="button" onClick={props.onResetServer}>{t("home.resetTo", { url: defaultServerUrl() })}</button></div>
          </form>
        </details>
      </main>
    </div>
  );
}
