import { useCallback, useMemo, useState } from "react";
import type { CaboStateLike } from "@cabo-game/client-core";
import type { ClientCommand } from "@cabo-game/shared";
import { Modal } from "./components/TablePrimitives.js";
import { RoomChat } from "./features/chat/RoomChat.js";
import { useRoomChat } from "./features/chat/useRoomChat.js";
import { GameTable } from "./features/game/GameTable.js";
import { PrivateReveal } from "./features/game/PrivateReveal.js";
import type { Confirmation, ConnectionState, Selection } from "./features/game/types.js";
import { useGameEffects } from "./features/game/useGameEffects.js";
import { Home } from "./features/home/Home.js";
import { Results, ScoreFallback } from "./features/results/Results.js";
import { Lobby, RulesPopover, ScoreHistoryPanel, ShareRoom } from "./features/room/RoomComponents.js";
import { useCaboSession } from "./features/session/useCaboSession.js";

export function App() {
  const chat = useRoomChat();
  const effects = useGameEffects();
  const [selection, setSelection] = useState<Selection>("idle");
  const [targetId, setTargetId] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();

  const resetSelection = useCallback(() => {
    setSelection("idle");
    setTargetId(undefined);
  }, []);
  const onState = useCallback((nextState: CaboStateLike) => {
    setConfirmation((current) => current?.revision !== undefined && current.revision !== nextState.revision ? undefined : current);
    effects.handleState(nextState);
    resetSelection();
  }, [effects.handleState, resetSelection]);
  const callbacks = useMemo(() => ({
    onState,
    onReveal: effects.handleReveal,
    onEvent: effects.handleEvent,
    onChat: chat.receive,
    onBegin: chat.resetContent,
    onLeft: () => {
      resetSelection();
      chat.resetAll();
    },
    onLeaveCompleted: () => {
      effects.reset();
      chat.resetAll();
    },
  }), [chat.receive, chat.resetAll, chat.resetContent, effects.handleEvent, effects.handleReveal, effects.reset, onState, resetSelection]);
  const session = useCaboSession(callbacks);

  const { core, state, room } = session;
  const selfId = room?.sessionId;
  const remainingSeconds = state && state.deadlineAt > 0 && core
    ? Math.max(0, Math.ceil((state.deadlineAt - (core.serverNow() + effects.clockNow - Date.now())) / 1000))
    : undefined;
  const playerName = useCallback((id: string) => core?.state?.players.get(id)?.name ?? id, [core]);
  const execute = useCallback((command: ClientCommand) => {
    void session.execute(command).then((succeeded) => {
      if (succeeded) resetSelection();
    });
  }, [resetSelection, session.execute]);

  if (!state || !state.players || !room || !selfId || !core) {
    return (
      <Home
        invitation={session.invitation}
        serverUrl={session.serverUrl}
        serverDraft={session.serverDraft}
        name={session.name}
        rooms={session.rooms}
        busy={session.busy}
        roomsBusy={session.roomsBusy}
        connection={session.connection}
        notice={session.notice}
        onName={session.setName}
        onSaveName={session.saveName}
        onServerDraft={session.setServerDraft}
        onApplyServer={session.applyServer}
        onResetServer={session.resetServer}
        onRefresh={() => void session.refreshRooms()}
        onCreate={session.create}
        onJoin={session.join}
      />
    );
  }

  const players = [...state.players.values()].sort((a, b) => a.seat - b.seat);
  const self = state.players.get(selfId);
  const activePlayers = players.filter((player) => player.connected && !player.forfeited);
  const chatEnabled = session.connection === "live" && !session.readOnly;
  const chatStatus = session.readOnly
    ? "Chat paused in this tab"
    : session.connection === "offline" || session.connection === "reconnecting"
      ? "Chat unavailable while reconnecting"
      : "Chat unavailable";
  const chatProps = {
    messages: chat.messages,
    selfId,
    enabled: chatEnabled,
    status: chatStatus,
    draft: chat.draft,
    onDraft: chat.setDraft,
    onSend: (text: string) => core.sendChat(text),
  };

  return (
    <div className="app-shell">
      <header className="topbar" data-state-revision={state.revision}>
        <span className="wordmark">CABO</span>
        <div className="room-meta">
          <strong className="room-title">{state.roomName}</strong>
          <span aria-hidden="true" />
          <span className="room-setting">{state.memoryMode === "classic" ? "Classic memory" : "Assisted memory"}</span>
          <span aria-hidden="true" />
          <span className="room-setting">{state.turnDurationSeconds ? `${state.turnDurationSeconds}s turns` : "Untimed turns"}</span>
          <span aria-hidden="true" />
          <ShareRoom roomId={room.roomId} server={session.serverUrl} />
        </div>
        <div className="topbar-actions">
          <button
            ref={chat.triggerRef}
            className="chat-trigger"
            type="button"
            aria-label={chat.unread > 0 ? `Chat, ${chat.unread} unread ${chat.unread === 1 ? "message" : "messages"}` : "Chat"}
            aria-haspopup="dialog"
            aria-expanded={chat.open}
            onClick={chat.openDrawer}
          >
            Chat
            {chat.unread > 0 && <span className="chat-unread-dot" aria-hidden="true" />}
          </button>
          {state.phase !== "LOBBY" && <ScoreHistoryPanel state={state} selfId={selfId} />}
          <RulesPopover />
          <div className={`connection connection-${session.connection}`}><i />{connectionLabel(session.connection)}</div>
        </div>
      </header>

      {session.notice && <div className="notice" role="status"><span>{session.notice}</span><button type="button" aria-label="Dismiss message" onClick={() => session.setNotice(undefined)}>×</button></div>}
      {session.readOnly && (
        <div className="readonly-banner" role="alert">
          This seat is open in another tab. Actions are paused here.
          <button type="button" onClick={session.takeOver}>Take over here</button>
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
          busy={session.busy || session.readOnly}
          onStart={() => execute({ type: "start" })}
          onLeave={() => setConfirmation({ title: "Leave this room?", body: "Your seat will be released.", label: "Leave room", action: session.leave })}
          />
        ) : (
          <GameTable
          temporaryCards={effects.temporaryCards}
          state={state}
          selfId={selfId}
          players={players}
          core={core}
          busy={session.busy || session.readOnly}
          selection={selection}
          targetId={targetId}
          events={effects.events}
          cardMotion={effects.cardMotion}
          remainingSeconds={remainingSeconds}
          onSelection={(next) => { setSelection(next); setTargetId(undefined); }}
          onTarget={setTargetId}
          onExecute={execute}
          onConfirm={setConfirmation}
          onLeave={() => setConfirmation({ title: "Leave the match?", body: "Leaving an active match counts as a forfeit.", label: "Forfeit and leave", action: session.leave })}
          />
        )}
        </main>
        <aside className="chat-sidebar" aria-label="Room chat">
          <RoomChat {...chatProps} />
        </aside>
      </div>

      {chat.open && (
        <div className="chat-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) chat.closeDrawer(); }}>
          <section className="chat-drawer" role="dialog" aria-modal="true" aria-label="Room chat">
            <button className="chat-close" type="button" aria-label="Close chat" onClick={chat.closeDrawer}>×</button>
            <RoomChat {...chatProps} autoFocus onClose={chat.closeDrawer} />
          </section>
        </div>
      )}

      {effects.privateReveal && <PrivateReveal message={effects.privateReveal} onClose={effects.clearPrivateReveal} />}
      {effects.result && <Results result={effects.result} state={state} selfId={selfId} playerName={playerName} busy={session.busy || session.readOnly} remainingSeconds={remainingSeconds} onReady={() => execute({ type: "ready-next-round" })} onLeave={session.leave} />}
      {!effects.result && state.phase === "ROUND_RESULT" && <ScoreFallback state={state} selfId={selfId} busy={session.busy || session.readOnly} remainingSeconds={remainingSeconds} onReady={() => execute({ type: "ready-next-round" })} />}
      {!effects.result && state.phase === "MATCH_RESULT" && (
        <Results
          result={{ type: "match-result", winners: [...state.winners], totals: Object.fromEntries(players.map((player) => [player.id, player.score])) }}
          state={state}
          playerName={playerName}
          busy={session.busy}
          onLeave={session.leave}
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

function connectionLabel(state: ConnectionState): string {
  if (state === "live") return "Live";
  if (state === "connecting") return "Connecting";
  if (state === "reconnecting") return "Reconnecting";
  if (state === "offline") return "Offline";
  return "Ready";
}
