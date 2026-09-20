import type { AgentCommandResult, ClientCommand, ErrorMessage, PrivateRevealMessage } from "@cabo/shared";
import { Client, type Room } from "@colyseus/sdk";
import { clearSession, loadSession, saveSession, type SavedSession } from "./config.js";
import { applyOwnActionEvent, applyReveal, applySwapEvent, createKnowledge, resetForRound, storedKnowledge, type KnowledgeState, type PendingGameAction } from "./knowledge.js";
import type { CaboStateLike, ListedRoom } from "./model.js";

export interface ClientCoreHandlers {
  attached?(room: Room<any, CaboStateLike>, saved?: SavedSession): void;
  state?(state: CaboStateLike): void;
  reveal?(message: PrivateRevealMessage): void;
  event?(event: any): void;
  error?(message: ErrorMessage): void;
  dropped?(): void;
  reconnected?(): void;
  left?(): void;
  persistenceError?(error: unknown): void;
}

export interface CaboClientCoreOptions {
  serverUrl: string;
  playerName: string;
  sessionPath?: string;
  handlers?: ClientCoreHandlers;
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

interface RevisionWaiter {
  revision: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CaboClientCore {
  readonly serverUrl: string;
  readonly playerName: string;
  readonly sessionPath: string | undefined;
  readonly client: Client;
  room: Room<any, CaboStateLike> | undefined;
  state: CaboStateLike | undefined;
  knowledge: KnowledgeState = createKnowledge();

  private readonly handlers: ClientCoreHandlers;
  private pendingGameAction: PendingGameAction | undefined;
  private sessionWrites = Promise.resolve();
  private readonly pendingAgentResults = new Map<string, PendingAgentResult>();
  private readonly revisionWaiters: RevisionWaiter[] = [];

  constructor(options: CaboClientCoreOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.playerName = options.playerName;
    this.sessionPath = options.sessionPath;
    this.handlers = options.handlers ?? {};
    this.client = new Client(this.serverUrl);
  }

  async listRooms(): Promise<ListedRoom[]> {
    const response = await fetch(`${this.serverUrl}/rooms`);
    if (!response.ok) throw new Error(`Room list failed: HTTP ${response.status}`);
    return await response.json() as ListedRoom[];
  }

  async create(visibility: "public" | "private", targetScore: number, password?: string): Promise<void> {
    if (this.room) throw new Error("Leave the current room first.");
    const room = await this.client.create("cabo", {
      name: this.playerName,
      visibility,
      targetScore,
      ...(password ? { password } : {}),
    });
    await this.attach(room);
  }

  async join(roomId: string, password?: string): Promise<void> {
    if (this.room) throw new Error("Leave the current room first.");
    const room = await this.client.joinById(roomId, { name: this.playerName, ...(password ? { password } : {}) });
    await this.attach(room);
  }

  async reconnect(): Promise<void> {
    if (this.room) throw new Error("Already connected to a room.");
    if (!this.sessionPath) throw new Error("Session persistence is disabled. Start with --session-file to reconnect.");
    const saved = await loadSession(this.sessionPath);
    if (!saved) throw new Error("No saved session.");
    if (saved.server !== this.serverUrl) throw new Error(`Saved session belongs to ${saved.server}.`);
    await this.attach(await this.client.reconnect(saved.token), saved);
  }

  send(command: ClientCommand): void {
    if (!this.room) throw new Error("Join a room first.");
    this.rememberPending(command);
    this.room.send("command", command);
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
    // Colyseus 的消息与 Schema patch 可能先后到达；等待 revision 可避免下一动作读取旧状态。
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
    if (clearSavedSession && this.sessionPath) await clearSession(this.sessionPath);
  }

  async close(): Promise<void> {
    if (this.room) await this.room.leave(true);
  }

  private async attach(nextRoom: Room<any, CaboStateLike>, saved?: SavedSession): Promise<void> {
    this.room = nextRoom;
    this.state = nextRoom.state;
    this.knowledge = createKnowledge(nextRoom.state.round, saved?.knowledge);
    this.pendingGameAction = undefined;
    this.handlers.attached?.(nextRoom, saved);

    nextRoom.onStateChange((state) => {
      const previousKnowledgeRound = this.knowledge.round;
      this.state = state;
      this.knowledge = resetForRound(this.knowledge, state.round);
      if (this.knowledge.round !== previousKnowledgeRound) this.queueSessionPersist();
      this.resolveRevisionWaiters(state.revision);
      this.handlers.state?.(state);
    });
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
    nextRoom.onMessage<any>("event", (event) => {
      // 只有服务端确认的公开事件才能改变牌面记忆，避免失败动作污染 Agent 的知识状态。
      if (event.type === "discard" && event.playerId === nextRoom.sessionId) {
        this.knowledge = applyOwnActionEvent(this.knowledge, this.pendingGameAction);
        this.pendingGameAction = undefined;
        this.queueSessionPersist();
      }
      if (event.type === "swap") {
        this.knowledge = applySwapEvent(
          this.knowledge,
          event.position,
          event.playerId === nextRoom.sessionId || event.targetPlayerId === nextRoom.sessionId,
        );
        if (event.playerId === nextRoom.sessionId) this.pendingGameAction = undefined;
        this.queueSessionPersist();
      }
      if (event.type === "cabo" || event.type === "turn") this.pendingGameAction = undefined;
      this.handlers.event?.(event);
    });
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
    await this.persistSession();
  }

  private rememberPending(command: ClientCommand): void {
    this.pendingGameAction = {
      command,
      ...(command.type === "draw-discard" && this.state?.discardLabel
        ? { discard: { label: this.state.discardLabel, rank: this.state.discardRank } }
        : {}),
    };
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
    if (!this.room || !this.sessionPath) return;
    await saveSession({
      server: this.serverUrl,
      name: this.playerName,
      roomId: this.room.roomId,
      token: this.room.reconnectionToken,
      knowledge: storedKnowledge(this.knowledge),
    }, this.sessionPath);
  }

  private queueSessionPersist(): void {
    this.sessionWrites = this.sessionWrites.then(() => this.persistSession()).catch((error: unknown) => {
      this.handlers.persistenceError?.(error);
    });
  }
}
