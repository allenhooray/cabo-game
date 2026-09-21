import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserSessionStore,
  defaultServerUrl,
  resetServerUrl,
  savePlayerName,
  saveServerUrl,
  savedPlayerName,
  savedServerUrl,
  validateServerUrl,
} from "./browser-session.js";
import { CaboClientCore, legalActions, type CaboStateLike, type ListedRoom, type StatePlayer } from "@cabo-game/client-core";
import type { ClientCommand, PrivateRevealMessage } from "@cabo-game/shared";

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "offline";
type Selection = "idle" | "draw-discard" | "replace" | "peek-other" | "swap";
type CardMotionKind = "draw" | "draw-discard" | "replace" | "discard" | "swap";

interface CardMotion {
  id: number;
  kind: CardMotionKind;
  playerId?: string;
  targetPlayerId?: string;
  position?: number;
}

interface RoundResult {
  type: "round-result";
  hands: Array<{ playerId: string; cards: Array<{ label: string; rank: number }>; handScore: number }>;
  roundScores: Record<string, number>;
  totals: Record<string, number>;
  caboSucceeded: boolean;
}

interface MatchResult {
  type: "match-result";
  winners: string[];
  totals: Record<string, number>;
}

type ResultEvent = RoundResult | MatchResult;

interface Confirmation {
  title: string;
  body: string;
  label: string;
  action(): Promise<void>;
}

const sessionStore = new BrowserSessionStore();

export function App() {
  const [serverUrl, setServerUrl] = useState(savedServerUrl);
  const [serverDraft, setServerDraft] = useState(savedServerUrl);
  const [name, setName] = useState(savedPlayerName);
  const [core, setCore] = useState<CaboClientCore>();
  const [, setRevisionTick] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [rooms, setRooms] = useState<ListedRoom[]>([]);
  const [roomsBusy, setRoomsBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [events, setEvents] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>("idle");
  const [targetId, setTargetId] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [result, setResult] = useState<ResultEvent>();
  const [privateReveal, setPrivateReveal] = useState<PrivateRevealMessage>();
  const [cardMotion, setCardMotion] = useState<CardMotion>();
  const [concealed, setConcealed] = useState(document.visibilityState !== "visible");
  const [readOnly, setReadOnly] = useState(false);
  const reconnectAttempted = useRef(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionId = useRef(0);
  const roomChannel = useRef<BroadcastChannel | undefined>(undefined);

  const state = core?.state;
  const room = core?.room;
  const selfId = room?.sessionId;

  const playerName = useCallback((id: string) => core?.state?.players.get(id)?.name ?? id, [core]);

  const addEvent = useCallback((message: string) => {
    setEvents((current) => [...current.slice(-5), message]);
  }, []);

  const triggerCardMotion = useCallback((motion: Omit<CardMotion, "id">) => {
    if (motionTimer.current) clearTimeout(motionTimer.current);
    const next = { ...motion, id: ++motionId.current };
    setCardMotion(next);
    motionTimer.current = setTimeout(() => setCardMotion((current) => current?.id === next.id ? undefined : current), 720);
  }, []);

  const makeCore = useCallback((nextName: string, nextServer: string) => {
    let instance!: CaboClientCore;
    instance = new CaboClientCore({
      serverUrl: nextServer,
      playerName: nextName,
      sessionStore,
      handlers: {
        attached: () => {
          setConnection("live");
          setCore(instance);
          setNotice(undefined);
          setRevisionTick((value) => value + 1);
        },
        state: (nextState) => {
          setConnection("live");
          if (nextState.phase !== "ROUND_RESULT" && nextState.phase !== "MATCH_RESULT") setResult(undefined);
          setSelection("idle");
          setTargetId(undefined);
          setRevisionTick((value) => value + 1);
        },
        reveal: (message) => {
          if (message.reason === "peek") {
            setPrivateReveal(message);
            if (revealTimer.current) clearTimeout(revealTimer.current);
            revealTimer.current = setTimeout(() => setPrivateReveal(undefined), 3_200);
          }
          setRevisionTick((value) => value + 1);
        },
        event: (event: any) => {
          if (event.type === "round-result" || event.type === "match-result") setResult(event as ResultEvent);
          if (event.type === "discard" && event.playerId !== instance.room?.sessionId) {
            triggerCardMotion({ kind: "discard", playerId: event.playerId });
          }
          if (event.type === "swap" && event.playerId !== instance.room?.sessionId) {
            triggerCardMotion({ kind: "swap", playerId: event.playerId, targetPlayerId: event.targetPlayerId, position: event.position });
          }
          const label = formatEvent(event, (id) => instance.state?.players.get(id)?.name ?? id);
          if (label) addEvent(label);
          setRevisionTick((value) => value + 1);
        },
        error: (error) => setNotice(error.message),
        dropped: () => {
          setConnection("offline");
          setNotice("Connection lost. Your seat is reserved for 60 seconds.");
        },
        reconnected: () => {
          setConnection("live");
          setNotice("Connection restored.");
        },
        left: () => {
          setConnection("idle");
          setCore(undefined);
          setSelection("idle");
          setTargetId(undefined);
        },
        persistenceError: () => setNotice("This browser could not save the reconnect session."),
      },
    });
    return instance;
  }, [addEvent, triggerCardMotion]);

  const refreshRooms = useCallback(async () => {
    setRoomsBusy(true);
    setNotice(undefined);
    try {
      const listingCore = new CaboClientCore({ serverUrl, playerName: name.trim() || "Player" });
      setRooms(await listingCore.listRooms());
    } catch (error) {
      setNotice(errorMessage(error));
      setRooms([]);
    } finally {
      setRoomsBusy(false);
    }
  }, [name, serverUrl]);

  useEffect(() => {
    void refreshRooms();
  }, [refreshRooms]);

  useEffect(() => {
    if (reconnectAttempted.current) return;
    reconnectAttempted.current = true;
    void sessionStore.load().then(async (saved) => {
      if (!saved || saved.server !== serverUrl) return;
      const savedName = savePlayerName(saved.name);
      setName(savedName);
      const next = makeCore(savedName, serverUrl);
      setCore(next);
      setConnection("reconnecting");
      try {
        await next.reconnect();
      } catch {
        await sessionStore.clear();
        setCore(undefined);
        setConnection("idle");
        setNotice("The saved seat has expired. Join a room to keep playing.");
      }
    });
  }, [makeCore, serverUrl]);

  useEffect(() => {
    const onVisibility = () => setConcealed(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    if (motionTimer.current) clearTimeout(motionTimer.current);
  }, []);

  useEffect(() => {
    if (!room || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(`cabo:${serverUrl}:${room.roomId}`);
    roomChannel.current = channel;
    channel.onmessage = (message) => {
      if (message.data?.type === "presence") setReadOnly(true);
      if (message.data?.type === "query") channel.postMessage({ type: "presence" });
      if (message.data?.type === "takeover") setReadOnly(true);
    };
    channel.postMessage({ type: "query" });
    return () => {
      if (roomChannel.current === channel) roomChannel.current = undefined;
      channel.close();
    };
  }, [room, serverUrl]);

  const beginConnection = useCallback(() => {
    const normalizedName = savePlayerName(name);
    if (!normalizedName) throw new Error("Enter a player name.");
    const next = makeCore(normalizedName, serverUrl);
    setName(normalizedName);
    setCore(next);
    setConnection("connecting");
    return next;
  }, [makeCore, name, serverUrl]);

  const connect = useCallback(async (operation: (next: CaboClientCore) => Promise<void>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await operation(beginConnection());
    } catch (error) {
      setCore(undefined);
      setConnection("idle");
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [beginConnection]);

  const execute = useCallback(async (command: ClientCommand) => {
    if (!core || readOnly) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await core.execute(command);
      if (!response.ok) setNotice(response.error.message);
      else {
        const motion = motionForCommand(command, core.room?.sessionId);
        if (motion) triggerCardMotion(motion);
        setSelection("idle");
        setTargetId(undefined);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [core, readOnly, triggerCardMotion]);

  const leave = useCallback(async () => {
    if (!core) return;
    setBusy(true);
    try {
      await core.leave();
      setEvents([]);
      setResult(undefined);
      setReadOnly(false);
      await refreshRooms();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [core, refreshRooms]);

  const applyServer = (event: FormEvent) => {
    event.preventDefault();
    try {
      const next = saveServerUrl(serverDraft);
      setServerUrl(next);
      setServerDraft(next);
      reconnectAttempted.current = true;
      setNotice("Server updated.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  };

  if (!state || !state.players || !room || !selfId) {
    return (
      <Home
        serverUrl={serverUrl}
        serverDraft={serverDraft}
        name={name}
        rooms={rooms}
        busy={busy}
        roomsBusy={roomsBusy}
        connection={connection}
        notice={notice}
        onName={setName}
        onSaveName={() => setName(savePlayerName(name))}
        onServerDraft={setServerDraft}
        onApplyServer={applyServer}
        onResetServer={() => {
          const next = resetServerUrl();
          setServerUrl(next);
          setServerDraft(next);
          reconnectAttempted.current = true;
          setNotice(`Server reset to ${next}.`);
        }}
        onRefresh={() => void refreshRooms()}
        onCreate={(visibility, targetScore, password) => void connect((next) => next.create(visibility, targetScore, password))}
        onJoin={(roomId, password) => void connect((next) => next.join(roomId, password))}
      />
    );
  }

  const players = [...state.players.values()].sort((a, b) => a.seat - b.seat);
  const self = state.players.get(selfId);
  const activePlayers = players.filter((player) => player.connected && !player.forfeited);

  return (
    <div className={`app-shell ${concealed ? "is-concealed" : ""}`}>
      <header className="topbar">
        <button className="wordmark" type="button" onClick={() => setNotice(`Room ${room.roomId}`)}>CABO</button>
        <div className="room-meta">Room {room.roomId} <span /> Round {state.round || "—"} <span /> Target {state.targetScore}</div>
        <div className="topbar-actions">
          <RulesPopover />
          <div className={`connection connection-${connection}`}><i />{connectionLabel(connection)}</div>
        </div>
      </header>

      {notice && <div className="notice" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button></div>}
      {readOnly && (
        <div className="readonly-banner" role="alert">
          This seat is open in another tab. Actions are paused here.
          <button type="button" onClick={() => {
            roomChannel.current?.postMessage({ type: "takeover" });
            setReadOnly(false);
          }}>Take over here</button>
        </div>
      )}

      {state.phase === "LOBBY" ? (
        <Lobby
          roomId={room.roomId}
          targetScore={state.targetScore}
          players={players}
          selfId={selfId}
          canStart={Boolean(self?.isHost && activePlayers.length >= 2)}
          busy={busy || readOnly}
          onStart={() => void execute({ type: "start" })}
          onLeave={() => setConfirmation({ title: "Leave this room?", body: "Your seat will be released.", label: "Leave room", action: leave })}
        />
      ) : (
        <GameTable
          state={state}
          selfId={selfId}
          players={players}
          core={core}
          busy={busy || readOnly}
          selection={selection}
          targetId={targetId}
          events={events}
          cardMotion={cardMotion}
          onSelection={(next) => { setSelection(next); setTargetId(undefined); }}
          onTarget={setTargetId}
          onExecute={(command) => void execute(command)}
          onConfirm={(next) => setConfirmation(next)}
          onLeave={() => setConfirmation({ title: "Leave the match?", body: "Leaving an active match counts as a forfeit.", label: "Forfeit and leave", action: leave })}
          onConcealStart={() => setConcealed(true)}
          onConcealEnd={() => setConcealed(document.visibilityState !== "visible")}
        />
      )}

      {privateReveal && <PrivateReveal message={privateReveal} onClose={() => setPrivateReveal(undefined)} />}
      {result && <Results result={result} state={state} playerName={playerName} busy={busy} onLeave={leave} />}
      {!result && state.phase === "ROUND_RESULT" && <ScoreFallback state={state} />}
      {!result && state.phase === "MATCH_RESULT" && (
        <Results
          result={{ type: "match-result", winners: [...state.winners], totals: Object.fromEntries(players.map((player) => [player.id, player.score])) }}
          state={state}
          playerName={playerName}
          busy={busy}
          onLeave={leave}
        />
      )}
      {confirmation && (
        <Modal title={confirmation.title} onClose={() => setConfirmation(undefined)}>
          <p>{confirmation.body}</p>
          <div className="modal-actions">
            <button className="button ghost" type="button" onClick={() => setConfirmation(undefined)}>Cancel</button>
            <button className="button primary" type="button" onClick={() => {
              const action = confirmation.action;
              setConfirmation(undefined);
              void action();
            }}>{confirmation.label}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface HomeProps {
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
  onCreate(visibility: "public" | "private", targetScore: number, password?: string): void;
  onJoin(roomId: string, password?: string): void;
}

function Home(props: HomeProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [targetScore, setTargetScore] = useState(100);
  const [createPassword, setCreatePassword] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [nameSaved, setNameSaved] = useState(false);

  return (
    <div className="home-shell">
      <header className="home-header"><span className="wordmark-static">CABO</span><span>Memory, timing, restraint.</span></header>
      <main className="home-main">
        <section className="intro">
          <p className="eyebrow">Online card table</p>
          <h1>Keep the lowest hand.<br />Trust what you remember.</h1>
          <p className="lede">A quiet real-time table for two to four players.</p>
          {props.connection === "reconnecting" && <p className="reconnecting" role="status">Reconnecting to your saved seat…</p>}
        </section>

        <div className="entry-stack">
          <section className="entry-panel" aria-labelledby="player-name-heading">
            <p className="eyebrow">Your identity</p>
            <h2 id="player-name-heading" className="module-heading">Set player name</h2>
            <form onSubmit={(event) => {
              event.preventDefault();
              props.onSaveName();
              setNameSaved(true);
            }}>
              <label className="field-label" htmlFor="player-name">Player name</label>
              <input id="player-name" className="input hero-input" value={props.name} maxLength={20} placeholder="Your name" onChange={(event) => { props.onName(event.target.value); setNameSaved(false); }} />
              <div className="name-actions">
                <button className="button" type="submit" disabled={!props.name.trim()}>Save player name</button>
                {nameSaved && <span className="saved-state" role="status">Saved</span>}
              </div>
            </form>
          </section>

          <section className="entry-panel" aria-labelledby="room-actions-heading">
            <p className="eyebrow">Play Cabo</p>
            <h2 id="room-actions-heading" className="module-heading">Create or join a room</h2>
            <div className="entry-actions">
              <button className="button primary" type="button" onClick={() => { setCreateOpen(true); setJoinOpen(false); }}>Create room</button>
              <button className="button" type="button" onClick={() => { setJoinOpen(true); setCreateOpen(false); }}>Join by code</button>
            </div>
            {props.notice && <p className="form-notice" role="alert">{props.notice}</p>}

            {createOpen && (
              <form className="inline-form" onSubmit={(event) => {
                event.preventDefault();
                props.onCreate(visibility, targetScore, visibility === "private" ? createPassword : undefined);
              }}>
                <div className="segmented" aria-label="Room visibility">
                  <button type="button" aria-pressed={visibility === "public"} onClick={() => setVisibility("public")}>Public</button>
                  <button type="button" aria-pressed={visibility === "private"} onClick={() => setVisibility("private")}>Private</button>
                </div>
                <label className="field-label">Target score<input className="input" type="number" min={20} max={500} value={targetScore} onChange={(event) => setTargetScore(Number(event.target.value))} /></label>
                {visibility === "private" && <label className="field-label">Six-digit password<input className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={createPassword} onChange={(event) => setCreatePassword(event.target.value.replace(/\D/g, ""))} /></label>}
                <button className="button primary" disabled={props.busy || targetScore < 20 || targetScore > 500 || (visibility === "private" && !/^\d{6}$/.test(createPassword))}>Create table</button>
              </form>
            )}

            {joinOpen && (
              <form className="inline-form" onSubmit={(event) => { event.preventDefault(); props.onJoin(roomCode.trim(), joinPassword || undefined); }}>
                <label className="field-label">Room code<input className="input code-input" autoCapitalize="characters" value={roomCode} onChange={(event) => setRoomCode(event.target.value)} /></label>
                <label className="field-label">Password <span>optional</span><input className="input" inputMode="numeric" maxLength={6} value={joinPassword} onChange={(event) => setJoinPassword(event.target.value.replace(/\D/g, ""))} /></label>
                <button className="button primary" disabled={props.busy || !roomCode.trim()}>Join table</button>
              </form>
            )}
          </section>
        </div>

        <section className="rooms-section">
          <div className="section-heading"><div><p className="eyebrow">Open tables</p><h2>Public rooms</h2></div><button className="text-button" type="button" onClick={props.onRefresh} disabled={props.roomsBusy}>{props.roomsBusy ? "Refreshing…" : "Refresh"}</button></div>
          <div className="room-list">
            {props.rooms.length ? props.rooms.map((room) => (
              <article className="room-row" key={room.roomId}>
                <div><strong>{room.roomId}</strong><span>Target {room.targetScore}</span></div>
                <span>{room.playerCount} / {room.maxClients} players</span>
                <button className="button small" type="button" disabled={props.busy || room.playerCount >= room.maxClients} onClick={() => props.onJoin(room.roomId)}>Join</button>
              </article>
            )) : <p className="empty-state">No public rooms are waiting. Create the first one.</p>}
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

function Lobby(props: { roomId: string; targetScore: number; players: StatePlayer[]; selfId: string; canStart: boolean; busy: boolean; onStart(): void; onLeave(): void }) {
  return (
    <main className="lobby-shell">
      <section className="lobby-copy"><p className="eyebrow room-code">Room {props.roomId}</p><h1>The table is almost ready.</h1><p>Share the case-sensitive room code. The host can begin once at least two players are connected.</p></section>
      <section className="lobby-panel">
        <div className="lobby-score"><span>Target score</span><strong>{props.targetScore}</strong></div>
        <div className="seat-list">
          {[0, 1, 2, 3].map((seat) => {
            const player = props.players.find((candidate) => candidate.seat === seat);
            return <div className={`seat ${player ? "seat-filled" : ""}`} key={seat}>{player ? <><Avatar player={player} /><div><strong>{player.name}{player.id === props.selfId ? " · You" : ""}</strong><span>{player.isHost ? "Host" : player.connected ? "Ready" : "Offline"}</span></div></> : <span className="open-seat">Open seat</span>}</div>;
          })}
        </div>
        <div className="lobby-actions"><button className="button ghost" type="button" onClick={props.onLeave}>Leave</button>{props.canStart ? <button className="button primary" type="button" disabled={props.busy} onClick={props.onStart}>Start game</button> : <span>Waiting for {props.players[0]?.isHost ? "players" : "the host"}…</span>}</div>
      </section>
    </main>
  );
}

function RulesPopover() {
  const [open, setOpen] = useState(false);
  const pointerFocus = useRef(false);

  return (
    <div
      className="rules-popover"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onPointerDownCapture={() => { pointerFocus.current = true; }}
      onFocus={() => {
        if (!pointerFocus.current) setOpen(true);
      }}
      onBlur={(event) => {
        pointerFocus.current = false;
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      <button className="rules-trigger" type="button" aria-expanded={open} aria-controls="quick-rules" onClick={() => {
        pointerFocus.current = false;
        setOpen((current) => !current);
      }}>Rules</button>
      <aside id="quick-rules" className="rules-panel" hidden={!open} aria-label="Quick rules">
        <p className="eyebrow">Quick rules</p>
        <ul>
          <li>Keep the lowest total. Draw from the deck, take the discard, or call Cabo.</li>
          <li><strong>7–8</strong> peek at your card; <strong>9–10</strong> peek at another player's card.</li>
          <li><strong>J–Q</strong> blindly swap matching positions with another player.</li>
          <li>After Cabo, everyone else gets one final turn. A successful caller scores zero.</li>
        </ul>
        <a href="/docs/rules/">Read the full rules <span aria-hidden="true">↗</span></a>
      </aside>
    </div>
  );
}

interface GameTableProps {
  state: CaboStateLike;
  selfId: string;
  players: StatePlayer[];
  core: CaboClientCore;
  busy: boolean;
  selection: Selection;
  targetId: string | undefined;
  events: string[];
  cardMotion: CardMotion | undefined;
  onSelection(value: Selection): void;
  onTarget(value: string): void;
  onExecute(command: ClientCommand): void;
  onConfirm(confirmation: Confirmation): void;
  onLeave(): void;
  onConcealStart(): void;
  onConcealEnd(): void;
}

function GameTable(props: GameTableProps) {
  const { state, selfId } = props;
  const self = state.players.get(selfId);
  const opponents = props.players.filter((player) => player.id !== selfId);
  const actions = legalActions(state, selfId);
  const myTurn = state.currentPlayerId === selfId;
  const power = state.discardRank;
  const selectedTarget = props.targetId ? state.players.get(props.targetId) : undefined;
  const phaseCopy = gameStatus(state, selfId);

  const hasAction = (type: ClientCommand["type"]) => actions.some((action) => action.type === type);

  const chooseOwnPosition = (position: 1 | 2 | 3 | 4) => {
    if (props.selection === "draw-discard") props.onExecute({ type: "draw-discard", position });
    else if (props.selection === "replace") props.onExecute({ type: "replace", position });
    else if (state.phase === "POWER_PENDING" && (power === 7 || power === 8)) props.onExecute({ type: "peek-self", position });
  };

  const chooseOpponentPosition = (position: 1 | 2 | 3 | 4) => {
    if (!selectedTarget) return;
    if (props.selection === "peek-other") props.onExecute({ type: "peek-other", targetPlayerId: selectedTarget.id, position });
    if (props.selection === "swap") {
      props.onConfirm({
        title: `Swap with ${selectedTarget.name}?`,
        body: `Your card ${position} and ${selectedTarget.name}'s card ${position} will be swapped without revealing either card.`,
        label: "Blind swap",
        action: async () => props.onExecute({ type: "swap", targetPlayerId: selectedTarget.id, position }),
      });
    }
  };

  return (
    <main className="game-shell">
      <section className="opponents" aria-label="Other players">
        {opponents.map((player) => {
          const targetable = (props.selection === "peek-other" || props.selection === "swap") && !player.forfeited;
          const selected = props.targetId === player.id;
          const playerMotion = props.cardMotion && (props.cardMotion.playerId === player.id || props.cardMotion.targetPlayerId === player.id) ? props.cardMotion : undefined;
          return (
            <article className={`player-card ${state.currentPlayerId === player.id ? "active" : ""} ${selected ? "selected" : ""} ${playerMotion ? `motion-${playerMotion.kind}` : ""}`} key={`${player.id}-${playerMotion?.id ?? 0}`}>
              <button className="player-main" type="button" disabled={!targetable || props.busy} onClick={() => props.onTarget(player.id)}>
                <Avatar player={player} />
                <span className="player-copy"><strong>{player.name}</strong><small>{player.forfeited ? "DNF" : !player.connected ? "Offline · 60s grace" : `${player.score} pts`}</small></span>
                <span className="mini-hand" aria-label={`${player.cardCount} cards`}>{Array.from({ length: player.cardCount }, (_, index) => <i key={index} />)}</span>
              </button>
              {selected && <PositionPicker onChoose={chooseOpponentPosition} disabled={props.busy} label={`Choose ${player.name}'s card`} />}
            </article>
          );
        })}
      </section>

      <section className="table-surface">
        <div className="turn-label"><span>{phaseCopy.eyebrow}</span><strong>{phaseCopy.title}</strong></div>
        <div className="piles">
          <div className="pile-wrap">
            <button className={`playing-card card-back ${props.cardMotion?.kind === "draw" ? "motion-draw" : ""}`} key={`deck-${props.cardMotion?.kind === "draw" ? props.cardMotion.id : 0}`} type="button" disabled={!hasAction("draw-deck") || props.busy} onClick={() => props.onExecute({ type: "draw-deck" })} aria-label={`Draw pile, ${state.deckCount} cards`}><span>{state.deckCount}</span></button>
            <small>Deck</small>
          </div>
          <div className="pile-wrap">
            <button className={`playing-card ${props.cardMotion && ["draw-discard", "replace", "discard"].includes(props.cardMotion.kind) ? "motion-discard" : ""}`} key={`discard-${props.cardMotion && ["draw-discard", "replace", "discard"].includes(props.cardMotion.kind) ? props.cardMotion.id : 0}`} type="button" disabled={!hasAction("draw-discard") || props.busy} onClick={() => props.onSelection("draw-discard")} aria-label={`Discard pile, ${state.discardLabel || "empty"}`}><CardFace label={state.discardLabel || "—"} rank={state.discardRank} /></button>
            <small>Discard</small>
          </div>
          {props.core.knowledge.held && <div className="pile-wrap"><div className="playing-card drawn card-flip-in"><CardFace label={props.core.knowledge.held.label} rank={props.core.knowledge.held.rank} /></div><small>Drawn</small></div>}
        </div>
        {hasAction("cabo") && <button className="cabo-button" type="button" disabled={props.busy} onClick={() => props.onConfirm({ title: "Call Cabo?", body: "Every other active player will receive one final turn.", label: "Call Cabo", action: async () => props.onExecute({ type: "cabo" }) })}>Call Cabo</button>}
        <button className="leave-button" type="button" onClick={props.onLeave}>Leave</button>
      </section>

      <section className="player-dock" aria-label="Your hand and actions">
        <div className="hand-block">
          <div className="hand-heading"><div><strong>{self?.name ?? "Your hand"} · {self?.score ?? 0} pts</strong><span>{props.core.knowledge.slots.filter(Boolean).length} known · {4 - props.core.knowledge.slots.filter(Boolean).length} hidden</span></div><button className="privacy-button" type="button" onPointerDown={props.onConcealStart} onPointerUp={props.onConcealEnd} onPointerCancel={props.onConcealEnd}>Hold to conceal</button></div>
          <div className="own-hand">
            {props.core.knowledge.slots.map((card, index) => {
              const position = (index + 1) as 1 | 2 | 3 | 4;
              const selectable = props.selection === "draw-discard" || props.selection === "replace" || (state.phase === "POWER_PENDING" && myTurn && (power === 7 || power === 8));
              const slotMotion = props.cardMotion?.position === position && (props.cardMotion.kind !== "swap" || props.cardMotion.playerId === selfId || props.cardMotion.targetPlayerId === selfId) ? props.cardMotion : undefined;
              return <button className={`hand-slot ${card ? "known" : ""} ${selectable ? "selectable" : ""} ${slotMotion ? `motion-${slotMotion.kind}` : ""}`} type="button" disabled={!selectable || props.busy} key={`${position}-${slotMotion?.id ?? 0}-${card?.label ?? "hidden"}`} onClick={() => chooseOwnPosition(position)}><small>0{position}</small><span className="card-memory">{card ? formatCardLabel(card.label) : "?"}</span></button>;
            })}
          </div>
        </div>
        <div className="action-zone">
          <ActionPanel {...props} actions={actions} phaseCopy={phaseCopy} />
        </div>
      </section>

      <aside className="event-strip" aria-label="Recent activity"><span>Recent</span><p>{props.events.at(-1) ?? "The table is quiet."}</p></aside>
    </main>
  );
}

function ActionPanel(props: GameTableProps & { actions: ReturnType<typeof legalActions>; phaseCopy: { eyebrow: string; title: string; detail: string } }) {
  const { state, selfId } = props;
  if (state.currentPlayerId !== selfId) return <><p className="action-kicker">Waiting</p><h3>{props.phaseCopy.title}</h3><p>{props.phaseCopy.detail}</p></>;
  if (props.selection === "draw-discard") return <><p className="action-kicker">Take discard</p><h3>Choose a card to replace.</h3><p>The discarded card will enter that position.</p><button className="text-button" type="button" onClick={() => props.onSelection("idle")}>Cancel</button></>;
  if (props.selection === "replace") return <><p className="action-kicker">Keep the drawn card</p><h3>Choose a card to replace.</h3><p>Your old card will move to the discard pile.</p><button className="text-button" type="button" onClick={() => props.onSelection("idle")}>Cancel</button></>;
  if (props.selection === "peek-other" || props.selection === "swap") return <><p className="action-kicker">{props.selection === "swap" ? "Blind swap" : "Private peek"}</p><h3>{props.targetId ? "Choose one of their cards." : "Choose another player."}</h3><p>{props.selection === "swap" ? "Neither card will be revealed." : "Only you will see the selected card."}</p><button className="text-button" type="button" onClick={() => props.onSelection("idle")}>Cancel</button></>;
  if (state.phase === "DRAWN") return <><p className="action-kicker">Card drawn</p><h3>Keep it or let it go.</h3><p>Replace one of your cards, or discard the drawn card to use its power.</p><div className="action-buttons"><button className="button" type="button" disabled={props.busy} onClick={() => props.onSelection("replace")}>Replace a card</button><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "discard" })}>Discard drawn card</button></div></>;
  if (state.phase === "POWER_PENDING") {
    const rank = state.discardRank;
    if (rank === 7 || rank === 8) return <><p className="action-kicker">Memory power</p><h3>Peek at one of your cards.</h3><p>Choose a position, or skip the power.</p><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip power</button></>;
    if (rank === 9 || rank === 10) return <><p className="action-kicker">Insight power</p><h3>Peek at another player's card.</h3><div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("peek-other")}>Choose player</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip</button></div></>;
    if (rank === 11 || rank === 12) return <><p className="action-kicker">Exchange power</p><h3>Blind-swap matching positions.</h3><div className="action-buttons"><button className="button primary" type="button" disabled={props.busy} onClick={() => props.onSelection("swap")}>Choose player</button><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Skip</button></div></>;
    return <><p className="action-kicker">No power</p><h3>Continue the table.</h3><button className="button" type="button" disabled={props.busy} onClick={() => props.onExecute({ type: "skip" })}>Continue</button></>;
  }
  return <><p className="action-kicker">Your turn</p><h3>Draw with intention.</h3><p>Take a hidden card from the deck, choose the discard, or call Cabo.</p></>;
}

function PositionPicker(props: { onChoose(position: 1 | 2 | 3 | 4): void; disabled: boolean; label: string }) {
  return <div className="position-picker" aria-label={props.label}>{([1, 2, 3, 4] as const).map((position) => <button type="button" disabled={props.disabled} key={position} onClick={() => props.onChoose(position)}>0{position}</button>)}</div>;
}

function Results(props: { result: ResultEvent; state: CaboStateLike; playerName(id: string): string; busy: boolean; onLeave(): Promise<void> }) {
  const [seconds, setSeconds] = useState(5);

  useEffect(() => {
    if (props.result.type !== "round-result") return;
    const started = Date.now();
    setSeconds(5);
    const timer = setInterval(() => {
      setSeconds(Math.max(0, 5 - Math.floor((Date.now() - started) / 1_000)));
    }, 250);
    return () => clearInterval(timer);
  }, [props.result]);

  if (props.result.type === "match-result") {
    const ranking = Object.entries(props.result.totals).sort(([, a], [, b]) => a - b);
    return <Modal title="Match complete"><p className="result-lede">{props.result.winners.map(props.playerName).join(" & ")} {props.result.winners.length > 1 ? "share" : "takes"} the table.</p><div className="score-list">{ranking.map(([id, score], index) => <div key={id}><span>0{index + 1} · {props.playerName(id)}</span><strong>{score} pts</strong></div>)}</div><div className="modal-actions"><button className="button primary" type="button" disabled={props.busy} onClick={() => void props.onLeave()}>{props.busy ? "Leaving…" : "Back to rooms"}</button></div></Modal>;
  }
  const round = props.result;
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">Cabo {round.caboSucceeded ? "succeeded." : "was challenged."} Next round in {seconds}s.</p><div className="result-hands">{round.hands.map((hand) => <div key={hand.playerId}><div><strong>{props.playerName(hand.playerId)}</strong><span>+{round.roundScores[hand.playerId] ?? 0} · {round.totals[hand.playerId] ?? 0} total</span></div><div className="result-cards">{hand.cards.map((card, index) => <span key={`${card.label}-${index}`}>{formatCardLabel(card.label)}</span>)}</div></div>)}</div></Modal>;
}

function ScoreFallback(props: { state: CaboStateLike }) {
  const players = [...props.state.players.values()].sort((a, b) => a.score - b.score);
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">The private result arrived before this page reconnected. Current totals are shown while the next round begins.</p><div className="score-list">{players.map((player) => <div key={player.id}><span>{player.name}</span><strong>{player.score} pts</strong></div>)}</div></Modal>;
}

function PrivateReveal(props: { message: PrivateRevealMessage; onClose(): void }) {
  return <div className="reveal-layer" role="dialog" aria-modal="true" aria-label="Private card reveal" onClick={props.onClose}><div className="reveal-card"><p>For your eyes only</p><div className="reveal-flip"><div className="reveal-flip-inner"><div className="reveal-face reveal-back" aria-hidden="true"><span>C</span></div><div className="reveal-face reveal-front"><strong>{formatCardLabel(props.message.card.label)}</strong><span>{props.message.card.rank} points</span></div></div></div><small>Closing automatically</small></div></div>;
}

function Modal(props: { title: string; children: ReactNode; onClose?(): void }) {
  return <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="modal-title"><section className="modal-card"><div className="modal-heading"><p className="eyebrow">Cabo table</p>{props.onClose && <button type="button" aria-label="Close" onClick={props.onClose}>×</button>}</div><h2 id="modal-title">{props.title}</h2>{props.children}</section></div>;
}

function Avatar({ player }: { player: StatePlayer }) {
  const initials = player.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar" aria-hidden="true">{initials || "?"}</span>;
}

function CardFace(props: { label: string; rank: number }) {
  const match = props.label.match(/^(.*?)([SHDC♣♦♥♠])$/);
  const suit = match?.[2] ? suitGlyph(match[2]) : "";
  const rank = match?.[1] ?? props.label;
  return <><span className="card-rank">{rank}</span><span className="card-suit">{suit}</span><span className="card-points">{props.rank >= 0 ? `${props.rank} pts` : ""}</span></>;
}

function formatCardLabel(label: string): string {
  const match = label.match(/^(.*?)([SHDC])$/);
  return match?.[1] && match[2] ? `${match[1]}${suitGlyph(match[2])}` : label;
}

function suitGlyph(suit: string): string {
  return ({ S: "♠", H: "♥", D: "♦", C: "♣" } as Record<string, string>)[suit] ?? suit;
}

function gameStatus(state: CaboStateLike, selfId: string) {
  const current = state.players.get(state.currentPlayerId)?.name ?? "The table";
  if (state.phase === "ROUND_RESULT") return { eyebrow: "Round complete", title: "Count the cards.", detail: "The next round begins shortly." };
  if (state.phase === "MATCH_RESULT") return { eyebrow: "Match complete", title: "The table has spoken.", detail: "Review the final scores." };
  if (state.currentPlayerId !== selfId) return { eyebrow: state.phase === "FINAL_TURNS" ? "Final turns" : "In play", title: `${current}'s turn`, detail: "Watch the table and remember what changes." };
  if (state.phase === "DRAWN") return { eyebrow: "Your turn · card drawn", title: "Make the exchange.", detail: "Replace a card or discard the draw." };
  if (state.phase === "POWER_PENDING") return { eyebrow: "Your turn · power", title: "Use what you revealed.", detail: "Resolve the card power or skip it." };
  return { eyebrow: state.phase === "FINAL_TURNS" ? "Your final turn" : "Your turn", title: "Choose where to draw.", detail: "The deck hides possibility; the discard offers certainty." };
}

function formatEvent(event: any, name: (id: string) => string): string | undefined {
  switch (event?.type) {
    case "joined": return `${event.name} joined the table.`;
    case "disconnected": return `${name(event.playerId)} went offline.`;
    case "reconnected": return `${name(event.playerId)} reconnected.`;
    case "turn": return `${name(event.playerId)} is playing${event.finalTurn ? " their final turn" : ""}.`;
    case "discard": return `${name(event.playerId)} discarded ${event.card.label}.`;
    case "swap": return `${name(event.playerId)} made a blind swap with ${name(event.targetPlayerId)}.`;
    case "cabo": return `${name(event.playerId)} called Cabo.`;
    case "forfeit": return `${name(event.playerId)} forfeited.`;
    default: return undefined;
  }
}

function connectionLabel(state: ConnectionState): string {
  if (state === "live") return "Live";
  if (state === "connecting") return "Connecting";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "offline") return "Offline";
  return "Ready";
}

function motionForCommand(command: ClientCommand, selfId: string | undefined): Omit<CardMotion, "id"> | undefined {
  const player = selfId ? { playerId: selfId } : {};
  if (command.type === "draw-deck") return { kind: "draw", ...player };
  if (command.type === "draw-discard") return { kind: "draw-discard", ...player, position: command.position };
  if (command.type === "replace") return { kind: "replace", ...player, position: command.position };
  if (command.type === "discard") return { kind: "discard", ...player };
  if (command.type === "swap") return { kind: "swap", ...player, targetPlayerId: command.targetPlayerId, position: command.position };
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const __test = { validateServerUrl, motionForCommand, Results, RulesPopover, GameTable };
