import type { AgentCommandResult, BotCommand, BotCommandResult, ClientCommand, ErrorMessage, PrivateKnowledgeSnapshot, PrivateRevealMessage, RoomChatMessage, MemoryMode, TurnDurationSeconds } from "@cabo-game/shared";
import { Client, type Room } from "@colyseus/sdk";
import { applyKnowledgeSnapshot, applyOwnActionEvent, applyReveal, applySwapEvent, createKnowledge, resetForRound, storedKnowledge, type KnowledgeState, type PendingGameAction } from "./knowledge.js";
import type { CaboStateLike, ListedRoom, ListedRoomResponse } from "./model.js";
import type { SavedSession, SessionStore } from "./session.js";

export const DEFAULT_SERVER_URL = "https://cabo-api.human404.link";

export interface ClientCoreHandlers {
  attached?(room: Room<any, CaboStateLike>, saved?: SavedSession): void;
  state?(state: CaboStateLike): void;
  reveal?(message: PrivateRevealMessage): void;
  knowledge?(knowledge: KnowledgeState): void;
  event?(event: any): void;
  chat?(message: RoomChatMessage): void;
  error?(message: ErrorMessage): void;
  dropped?(): void;
  reconnected?(): void;
  left?(): void;
  persistenceError?(error: unknown): void;
}

export interface CaboClientCoreOptions {
  serverUrl: string;
  playerName: string;
  sessionStore?: SessionStore;
  handlers?: ClientCoreHandlers;
}

export interface ExecuteOptions {
  id?: string;
  timeoutMs?: number;
}

export interface CreateRoomOptions {
  memoryMode: MemoryMode;
  turnDurationSeconds: TurnDurationSeconds;
  visibility: "public" | "private";
  targetScore: number;
  roomName?: string;
  password?: string;
}

export class AgentRequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly uncertain = true;

  constructor(id: string) {
    super(`Request ${id} did not receive a committed result before the timeout.`);
    this.name = "AgentRequestTimeoutError";
  }
}

interface PendingAgentResult {
  resolve(result: AgentCommandResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingBotResult {
  resolve(result: BotCommandResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RevisionWaiter {
  revision: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

let requestSequence = 0;

export class CaboClientCore {
  readonly serverUrl: string;
  readonly playerName: string;
  readonly client: Client;
  room: Room<any, CaboStateLike> | undefined;
  state: CaboStateLike | undefined;
  knowledge: KnowledgeState = createKnowledge();
  private serverOffset = 0;
  serverNow(): number { return Date.now() + this.serverOffset; }

  private readonly handlers: ClientCoreHandlers;
  private readonly sessionStore: SessionStore | undefined;
  private pendingGameAction: PendingGameAction | undefined;
  private sessionWrites = Promise.resolve();
  private readonly pendingAgentResults = new Map<string, PendingAgentResult>();
  private readonly pendingBotResults = new Map<string, PendingBotResult>();
  private readonly revisionWaiters: RevisionWaiter[] = [];

  constructor(options: CaboClientCoreOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.playerName = options.playerName;
    this.sessionStore = options.sessionStore;
    this.handlers = options.handlers ?? {};
    this.client = new Client(this.serverUrl);
  }

  async listRooms(): Promise<ListedRoom[]> {
    const response = await fetch(`${this.serverUrl}/rooms`);
    if (!response.ok) throw new Error(`Room list failed: HTTP ${response.status}`);
    const rooms = await response.json() as ListedRoomResponse[];
    return rooms.map(normalizeListedRoom);
  }

  async create(options: CreateRoomOptions): Promise<void> {
    if (this.room) throw new Error("Leave the current room first.");
    const room = await this.client.create("cabo", {
      name: this.playerName,
      visibility: options.visibility,
      targetScore: options.targetScore,
      memoryMode: options.memoryMode,
      turnDurationSeconds: options.turnDurationSeconds,
      ...(options.roomName !== undefined ? { roomName: options.roomName } : {}),
      ...(options.password ? { password: options.password } : {}),
    });
    await this.attach(room);
  }

  async join(roomId: string, password?: string, botToken?: string): Promise<void> {
    if (this.room) throw new Error("Leave the current room first.");
    const room = await this.client.joinById(roomId, { name: this.playerName, ...(password ? { password } : {}), ...(botToken ? { botToken } : {}) });
    await this.attach(room);
  }

  async reconnect(): Promise<void> {
    if (this.room) throw new Error("Already connected to a room.");
    if (!this.sessionStore) throw new Error("Session persistence is disabled.");
    const saved = await this.sessionStore.load();
    if (!saved) throw new Error("No saved session.");
    if (saved.server !== this.serverUrl) throw new Error(`Saved session belongs to ${saved.server}.`);
    if (saved.name !== this.playerName) throw new Error(`Saved session belongs to ${saved.name}.`);
    await this.attach(await this.client.reconnect(saved.token), saved);
  }

  send(command: ClientCommand): void {
    if (!this.room) throw new Error("Join a room first.");
    this.rememberPending(command);
    this.room.send("command", command);
  }

  sendChat(text: string): void {
    if (!this.room) throw new Error("Join a room first.");
    this.room.send("chat", { text });
  }

  async manageBot(command: BotCommand, timeoutMs = 20_000): Promise<BotCommandResult> {
    if (!this.room) throw new Error("Join a room first.");
    const id = `bot-${Date.now()}-${++requestSequence}`;
    return new Promise<BotCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingBotResults.delete(id); reject(new Error("Bot request timed out.")); }, timeoutMs);
      this.pendingBotResults.set(id, { resolve, reject, timer });
      this.room?.send("bot-command", { id, command });
    });
  }

  execute(command: ClientCommand, options: ExecuteOptions = {}): Promise<AgentCommandResult> {
    requestSequence += 1;
    const id = options.id ?? `web-${Date.now()}-${requestSequence}`;
    return this.sendAgent(id, command, options.timeoutMs ?? 15_000);
  }

  async sendAgent(id: string, command: ClientCommand, timeoutMs: number): Promise<AgentCommandResult> {
    if (!this.room) throw new Error("Join a room first.");
    if (this.pendingAgentResults.has(id)) throw new Error(`Duplicate in-flight request id: ${id}`);
    const deadline = Date.now() + timeoutMs;
    this.rememberPending(command);
    const result = await new Promise<AgentCommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentResults.delete(id);
        this.pendingGameAction = undefined;
        reject(new AgentRequestTimeoutError(id));
      }, timeoutMs);
      this.pendingAgentResults.set(id, { resolve, reject, timer });
      this.room?.send("agent-command", { id, command });
    });
    if (!result.ok) {
      this.pendingGameAction = undefined;
      return result;
    }
    await this.waitForRevision(id, result.revision, Math.max(0, deadline - Date.now()));
    return result;
  }

  async leave(clearSavedSession = true): Promise<void> {
    if (!this.room) throw new Error("Not in a room.");
    this.room.send("command", { type: "leave" });
    await this.room.leave(true);
    this.room = undefined;
    this.state = undefined;
    this.knowledge = createKnowledge();
    this.pendingGameAction = undefined;
    if (clearSavedSession) await this.sessionStore?.clear();
  }

  async close(): Promise<void> {
    if (this.room) await this.room.leave(true);
  }

  async clearSession(): Promise<void> {
    await this.sessionStore?.clear();
  }

  private async attach(nextRoom: Room<any, CaboStateLike>, saved?: SavedSession): Promise<void> {
    this.room = nextRoom;
    this.state = undefined;
    this.knowledge = createKnowledge();
    this.pendingGameAction = undefined;

    let attached = false;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

    const fallbackRoomName = `Room ${nextRoom.roomId}`;
    const acceptState = (receivedState: CaboStateLike): void => {
      if (!isHydratedState(receivedState)) return;
      const state = withRoomName(receivedState, fallbackRoomName);
      const previousKnowledgeRound = this.knowledge.round;
      this.state = state;
      this.serverOffset = state.serverTime - Date.now();
      if (!attached) {
        attached = true;
        if (this.knowledge.round !== state.round || this.knowledge.memoryMode !== state.memoryMode) this.knowledge = createKnowledge(state.round, undefined, state.memoryMode);
        this.handlers.attached?.(nextRoom, saved);
        resolveReady();
      } else {
        this.knowledge = resetForRound(this.knowledge, state.round, state.memoryMode);
        if (this.knowledge.round !== previousKnowledgeRound) this.queueSessionPersist();
      }
      this.resolveRevisionWaiters(state.revision);
      this.handlers.state?.(state);
    };

    nextRoom.onStateChange(acceptState);
    acceptState(nextRoom.state);
    nextRoom.onMessage<PrivateRevealMessage>("reveal", (message) => {
      this.knowledge = applyReveal(
        this.knowledge,
        message,
        this.state?.round ?? 0,
        this.state?.phase ?? "LOBBY",
        this.pendingGameAction,
      );
      if (message.reason === "peek") this.pendingGameAction = undefined;
      this.queueSessionPersist();
      this.handlers.reveal?.(message);
    });
    nextRoom.onMessage<PrivateKnowledgeSnapshot>("knowledge", (message) => {
      this.knowledge = applyKnowledgeSnapshot(message);
      this.queueSessionPersist();
      this.handlers.knowledge?.(this.knowledge);
    });
    nextRoom.onMessage<ErrorMessage>("error", (message) => {
      this.pendingGameAction = undefined;
      this.handlers.error?.(message);
    });
    nextRoom.onMessage<AgentCommandResult>("agent-result", (result) => {
      const pending = this.pendingAgentResults.get(result.id);
      if (!pending) return;
      this.pendingAgentResults.delete(result.id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    });
    nextRoom.onMessage<BotCommandResult>("bot-result", (result) => {
      const pending = this.pendingBotResults.get(result.id);
      if (!pending) return;
      this.pendingBotResults.delete(result.id);
      clearTimeout(pending.timer);
      pending.resolve(result);
    });
    nextRoom.onMessage<any>("event", (event) => {
      if (event.type === "discard" && event.playerId === nextRoom.sessionId) {
        this.knowledge = applyOwnActionEvent(this.knowledge, this.pendingGameAction);
        this.pendingGameAction = undefined;
        this.queueSessionPersist();
      }
      if (event.type === "swap") {
        this.knowledge = applySwapEvent(
          this.knowledge,
          event.playerId === nextRoom.sessionId ? event.ownPosition : event.targetPosition,
          event.playerId === nextRoom.sessionId || event.targetPlayerId === nextRoom.sessionId,
        );
        if (event.playerId === nextRoom.sessionId) this.pendingGameAction = undefined;
        this.queueSessionPersist();
      }
      if (event.type === "cabo" || event.type === "turn") this.pendingGameAction = undefined;
      this.handlers.event?.(event);
    });
    nextRoom.onMessage<RoomChatMessage>("chat", (message) => this.handlers.chat?.(message));
    nextRoom.onDrop(() => this.handlers.dropped?.());
    nextRoom.onReconnect(() => {
      this.queueSessionPersist();
      this.handlers.reconnected?.();
    });
    nextRoom.onLeave(() => {
      if (this.room === nextRoom) {
        this.room = undefined;
        this.state = undefined;
        this.pendingGameAction = undefined;
      }
      this.rejectPendingRequests(new Error("The room connection closed."));
      this.handlers.left?.();
    });
    const readyTimeout = setTimeout(() => resolveReady(), 10_000);
    await ready;
    clearTimeout(readyTimeout);
    if (!attached) {
      await nextRoom.leave(false);
      this.room = undefined;
      throw new Error("The room did not provide an initial state.");
    }
    await this.persistSession();
  }

  private rememberPending(command: ClientCommand): void {
    this.pendingGameAction = { command };
  }

  private waitForRevision(id: string, revision: number, timeoutMs: number): Promise<void> {
    if ((this.state?.revision ?? -1) >= revision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: RevisionWaiter = {
        revision,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.revisionWaiters.indexOf(waiter);
          if (index >= 0) this.revisionWaiters.splice(index, 1);
          this.pendingGameAction = undefined;
          reject(new AgentRequestTimeoutError(id));
        }, timeoutMs),
      };
      this.revisionWaiters.push(waiter);
    });
  }

  private resolveRevisionWaiters(revision: number): void {
    for (let index = this.revisionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.revisionWaiters[index];
      if (waiter && revision >= waiter.revision) {
        this.revisionWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingBotResults.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pendingBotResults.clear();
    for (const pending of this.pendingAgentResults.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingAgentResults.clear();
    for (const waiter of this.revisionWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async persistSession(): Promise<void> {
    if (!this.room || !this.sessionStore) return;
    await this.sessionStore.save({
      server: this.serverUrl,
      name: this.playerName,
      roomId: this.room.roomId,
      token: this.room.reconnectionToken,
      ...(this.knowledge.memoryMode === "assisted" ? { knowledge: storedKnowledge(this.knowledge) } : {}),
    });
  }

  private queueSessionPersist(): void {
    this.sessionWrites = this.sessionWrites.then(() => this.persistSession()).catch((error: unknown) => {
      this.handlers.persistenceError?.(error);
    });
  }
}

function isHydratedState(state: CaboStateLike | undefined): state is CaboStateLike {
  return Boolean(state && state.players && state.winners && typeof state.phase === "string");
}

function withRoomName(state: CaboStateLike, fallback: string): CaboStateLike {
  const compatibleState = state as CaboStateLike & { roomName?: string };
  if (typeof compatibleState.roomName === "string" && compatibleState.roomName.trim()) return state;
  compatibleState.roomName = fallback;
  return compatibleState;
}

function normalizeListedRoom(room: ListedRoomResponse): ListedRoom {
  const phase = room.phase ?? "LOBBY";
  const isFull = room.isFull ?? room.playerCount >= room.maxClients;
  const isStarted = room.isStarted ?? phase !== "LOBBY";
  const roomName = typeof room.roomName === "string" && room.roomName.trim() ? room.roomName : "Unnamed room";
  return {
    memoryMode: room.memoryMode,
    turnDurationSeconds: room.turnDurationSeconds,
    deadlineAt: room.deadlineAt,
    serverTime: room.serverTime,
    roomId: room.roomId,
    roomName,
    targetScore: room.targetScore,
    playerCount: room.playerCount,
    maxClients: room.maxClients,
    phase,
    isFull,
    isStarted,
    canJoin: room.canJoin ?? (!isFull && !isStarted && !room.locked),
  };
}
