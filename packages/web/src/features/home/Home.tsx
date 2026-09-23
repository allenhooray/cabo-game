import { useState, type FormEvent } from "react";
import type { ListedRoom } from "@cabo-game/client-core";
import type { MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { defaultServerUrl } from "../../browser-session.js";
import type { readInvitation } from "../../invitation.js";
import type { ConnectionState } from "../game/types.js";

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
      <header className="home-header"><span className="wordmark-static">CABO</span><span>Memory, timing, restraint.</span></header>
      <main className="home-main">
        <section className="intro">
          <p className="eyebrow">Online card table</p>
          <h1>Keep the lowest hand.<br />Trust what you remember.</h1>
          <p className="lede">A quiet real-time table for two to five players.</p>
          {props.connection === "reconnecting" && <p className="reconnecting" role="status">Reconnecting to your saved seat…</p>}
        </section>

        <div className="entry-stack">
          <section className="entry-panel" aria-labelledby="quick-start-heading">
            <p className="eyebrow">Play Cabo</p>
            <h2 id="quick-start-heading" className="module-heading">Quick start</h2>
            <label className="field-label" htmlFor="player-name">Player name</label>
            <input
              id="player-name"
              className="input hero-input"
              value={props.name}
              maxLength={20}
              placeholder="Your name"
              onChange={(event) => props.onName(event.target.value)}
              onFocus={(event) => {
                const input = event.currentTarget;
                requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
              }}
              onBlur={props.onSaveName}
            />
            <div className="entry-actions">
              <button className={`button ${joinOpen ? "" : "primary"}`} type="button" aria-expanded={createOpen} aria-controls="create-room-form" onClick={() => { setRoomName(`${props.name.trim() || "Player"}'s room`); setCreateOpen(true); setJoinOpen(false); }}>Create room</button>
              <button className={`button ${joinOpen ? "primary" : ""}`} type="button" aria-expanded={joinOpen} aria-controls="join-room-form" onClick={() => { setJoinOpen(true); setCreateOpen(false); }}>Join by code</button>
            </div>
            {props.notice && <p className="form-notice" role="alert">{props.notice}</p>}

            {createOpen && (
              <form id="create-room-form" className="inline-form" onSubmit={(event) => {
                event.preventDefault();
                props.onCreate(visibility, targetScore, roomName, memoryMode, turnDurationSeconds, visibility === "private" ? createPassword : undefined);
              }}>
                <div className="segmented" aria-label="Room visibility">
                  <button type="button" aria-pressed={visibility === "public"} onClick={() => setVisibility("public")}>Public</button>
                  <button type="button" aria-pressed={visibility === "private"} onClick={() => setVisibility("private")}>Private</button>
                </div>
                <div className="create-fields create-fields-primary">
                  <label className="field-label" htmlFor="create-room-name">Room name <span>up to 40 characters</span><input id="create-room-name" className="input" value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
                  <label className="field-label">Target score<input className="input" type="number" min={20} max={500} value={targetScore} onChange={(event) => setTargetScore(Number(event.target.value))} /></label>
                </div>
                <div className="create-fields">
                  <label className="field-label">Memory mode<select className="input" value={memoryMode} onChange={(event) => setMemoryMode(event.target.value as MemoryMode)}><option value="classic">Classic — remember cards yourself</option><option value="assisted">Assisted — keep seen cards visible</option></select></label>
                  <label className="field-label">Step timer<select className="input" value={turnDurationSeconds} onChange={(event) => setTurnDurationSeconds(Number(event.target.value) as TurnDurationSeconds)}>{[0, 30, 60, 90].map((seconds) => <option key={seconds} value={seconds}>{seconds ? `${seconds} seconds` : "Unlimited"}</option>)}</select></label>
                </div>
                {visibility === "private" && <label className="field-label">Six-digit password<input className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={createPassword} onChange={(event) => setCreatePassword(event.target.value.replace(/\D/g, ""))} /></label>}
                <button className="button primary" disabled={props.busy || Array.from(roomName.trim()).length > 40 || targetScore < 20 || targetScore > 500 || (visibility === "private" && !/^\d{6}$/.test(createPassword))}>Create table</button>
              </form>
            )}

            {joinOpen && (
              <form id="join-room-form" className="inline-form" onSubmit={(event) => { event.preventDefault(); if (!props.invitation?.error) props.onJoin(roomCode.trim(), joinPassword || undefined, props.invitation?.server); }}>
                {props.invitation && <p role={props.invitation.error ? "alert" : undefined}>Invitation server: <strong>{props.invitation.server}</strong>{props.invitation.error ? ` — ${props.invitation.error}` : " — Join table to confirm."}</p>}
                <label className="field-label">Room code<input className="input code-input" autoCapitalize="none" value={roomCode} onChange={(event) => setRoomCode(event.target.value)} /></label>
                <label className="field-label">Password <span>optional</span><input className="input" inputMode="numeric" maxLength={6} value={joinPassword} onChange={(event) => setJoinPassword(event.target.value.replace(/\D/g, ""))} /></label>
                <button className="button primary" disabled={props.busy || !roomCode.trim() || Boolean(props.invitation?.error)}>Join table</button>
              </form>
            )}
          </section>
        </div>

        <section className="rooms-section">
          <div className="section-heading"><div><p className="eyebrow">Open tables</p><h2>Public rooms</h2></div><button className="text-button" type="button" onClick={props.onRefresh} disabled={props.roomsBusy}>{props.roomsBusy ? "Refreshing…" : "Refresh"}</button></div>
          <div className="room-list">
            {props.rooms.length ? props.rooms.map((room) => (
              <article className="room-row" key={room.roomId}>
                <div><strong>{room.roomName}</strong><span>Room <span className="room-id">{room.roomId}</span> · Target {room.targetScore} · {room.memoryMode} · {room.turnDurationSeconds ? `${room.turnDurationSeconds}s` : "Unlimited"}</span></div>
                <span>{room.isFull ? "Full" : "Open"} · {room.isStarted ? "Started" : "Waiting"} · {room.playerCount} / {room.maxClients} players</span>
                <button className="button small" type="button" disabled={props.busy || !room.canJoin} onClick={() => props.onJoin(room.roomId)}>Join</button>
              </article>
            )) : <p className="empty-state">No public rooms yet. Create the first one.</p>}
          </div>
        </section>

        <details className="server-settings">
          <summary>Server settings <span>{props.serverUrl}</span></summary>
          <form onSubmit={props.onApplyServer}>
            <label className="field-label" htmlFor="server-url">Game server</label>
            <input id="server-url" className="input" type="url" value={props.serverDraft} onChange={(event) => props.onServerDraft(event.target.value)} />
            <div className="entry-actions"><button className="button" type="submit">Apply</button><button className="text-button" type="button" onClick={props.onResetServer}>Reset to {defaultServerUrl()}</button></div>
          </form>
        </details>
      </main>
      <footer className="home-footer">
        <span>Server-authoritative play · Private cards stay private</span>
        <nav aria-label="Documentation">
          <a href="/docs/rules/">Rules</a>
          <a href="/docs/cli/">CLI</a>
          <a href="/docs/agent/">Agent</a>
        </nav>
      </footer>
    </div>
  );
}
