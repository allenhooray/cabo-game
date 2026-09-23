import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ListedRoom } from "@cabo-game/client-core";
import type { MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { defaultServerUrl } from "../../browser-session.js";
import type { readInvitation } from "../../invitation.js";
import type { ConnectionState } from "../game/types.js";
import { SiteHeader } from "../../components/SiteHeader.js";
import { Button, TextButton, TextInput } from "../../components/FormControls.js";
import { CreateRoomForm, JoinRoomForm } from "./HomeForms.js";
import { InlineNotice } from "../../components/InlineNotice.js";

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
  const defaultRoomName = t("home.defaultRoomName", { name: props.name.trim() || t("home.defaultPlayerName") });
  const previousDefaultRoomName = useRef(defaultRoomName);

  useEffect(() => {
    const previousDefault = previousDefaultRoomName.current;
    if (createOpen) setRoomName((current) => !current || current === previousDefault ? defaultRoomName : current);
    previousDefaultRoomName.current = defaultRoomName;
  }, [createOpen, defaultRoomName]);

  return (
    <div className="home-shell">
      <SiteHeader activePage="play" className="home-header" />
      <main className="home-main">
        <section className="intro">
          <p className="eyebrow">{t("home.kicker")}</p>
          <h1>{t("home.title").split("\n").map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}</h1>
          <p className="lede">{t("home.lede")}</p>
          {props.connection === "reconnecting" && <InlineNotice className="reconnecting" role="status">{t("home.reconnecting")}</InlineNotice>}
        </section>

        <div className="entry-stack">
          <section className="entry-panel" aria-labelledby="quick-start-heading">
            <p className="eyebrow">{t("home.playCabo")}</p>
            <h2 id="quick-start-heading" className="module-heading">{t("home.quickStart")}</h2>
            <label className="field-label" htmlFor="player-name">{t("home.playerName")}</label>
            <TextInput
              id="player-name"
              className="hero-input"
              value={props.name}
              maxLength={20}
              placeholder={t("home.yourName")}
              onChange={(event) => props.onName(event.target.value)}
              onBlur={props.onSaveName}
            />
            <div className="entry-actions">
              <Button variant={joinOpen ? "default" : "primary"} aria-expanded={createOpen} aria-controls="create-room-form" onClick={() => { if (!createOpen) setRoomName(defaultRoomName); setCreateOpen(true); setJoinOpen(false); }}>{t("home.createRoom")}</Button>
              <Button variant={joinOpen ? "primary" : "default"} aria-expanded={joinOpen} aria-controls="join-room-form" onClick={() => { setJoinOpen(true); setCreateOpen(false); }}>{t("home.joinByCode")}</Button>
            </div>
            {props.notice && <InlineNotice className="form-notice" role="alert">{props.notice}</InlineNotice>}

            {createOpen && (
              <CreateRoomForm busy={props.busy} visibility={visibility} targetScore={targetScore} roomName={roomName} memoryMode={memoryMode} turnDurationSeconds={turnDurationSeconds} password={createPassword} onVisibility={setVisibility} onTargetScore={setTargetScore} onRoomName={setRoomName} onMemoryMode={setMemoryMode} onTurnDuration={setTurnDurationSeconds} onPassword={setCreatePassword} onSubmit={() => props.onCreate(visibility, targetScore, roomName, memoryMode, turnDurationSeconds, visibility === "private" ? createPassword : undefined)} />
            )}

            {joinOpen && (
              <JoinRoomForm invitation={props.invitation} busy={props.busy} roomCode={roomCode} password={joinPassword} onRoomCode={setRoomCode} onPassword={setJoinPassword} onSubmit={() => props.onJoin(roomCode.trim(), joinPassword || undefined, props.invitation?.server)} />
            )}
          </section>
        </div>

        <section className="rooms-section">
          <div className="section-heading"><div><p className="eyebrow">{t("home.openTables")}</p><h2>{t("home.publicRooms")}</h2></div><TextButton onClick={props.onRefresh} disabled={props.roomsBusy}>{props.roomsBusy ? t("home.refreshing") : t("home.refresh")}</TextButton></div>
          <div className="room-list">
            {props.rooms.length ? props.rooms.map((room) => (
              <article className="room-row" key={room.roomId}>
                <div><strong>{room.roomName}</strong><span>{t("home.roomSummary", { id: room.roomId, score: room.targetScore, mode: room.memoryMode === "classic" ? t("home.classic") : t("home.assisted"), timer: room.turnDurationSeconds ? t("common.seconds", { count: room.turnDurationSeconds }) : t("home.unlimited") })}</span></div>
                <span>{t("home.roomState", { capacity: room.isFull ? t("home.full") : t("home.open"), state: room.isStarted ? t("home.started") : t("home.waiting"), count: room.playerCount, max: room.maxClients })}</span>
                <Button size="small" disabled={props.busy || !room.canJoin} onClick={() => props.onJoin(room.roomId)}>{t("home.join")}</Button>
              </article>
            )) : <p className="empty-state">{t("home.noRooms")}</p>}
          </div>
        </section>

        <details className="server-settings">
          <summary>{t("home.serverSettings")} <span>{props.serverUrl}</span></summary>
          <form onSubmit={props.onApplyServer}>
            <label className="field-label" htmlFor="server-url">{t("home.gameServer")}</label>
            <TextInput id="server-url" type="url" value={props.serverDraft} onChange={(event) => props.onServerDraft(event.target.value)} />
            <div className="entry-actions"><Button type="submit">{t("home.apply")}</Button><TextButton onClick={props.onResetServer}>{t("home.resetTo", { url: defaultServerUrl() })}</TextButton></div>
          </form>
        </details>
      </main>
    </div>
  );
}
