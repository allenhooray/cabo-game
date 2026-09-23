import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CaboClientCore, type CaboStateLike, type ListedRoom } from "@cabo-game/client-core";
import type { BotCommand, ClientCommand, MemoryMode, PrivateRevealMessage, RoomChatMessage, TurnDurationSeconds } from "@cabo-game/shared";
import {
  BrowserSessionStore,
  resetServerUrl,
  savePlayerName,
  saveServerUrl,
  savedPlayerName,
  savedServerUrl,
} from "../../browser-session.js";
import { readInvitation } from "../../invitation.js";
import { clientEvent, type ClientEvent, type ConnectionState } from "../game/types.js";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

interface SessionCallbacks {
  onState(state: CaboStateLike): void;
  onReveal(message: PrivateRevealMessage): void;
  onEvent(event: ClientEvent, state: CaboStateLike | undefined): void;
  onChat(message: RoomChatMessage): void;
  onBegin(): void;
  onLeft(): void;
  onLeaveCompleted(): void;
}

const sessionStore = new BrowserSessionStore();

export function useCaboSession(callbacks: SessionCallbacks) {
  const { t } = useTranslation();
  const [invitation, setInvitation] = useState(readInvitation);
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
  const [readOnly, setReadOnly] = useState(false);
  const reconnectAttempted = useRef(false);
  const roomChannel = useRef<BroadcastChannel | undefined>(undefined);

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
          callbacks.onState(nextState);
          setRevisionTick((value) => value + 1);
        },
        reveal: (message) => {
          callbacks.onReveal(message);
          setRevisionTick((value) => value + 1);
        },
        knowledge: () => setRevisionTick((value) => value + 1),
        event: (value: unknown) => {
          const event = clientEvent(value);
          if (event) callbacks.onEvent(event, instance.state);
          setRevisionTick((revision) => revision + 1);
        },
        error: (error) => setNotice(localizedError(t, error)),
        chat: callbacks.onChat,
        dropped: () => {
          setConnection("offline");
          setNotice(t("session.connectionLost"));
        },
        reconnected: () => {
          setConnection("live");
          setNotice(t("session.connectionRestored"));
        },
        left: () => {
          setConnection("idle");
          setCore(undefined);
          callbacks.onLeft();
        },
        persistenceError: () => setNotice(t("session.saveFailed")),
      },
    });
    return instance;
  }, [callbacks, t]);

  const refreshRooms = useCallback(async () => {
    setRoomsBusy(true);
    setNotice(undefined);
    try {
      const listingCore = new CaboClientCore({ serverUrl, playerName: "Player" });
      setRooms(await listingCore.listRooms());
    } catch (error) {
      setNotice(errorMessage(error));
      setRooms([]);
    } finally {
      setRoomsBusy(false);
    }
  }, [serverUrl]);

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
        setNotice(t("session.expired"));
      }
    });
  }, [invitation, makeCore, serverUrl]);

  const room = core?.room;
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
    if (!normalizedName) throw new Error(t("session.enterName"));
    const next = makeCore(normalizedName, targetServer);
    callbacks.onBegin();
    setName(normalizedName);
    setCore(next);
    setConnection("connecting");
    return next;
  }, [callbacks, makeCore, name, serverUrl]);

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
        url.searchParams.delete("room");
        url.searchParams.delete("server");
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
  }, [beginConnection, invitation, serverUrl]);

  const execute = useCallback(async (command: ClientCommand) => {
    if (!core || readOnly) return false;
    setBusy(true);
    setNotice(undefined);
    try {
      const response = await core.execute(command);
      if (!response.ok) {
        setNotice(localizedError(t, response.error));
        return false;
      }
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [core, readOnly]);

  const manageBot = useCallback(async (command: BotCommand) => {
    if (!core || readOnly) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await core.manageBot(command);
      if (!result.ok) setNotice(result.error.message);
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }, [core, readOnly]);

  const leave = useCallback(async () => {
    if (!core) return;
    setBusy(true);
    try {
      await core.leave();
      setReadOnly(false);
      callbacks.onLeaveCompleted();
      await refreshRooms();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [callbacks, core, refreshRooms]);

  const applyServer = useCallback((event: FormEvent) => {
    event.preventDefault();
    try {
      const next = saveServerUrl(serverDraft);
      setServerUrl(next);
      setServerDraft(next);
      reconnectAttempted.current = true;
      setNotice(t("session.serverUpdated"));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [serverDraft]);

  const resetServer = useCallback(() => {
    const next = resetServerUrl();
    setServerUrl(next);
    setServerDraft(next);
    reconnectAttempted.current = true;
    setNotice(t("session.serverReset", { url: next }));
  }, []);

  const create = useCallback((visibility: "public" | "private", targetScore: number, roomName: string, memoryMode: MemoryMode, turnDurationSeconds: TurnDurationSeconds, password?: string) => {
    void connect((next) => next.create({ visibility, targetScore, roomName, memoryMode, turnDurationSeconds, ...(password ? { password } : {}) }));
  }, [connect]);

  const join = useCallback((roomId: string, password?: string, targetServer?: string) => {
    void connect((next) => next.join(roomId, password), targetServer ?? serverUrl);
  }, [connect, serverUrl]);

  return {
    invitation,
    serverUrl,
    serverDraft,
    name,
    core,
    state: core?.state,
    room,
    connection,
    rooms,
    roomsBusy,
    busy,
    notice,
    readOnly,
    setName,
    saveName: () => setName(savePlayerName(name)),
    setServerDraft,
    setNotice,
    refreshRooms,
    applyServer,
    resetServer,
    create,
    join,
    execute,
    manageBot,
    leave,
    takeOver: () => {
      roomChannel.current?.postMessage({ type: "takeover" });
      setReadOnly(false);
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function localizedError(t: TFunction, error: { code?: string; message?: string }): string {
  const code = error.code?.trim();
  const known: Record<string, string> = {
    ROOM_FULL: "home.full", ROOM_STARTED: "home.started", NICKNAME_TAKEN: "session.nicknameTaken",
    INVALID_PASSWORD: "session.invalidPassword", NOT_HOST: "session.notHost", NOT_ENOUGH_PLAYERS: "session.notEnoughPlayers",
    NOT_YOUR_TURN: "session.notYourTurn", INVALID_PHASE: "session.invalidPhase", CHAT_RATE_LIMITED: "session.chatRateLimited",
  };
  const key = code ? known[code] : undefined;
  if (key) return t(key);
  if (import.meta.env.DEV && error.message) console.warn("Untranslated Cabo error", error);
  return t("common.unknownError", { code: code ? ` (${code})` : "" });
}
