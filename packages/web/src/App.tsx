import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
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
import { CaboClientCore, legalActions, caboRisk, formatCaboRisk, type CaboStateLike, type ListedRoom, type StatePlayer } from "@cabo-game/client-core";
import type { ClientCommand, KnownCard, PrivateRevealMessage, PublicActionEvent, RoomChatMessage, MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { readInvitation, invitationLink, copyText } from "./invitation.js";

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "offline";
type Selection = "idle" | "replace" | "peek-other" | "swap";
type CardMotion = PublicActionEvent & { id: number };

interface RoundResult {
  type: "round-result";
  hands: Array<{ playerId: string; cards: Array<{ label: string; rank: number }>; handScore: number }>;
  roundScores: Record<string, number>;
  totals: Record<string, number>;
  outcome:
    | { type: "cabo"; callerId: string; succeeded: boolean }
    | { type: "shooting-the-moon"; playerId: string };
}

interface MatchResult {
  type: "match-result";
  winners: string[];
  totals: Record<string, number>;
}

type ResultEvent = RoundResult | MatchResult;

interface Confirmation {
  revision?: number;
  title: string;
  body: string;
  label: string;
  action(): Promise<void>;
}

const sessionStore = new BrowserSessionStore();

export function App() {
  const [invitation, setInvitation] = useState(readInvitation);
  const [temporaryCards, setTemporaryCards] = useState<Array<{ ownerId: string; position: number; card: KnownCard; expiresAt: number; round: number }>>([]);
  const [clockNow, setClockNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => { setClockNow(Date.now()); setTemporaryCards((cards) => cards.filter((card) => card.expiresAt > Date.now())); }, 200);
    return () => clearInterval(timer);
  }, []);
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
  const [motionQueue, setMotionQueue] = useState<CardMotion[]>([]);
  const [concealed, setConcealed] = useState(document.visibilityState !== "visible");
  const [readOnly, setReadOnly] = useState(false);
  const [chatMessages, setChatMessages] = useState<RoomChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatDraft, setChatDraft] = useState("");
  const reconnectAttempted = useRef(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motionId = useRef(0);
  const roomChannel = useRef<BroadcastChannel | undefined>(undefined);
  const chatOpenRef = useRef(false);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);

  const state = core?.state;
  const room = core?.room;
  const selfId = room?.sessionId;

  const playerName = useCallback((id: string) => core?.state?.players.get(id)?.name ?? id, [core]);

  const addEvent = useCallback((message: string) => {
    setEvents((current) => [...current.slice(-5), message]);
  }, []);

  const enqueueCardMotion = useCallback((motion: PublicActionEvent) => {
    setMotionQueue((current) => [...current, { ...motion, id: ++motionId.current }]);
  }, []);

  useEffect(() => {
    if (cardMotion || motionQueue.length === 0) return;
    const next = motionQueue[0];
    if (!next) return;
    setMotionQueue((current) => current.slice(1));
    setCardMotion(next);
    motionTimer.current = setTimeout(() => setCardMotion((current) => current?.id === next.id ? undefined : current), motionDuration(next));
  }, [cardMotion, motionQueue]);

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
          setConfirmation((current) => current?.revision !== undefined && current.revision !== nextState.revision ? undefined : current);
          setTemporaryCards((cards) => cards.filter((card) => card.round === nextState.round));
          setConnection("live");
          if (nextState.phase !== "ROUND_RESULT" && nextState.phase !== "MATCH_RESULT") setResult(undefined);
          setSelection("idle");
          setTargetId(undefined);
          setRevisionTick((value) => value + 1);
        },
        reveal: (message) => {
          if (message.memoryMode === "classic" && message.reason !== "draw" && message.position) {
            setTemporaryCards((cards) => [...cards.filter((entry) => entry.round === message.round && !(entry.ownerId === message.ownerId && entry.position === message.position)), { ownerId: message.ownerId, position: message.position!, card: message.card, round: message.round, expiresAt: Date.now() + (message.reason === "initial" ? 5000 : 3200) }]);
          }
          if (message.reason === "peek") {
            setPrivateReveal(message);
            if (revealTimer.current) clearTimeout(revealTimer.current);
            revealTimer.current = setTimeout(() => setPrivateReveal(undefined), 3_200);
          }
          setRevisionTick((value) => value + 1);
        },
        knowledge: () => setRevisionTick((value) => value + 1),
        event: (event: any) => {
          if (event.type === "action" && event.action === "exchange-mismatch" && instance.state?.memoryMode === "classic") {
            const round = instance.state.round;
            setTemporaryCards((cards) => [...cards.filter((card) => card.ownerId !== event.playerId), ...event.positions.map((position: number, index: number) => ({ ownerId: event.playerId, position, card: event.revealedCards[index], round, expiresAt: Date.now() + 3200 }))]);
          } else if (event.type === "action" && ["replace", "resolve-mismatch", "swap"].includes(event.action)) {
            setTemporaryCards((cards) => cards.filter((card) => card.ownerId !== event.playerId && card.ownerId !== event.targetPlayerId));
          }
          if (event.type === "round-result" || event.type === "match-result") setResult(event as ResultEvent);
          if (event.type === "action") enqueueCardMotion(event as PublicActionEvent);
          const label = formatEvent(event, (id) => instance.state?.players.get(id)?.name ?? id);
          if (label) addEvent(label);
          setRevisionTick((value) => value + 1);
        },
        error: (error) => setNotice(error.message),
        chat: (message) => {
          setChatMessages((current) => [...current, message].slice(-50));
          if (window.innerWidth <= 760 && !chatOpenRef.current) setChatUnread((current) => current + 1);
        },
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
          setChatMessages([]);
          setChatUnread(0);
          setChatOpen(false);
          setChatDraft("");
          chatOpenRef.current = false;
        },
        persistenceError: () => setNotice("This browser could not save the reconnect session."),
      },
    });
    return instance;
  }, [addEvent, enqueueCardMotion]);

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
      if (!saved || saved.server !== serverUrl || invitation) return;
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

  const beginConnection = useCallback((targetServer = serverUrl) => {
    const normalizedName = savePlayerName(name);
    if (!normalizedName) throw new Error("Enter a player name.");
    const next = makeCore(normalizedName, targetServer);
    setChatMessages([]);
    setChatUnread(0);
    setChatDraft("");
    setName(normalizedName);
    setCore(next);
    setConnection("connecting");
    return next;
  }, [makeCore, name, serverUrl]);

  const connect = useCallback(async (operation: (next: CaboClientCore) => Promise<void>, targetServer = serverUrl) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await operation(beginConnection(targetServer));
      setServerUrl(targetServer);
      saveServerUrl(targetServer);
      setServerDraft(targetServer);
      if (invitation) {
        const url = new URL(window.location.href);
        url.searchParams.delete("room"); url.searchParams.delete("server");
        window.history.replaceState(null, "", url);
        setInvitation(undefined);
      }
    } catch (error) {
      setCore(undefined);
      setConnection("idle");
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [beginConnection, serverUrl, invitation]);

  const execute = useCallback(async (command: ClientCommand) => {
    if (!core || readOnly) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await core.execute(command);
      if (!response.ok) setNotice(response.error.message);
      else {
        setSelection("idle");
        setTargetId(undefined);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [core, readOnly]);

  const leave = useCallback(async () => {
    if (!core) return;
    setBusy(true);
    try {
      await core.leave();
      setEvents([]);
      setResult(undefined);
      setReadOnly(false);
      setChatMessages([]);
      setChatUnread(0);
      setChatOpen(false);
      setChatDraft("");
      chatOpenRef.current = false;
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
        invitation={invitation}
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
        onCreate={(visibility, targetScore, roomName, memoryMode, turnDurationSeconds, password) => void connect((next) => next.create({ visibility, targetScore, roomName, memoryMode, turnDurationSeconds, ...(password ? { password } : {}) }))}
        onJoin={(roomId, password, targetServer) => void connect((next) => next.join(roomId, password), targetServer ?? serverUrl)}
      />
    );
  }

  const players = [...state.players.values()].sort((a, b) => a.seat - b.seat);
  const self = state.players.get(selfId);
  const activePlayers = players.filter((player) => player.connected && !player.forfeited);
  const chatEnabled = connection === "live" && !readOnly;
  const openChat = () => {
    chatOpenRef.current = true;
    setChatOpen(true);
    setChatUnread(0);
  };
  const closeChat = () => {
    chatOpenRef.current = false;
    setChatOpen(false);
    requestAnimationFrame(() => chatTriggerRef.current?.focus());
  };

  return (
    <div className={`app-shell ${concealed ? "is-concealed" : ""}`}>
      <header className="topbar" data-state-revision={state.revision}>
        <button className="wordmark" type="button" onClick={() => setNotice(`${state.roomName} · Room ${room.roomId}`)}>CABO</button>
        <div className="room-meta"><strong className="room-title">{state.roomName}</strong> <span /> Room <b className="room-id">{room.roomId}</b> <span /> Round {state.round || "—"} <span /> Target {state.targetScore}</div>
        <div className="topbar-actions">
          <span className="room-settings">{state.memoryMode} · {state.turnDurationSeconds ? `${state.turnDurationSeconds}s` : "Unlimited"}</span>
          <ShareRoom roomId={room.roomId} server={serverUrl} />
          <button ref={chatTriggerRef} className="chat-trigger" type="button" aria-haspopup="dialog" aria-expanded={chatOpen} onClick={openChat}>
            Chat{chatUnread > 0 ? ` (${chatUnread})` : ""}
          </button>
          {state.phase !== "LOBBY" && <ScoreHistoryPanel state={state} />}
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

      <div className="room-layout">
        <main className="room-main">
        {state.phase === "LOBBY" ? (
          <Lobby
          roomId={room.roomId}
          roomName={state.roomName}
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
          temporaryCards={temporaryCards}
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
        </main>
        <aside className="chat-sidebar" aria-label="Room chat">
          <RoomChat messages={chatMessages} selfId={selfId} enabled={chatEnabled} status={chatStatus(connection, readOnly)} draft={chatDraft} onDraft={setChatDraft} onSend={(text) => core.sendChat(text)} />
        </aside>
      </div>

      {chatOpen && (
        <div className="chat-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeChat(); }}>
          <section className="chat-drawer" role="dialog" aria-modal="true" aria-label="Room chat">
            <button className="chat-close" type="button" aria-label="Close chat" onClick={closeChat}>×</button>
            <RoomChat messages={chatMessages} selfId={selfId} enabled={chatEnabled} status={chatStatus(connection, readOnly)} draft={chatDraft} onDraft={setChatDraft} autoFocus onClose={closeChat} onSend={(text) => core.sendChat(text)} />
          </section>
        </div>
      )}

      {privateReveal && <PrivateReveal message={privateReveal} onClose={() => setPrivateReveal(undefined)} />}
      {state.deadlineAt > 0 && <div className="deadline-banner" role="timer">{state.phase === "ROUND_RESULT" ? "Next round" : "Auto action"} in {Math.max(0, Math.ceil((state.deadlineAt - (core.serverNow() + clockNow - Date.now())) / 1000))}s</div>}
      {result && <Results result={result} state={state} selfId={selfId} playerName={playerName} busy={busy || readOnly} onReady={() => void execute({ type: "ready-next-round" })} onLeave={leave} />}
      {!result && state.phase === "ROUND_RESULT" && <ScoreFallback state={state} selfId={selfId} busy={busy || readOnly} onReady={() => void execute({ type: "ready-next-round" })} />}
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
              if (confirmation.revision !== undefined && confirmation.revision !== core.state?.revision) { setConfirmation(undefined); return; }
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

interface RoomChatProps {
  messages: RoomChatMessage[];
  selfId: string;
  enabled: boolean;
  status: string;
  draft: string;
  onDraft(value: string): void;
  autoFocus?: boolean;
  onClose?(): void;
  onSend(text: string): void;
}

function RoomChat({ messages, selfId, enabled, status, draft, onDraft, autoFocus, onClose, onSend }: RoomChatProps) {
  const [validation, setValidation] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onClose) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (stickToBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      setValidation("Enter a message.");
      return;
    }
    if (Array.from(text).length > 200) {
      setValidation("Messages can contain at most 200 characters.");
      return;
    }
    if (!enabled) return;
    onSend(text);
    onDraft("");
    setValidation(undefined);
  };

  const count = Array.from(draft.trim()).length;
  const validationId = autoFocus ? "chat-validation-drawer" : "chat-validation-sidebar";
  return (
    <div className="room-chat">
      <div className="chat-heading"><div><span>Room chat</span><small>Ephemeral · not saved</small></div></div>
      <div
        ref={listRef}
        className="chat-messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {messages.length === 0 && <p className="chat-empty">No messages yet.</p>}
        {messages.map((message) => (
          <article className="chat-message" key={message.sequence}>
            <div><strong>{message.playerId === selfId ? "You" : message.playerName}</strong><time dateTime={new Date(message.sentAt).toISOString()}>{formatChatTime(message.sentAt)}</time></div>
            <p>{message.text}</p>
          </article>
        ))}
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label htmlFor={autoFocus ? "chat-message-drawer" : "chat-message-sidebar"}>Message</label>
        <div>
          <input
            ref={inputRef}
            id={autoFocus ? "chat-message-drawer" : "chat-message-sidebar"}
            value={draft}
            disabled={!enabled}
            autoComplete="off"
            placeholder={enabled ? "Say something…" : status}
            aria-describedby={validation ? validationId : undefined}
            onChange={(event) => {
              onDraft(event.target.value);
              setValidation(Array.from(event.target.value.trim()).length > 200 ? "Messages can contain at most 200 characters." : undefined);
            }}
          />
          <button type="submit" disabled={!enabled || !draft.trim() || count > 200}>Send</button>
        </div>
        <small id={validation ? validationId : undefined} className={validation ? "chat-validation" : "chat-count"}>{validation ?? `${count}/200`}</small>
      </form>
    </div>
  );
}

function formatChatTime(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function chatStatus(connection: ConnectionState, readOnly: boolean): string {
  if (readOnly) return "Chat paused in this tab";
  if (connection === "offline" || connection === "reconnecting") return "Chat unavailable while reconnecting";
  return "Chat unavailable";
}

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

function Home(props: HomeProps) {
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
  const [nameSaved, setNameSaved] = useState(false);

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
              <button className="button primary" type="button" onClick={() => { setRoomName(`${props.name.trim() || "Player"}'s room`); setCreateOpen(true); setJoinOpen(false); }}>Create room</button>
              <button className="button" type="button" onClick={() => { setJoinOpen(true); setCreateOpen(false); }}>Join by code</button>
            </div>
            {props.notice && <p className="form-notice" role="alert">{props.notice}</p>}

            {createOpen && (
              <form className="inline-form" onSubmit={(event) => {
                event.preventDefault();
                props.onCreate(visibility, targetScore, roomName, memoryMode, turnDurationSeconds, visibility === "private" ? createPassword : undefined);
              }}>
                <div className="segmented" aria-label="Room visibility">
                  <button type="button" aria-pressed={visibility === "public"} onClick={() => setVisibility("public")}>Public</button>
                  <button type="button" aria-pressed={visibility === "private"} onClick={() => setVisibility("private")}>Private</button>
                </div>
                <label className="field-label" htmlFor="create-room-name">Room name <span>up to 40 characters</span><input id="create-room-name" className="input" value={roomName} onChange={(event) => setRoomName(event.target.value)} /></label>
                <label className="field-label">Target score<input className="input" type="number" min={20} max={500} value={targetScore} onChange={(event) => setTargetScore(Number(event.target.value))} /></label>
                <label className="field-label">Memory mode<select className="input" value={memoryMode} onChange={(event) => setMemoryMode(event.target.value as MemoryMode)}><option value="classic">Classic — remember cards yourself</option><option value="assisted">Assisted — keep seen cards visible</option></select></label>
                <label className="field-label">Step timer<select className="input" value={turnDurationSeconds} onChange={(event) => setTurnDurationSeconds(Number(event.target.value) as TurnDurationSeconds)}>{[0, 30, 60, 90].map((seconds) => <option key={seconds} value={seconds}>{seconds ? `${seconds} seconds` : "Unlimited"}</option>)}</select></label>
                {visibility === "private" && <label className="field-label">Six-digit password<input className="input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={createPassword} onChange={(event) => setCreatePassword(event.target.value.replace(/\D/g, ""))} /></label>}
                <button className="button primary" disabled={props.busy || Array.from(roomName.trim()).length > 40 || targetScore < 20 || targetScore > 500 || (visibility === "private" && !/^\d{6}$/.test(createPassword))}>Create table</button>
              </form>
            )}

            {joinOpen && (
              <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (!props.invitation?.error) props.onJoin(roomCode.trim(), joinPassword || undefined, props.invitation?.server); }}>
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

function ShareRoom(props: { roomId: string; server: string }) {
  const [fallback, setFallback] = useState<string>();
  const [copied, setCopied] = useState(false);
  const copy = async (value: string) => {
    const ok = await copyText(value);
    setCopied(ok); setFallback(ok ? undefined : value);
  };
  return <details className="share-room"><summary>Share</summary><div>
    <button className="button" type="button" onClick={() => void copy(props.roomId)}>Copy room code</button>
    <button className="button" type="button" onClick={() => void copy(invitationLink(props.roomId, props.server))}>Copy invite link</button>
    {copied && <span role="status">Copied</span>}
    {fallback && <label>Copy manually<input aria-label="Copy manually" readOnly value={fallback} onFocus={(event) => event.target.select()} /></label>}
  </div></details>;
}

function Lobby(props: { roomId: string; roomName: string; targetScore: number; players: StatePlayer[]; selfId: string; canStart: boolean; busy: boolean; onStart(): void; onLeave(): void }) {
  return (
    <main className="lobby-shell">
      <section className="lobby-copy"><p className="eyebrow room-name">{props.roomName}</p><p className="room-code">Room <span className="room-id">{props.roomId}</span></p><h1>The table is almost ready.</h1><p>Share the case-sensitive room code. The host can begin once at least two players are connected.</p></section>
      <section className="lobby-panel">
        <div className="lobby-score"><span>Target score</span><strong>{props.targetScore}</strong></div>
        <div className="seat-list">
          {[0, 1, 2, 3, 4].map((seat) => {
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
          <li>One drawn card may replace 1–4 cards; selections of 2–4 must match. A failed match reveals them and can add a penalty card.</li>
          <li><strong>7–8</strong> peek at your card; <strong>9–10</strong> peek at another player's card.</li>
          <li><strong>J–Q</strong> blindly swap any own card with any card of another player.</li>
          <li>After Cabo, everyone else gets one final turn. A successful caller scores zero.</li>
          <li>Exactly two Queens and both Kings shoots the moon: 0 for you, half the target for everyone else.</li>
        </ul>
        <a href="/docs/rules/">Read the full rules <span aria-hidden="true">↗</span></a>
      </aside>
    </div>
  );
}

function ScoreHistoryPanel(props: { state: CaboStateLike }) {
  const [preview, setPreview] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [revealedCell, setRevealedCell] = useState<string>();
  const matrix = useRef<HTMLDivElement>(null);
  const ignoreNextFocus = useRef(false);
  const history = [...(props.state.roundHistory ?? [])].sort((a, b) => a.round - b.round);
  const players = [...props.state.players.values()].sort((a, b) => a.seat - b.seat);
  const leaders = players.filter((player) => !player.forfeited);
  const leader = [...(leaders.length ? leaders : players)].sort((a, b) => a.score - b.score)[0];
  const open = preview || pinned;

  useEffect(() => {
    if (!open || !matrix.current) return;
    const frame = requestAnimationFrame(() => {
      if (matrix.current) matrix.current.scrollLeft = matrix.current.scrollWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, history.length]);

  return (
    <div
      className={`score-history ${open ? "is-open" : ""} ${pinned ? "is-pinned" : ""}`}
      onMouseEnter={() => setPreview(true)}
      onMouseLeave={() => setPreview(false)}
      onFocus={() => {
        if (ignoreNextFocus.current) {
          ignoreNextFocus.current = false;
          return;
        }
        setPreview(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreview(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setPinned(false);
          setPreview(false);
          const trigger = event.currentTarget.querySelector(".score-history-trigger") as HTMLButtonElement | null;
          if (trigger && document.activeElement !== trigger) {
            ignoreNextFocus.current = true;
            trigger.focus();
          }
        }
      }}
    >
      <div className="score-history-shell">
        <button
          className="score-history-trigger"
          type="button"
          aria-expanded={open}
          aria-controls="score-history-matrix"
          onClick={(event) => {
            if (pinned) {
              setPinned(false);
              setPreview(false);
              event.currentTarget.blur();
            } else {
              setPinned(true);
            }
          }}
        >
          <span>Scores</span>
          <strong>{history.length ? `R${history.at(-1)?.round}` : `R${props.state.round}`}</strong>
          <small>{leader ? `${leader.name} ${leader.score}` : "Waiting"}</small>
          <i aria-hidden="true">{pinned ? "×" : "+"}</i>
        </button>
        <div className="score-history-content" aria-hidden={!open}>
          <div className="score-history-heading">
            <div><p className="eyebrow">Round archive</p><h2>Every hand. Every point.</h2></div>
            <span>{history.length} completed {history.length === 1 ? "round" : "rounds"}</span>
          </div>
          {history.length ? (
            <div className="score-matrix-scroll" id="score-history-matrix" ref={matrix}>
              <table className="score-matrix">
                <thead><tr><th scope="col">Player</th>{history.map((entry) => (
                  <th scope="col" className={entry === history.at(-1) ? "latest" : ""} key={entry.round}>
                    <strong>Round {entry.round}</strong>
                    <span>{roundOutcome(entry, props.state)}</span>
                  </th>
                ))}</tr></thead>
                <tbody>{players.map((player) => (
                  <tr key={player.id}>
                    <th scope="row"><Avatar player={player} /><span><strong>{player.name}</strong><small>{player.forfeited ? "DNF" : `${player.score} pts now`}</small></span></th>
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
          ) : <p className="score-history-empty" id="score-history-matrix">Completed rounds will appear here for everyone at the table.</p>}
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

interface GameTableProps {
  temporaryCards?: Array<{ ownerId: string; position: number; card: KnownCard; expiresAt: number; round: number }>;
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
    }
    else if (state.phase === "POWER_PENDING" && (power === 7 || power === 8)) props.onExecute({ type: "peek-self", position });
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
        <div className="hand-block">
          <div className="hand-heading"><div><strong>{self?.name ?? "Your hand"} · {self?.score ?? 0} pts</strong><span>{props.core.knowledge.slots.filter(Boolean).length} known · {Math.max(0, (self?.cardCount ?? 0) - props.core.knowledge.slots.filter(Boolean).length)} hidden</span></div><button className="privacy-button" type="button" onPointerDown={props.onConcealStart} onPointerUp={props.onConcealEnd} onPointerCancel={props.onConcealEnd}>Hold to conceal</button></div>
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

interface CardFlight {
  key: string;
  from: DOMRect;
  to: DOMRect;
  card: KnownCard | undefined;
  delay: number | undefined;
  peek: boolean | undefined;
}

function MotionLayer(props: { motion: CardMotion }) {
  const [flights, setFlights] = useState<CardFlight[]>([]);

  useEffect(() => {
    setFlights(buildFlights(props.motion));
  }, [props.motion]);

  return (
    <div className="motion-layer" aria-live="polite" aria-label={motionAnnouncement(props.motion)}>
      {flights.map((flight) => {
        const style = {
          left: flight.from.left,
          top: flight.from.top,
          width: flight.from.width,
          height: flight.from.height,
          "--motion-x": `${flight.to.left - flight.from.left}px`,
          "--motion-y": `${flight.to.top - flight.from.top}px`,
          "--motion-width": `${flight.to.width}px`,
          "--motion-height": `${flight.to.height}px`,
          animationDelay: `${flight.delay ?? 0}ms`,
        } as CSSProperties;
        return <div className={`motion-card motion-${props.motion.action} ${flight.card ? "face" : "back"} ${flight.peek ? "peek" : ""}`} style={style} key={flight.key}>{flight.card ? formatCardLabel(flight.card.label) : <span>C</span>}</div>;
      })}
    </div>
  );
}

function buildFlights(motion: CardMotion): CardFlight[] {
  const deck = anchorRect("deck");
  const discard = anchorRect("discard");
  const decision = anchorRect(`decision-${motion.playerId}`);
  const position = motion.action === "swap" ? motion.ownPosition : "position" in motion ? motion.position : motion.action === "replace" ? motion.replacementPosition : undefined;
  const slot = position ? anchorRect(`slot-${motion.playerId}-${position}`) : undefined;
  const flight = (key: string, from: DOMRect | undefined, to: DOMRect | undefined, card?: KnownCard, delay?: number, peek?: boolean): CardFlight[] => from && to ? [{ key, from, to, card, delay, peek }] : [];

  switch (motion.action) {
    case "draw-deck": return flight("draw", deck, decision);
    case "draw-discard": return flight("take-discard", discard, decision, motion.takenCard);
    case "replace": return [
      ...flight("keep-drawn", decision, slot),
      ...flight("replace-discard", slot, discard, motion.discardedCards[0], 120),
    ];
    case "discard": return flight("discard-drawn", decision, discard, motion.discardedCard);
    case "peek-self": return flight("peek-self", slot, decision, undefined, 0, true);
    case "peek-other": return flight("peek-other", anchorRect(`slot-${motion.targetPlayerId}-${motion.position}`), decision, undefined, 0, true);
    case "swap": return [
      ...flight("swap-own", slot, anchorRect(`slot-${motion.targetPlayerId}-${motion.targetPosition}`)),
      ...flight("swap-target", anchorRect(`slot-${motion.targetPlayerId}-${motion.targetPosition}`), slot, undefined, 70),
    ];
    default: return [];
  }
}

function anchorRect(name: string): DOMRect | undefined {
  const element = [...document.querySelectorAll<HTMLElement>("[data-card-anchor]")].find((candidate) => candidate.dataset.cardAnchor === name);
  return element?.getBoundingClientRect();
}

function motionDuration(motion: PublicActionEvent): number {
  if (motion.action === "peek-self" || motion.action === "peek-other" || motion.action === "swap") return 820;
  if (motion.action === "skip" || motion.action === "cabo") return 420;
  return 720;
}

function motionAnnouncement(motion: PublicActionEvent): string {
  if (motion.action === "draw-deck") return "A card moved from the deck to the player's drawn card area.";
  if (motion.action === "draw-discard") return "The top discard moved to the player's drawn card area.";
  if (motion.action === "replace") return `The drawn card replaced positions ${motion.positions.join(", ")}.`;
  if (motion.action === "exchange-mismatch") return `Positions ${motion.positions.join(", ")} did not match and were revealed.`;
  if (motion.action === "resolve-mismatch") return "The mismatch cards were placed at the chosen ends.";
  if (motion.action === "discard") return "The drawn card moved to the discard pile.";
  if (motion.action === "peek-self" || motion.action === "peek-other") return `Card ${motion.position} was inspected.`;
  if (motion.action === "swap") return `Card ${motion.ownPosition} was swapped with opponent card ${motion.targetPosition}.`;
  return motion.action === "skip" ? "The card power was skipped." : "Cabo was called.";
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

function Results(props: { result: ResultEvent; state: CaboStateLike; selfId?: string; playerName(id: string): string; busy: boolean; onReady?(): void; onLeave(): Promise<void> }) {
  if (props.result.type === "match-result") {
    const ranking = Object.entries(props.result.totals).sort(([, a], [, b]) => a - b);
    return <Modal title="Match complete"><p className="result-lede">{props.result.winners.map(props.playerName).join(" & ")} {props.result.winners.length > 1 ? "share" : "takes"} the table.</p><div className="score-list">{ranking.map(([id, score], index) => <div key={id}><span>0{index + 1} · {props.playerName(id)}</span><strong>{score} pts</strong></div>)}</div><div className="modal-actions"><button className="button primary" type="button" disabled={props.busy} onClick={() => void props.onLeave()}>{props.busy ? "Leaving…" : "Back to rooms"}</button></div></Modal>;
  }
  const round = props.result;
  const headline = round.outcome.type === "shooting-the-moon"
    ? `${props.playerName(round.outcome.playerId)} shot the moon.`
    : `Cabo ${round.outcome.succeeded ? "succeeded." : "was challenged."}`;
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">{headline} Confirm when you are ready to continue.</p><div className="result-hands">{round.hands.map((hand) => <div key={hand.playerId}><div><strong>{props.playerName(hand.playerId)}</strong><span>+{round.roundScores[hand.playerId] ?? 0} · {round.totals[hand.playerId] ?? 0} total</span></div><div className="result-cards">{hand.cards.map((card, index) => <span key={`${card.label}-${index}`}>{formatCardLabel(card.label)}</span>)}</div></div>)}</div><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} onReady={props.onReady} /></Modal>;
}

function ScoreFallback(props: { state: CaboStateLike; selfId: string; busy: boolean; onReady(): void }) {
  const players = [...props.state.players.values()].sort((a, b) => a.score - b.score);
  return <Modal title={`Round ${props.state.round} complete`}><p className="result-lede">The private result arrived before this page reconnected. Current totals are shown while everyone confirms the next round.</p><div className="score-list">{players.map((player) => <div key={player.id}><span>{player.name}</span><strong>{player.score} pts</strong></div>)}</div><NextRoundReady state={props.state} selfId={props.selfId} busy={props.busy} onReady={props.onReady} /></Modal>;
}

function NextRoundReady(props: { state: CaboStateLike; selfId: string | undefined; busy: boolean; onReady: (() => void) | undefined }) {
  const active = [...props.state.players.values()].filter((player) => !player.forfeited);
  const ready = active.filter((player) => player.nextRoundReady).length;
  const self = props.selfId ? props.state.players.get(props.selfId) : undefined;
  const confirmed = Boolean(self?.nextRoundReady);
  return <div className="modal-actions"><span>{ready} of {active.length} active players ready</span>{self && !self.forfeited && <button className="button primary" type="button" disabled={props.busy || confirmed || !props.onReady} onClick={props.onReady}>{confirmed ? "Waiting for others…" : props.busy ? "Confirming…" : "Ready for next round"}</button>}</div>;
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
  if (state.phase === "ROUND_RESULT") return { eyebrow: "Round complete", title: "Count the cards.", detail: "The next round begins when every active player is ready." };
  if (state.phase === "MATCH_RESULT") return { eyebrow: "Match complete", title: "The table has spoken.", detail: "Review the final scores." };
  if (state.currentPlayerId !== selfId) return { eyebrow: state.phase === "FINAL_TURNS" ? "Final turns" : "In play", title: `${current}'s turn`, detail: "Watch the table and remember what changes." };
  if (state.phase === "DRAWN") return { eyebrow: "Your turn · card drawn", title: "Make the exchange.", detail: `Replace 1–4 cards${state.drawSource === "deck" ? " or discard the draw" : ""}.` };
  if (state.phase === "MISMATCH_PENDING") return { eyebrow: "Your turn · mismatch", title: "Place the penalty.", detail: "The selected cards are public; choose where the new cards go." };
  if (state.phase === "POWER_PENDING") return { eyebrow: "Your turn · power", title: "Use what you revealed.", detail: "Resolve the card power or skip it." };
  return { eyebrow: state.phase === "FINAL_TURNS" ? "Your final turn" : "Your turn", title: "Choose where to draw.", detail: "The deck hides possibility; the discard offers certainty." };
}

function formatEvent(event: any, name: (id: string) => string): string | undefined {
  switch (event?.type) {
    case "joined": return `${event.name} joined the table.`;
    case "disconnected": return `${name(event.playerId)} went offline.`;
    case "reconnected": return `${name(event.playerId)} reconnected.`;
    case "turn": return `${name(event.playerId)} is playing${event.finalTurn ? " their final turn" : ""}.`;
    case "turn-timeout": return `${name(event.playerId)} timed out; the server completed their turn.`;
    case "action": {
      const actor = name(event.playerId);
      if (event.action === "draw-deck") return `${actor} drew a hidden card from the deck.`;
      if (event.action === "draw-discard") return `${actor} took ${event.takenCard.label} from the discard pile.`;
      if (event.action === "replace") return `${actor} replaced positions ${event.positions.join(", ")}; drawn card placed at ${event.replacementPosition}.`;
      if (event.action === "exchange-mismatch") return `${actor}'s selected cards did not match and were revealed.`;
      if (event.action === "resolve-mismatch") return `${actor} placed the mismatch cards at the chosen ends.`;
      if (event.action === "discard") return `${actor} discarded the drawn ${event.discardedCard.label}.`;
      if (event.action === "peek-self") return `${actor} looked at their card ${event.position}.`;
      if (event.action === "peek-other") return `${actor} looked at ${name(event.targetPlayerId)}'s card ${event.position}.`;
      if (event.action === "swap") return `${actor} swapped card ${event.ownPosition} with ${name(event.targetPlayerId)}'s card ${event.targetPosition}.`;
      if (event.action === "skip") return `${actor} skipped the card power.`;
      if (event.action === "cabo") return `${actor} called Cabo.`;
      return undefined;
    }
    case "discard": case "swap": return undefined;
    case "cabo": return undefined;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const __test = { validateServerUrl, buildFlights, Results, RulesPopover, ScoreHistoryPanel, GameTable, Lobby, RoomChat };
