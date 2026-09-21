import { createHash, timingSafeEqual } from "node:crypto";
import {
  agentCommandRequestSchema,
  clientCommandSchema,
  GameEngine,
  GameRuleError,
  joinOptionsSchema,
  roomOptionsSchema,
  type ClientCommand,
  type AgentCommandResult,
  type Card,
  type EngineEvent,
  type ErrorMessage,
  type Position,
} from "@cabo-game/shared";
import { type Client, Room } from "colyseus";
import { CaboState, PlayerState } from "./state.js";
import { PrivateKnowledgeStore, publicAction } from "./private-knowledge.js";

interface RoomMetadata {
  visibility: "public" | "private";
  roomName: string;
  phase: string;
  targetScore: number;
  playerCount: number;
  maxClients: number;
}

export class CaboRoom extends Room<{ state: CaboState; metadata: RoomMetadata }> {
  state = new CaboState();
  maxClients = 5;
  maxMessagesPerSecond = 20;

  private engine: GameEngine | undefined;
  private hostId = "";
  private passwordHash: Buffer | undefined;
  private visibility: "public" | "private" = "public";
  private targetScore = 100;
  private readonly knowledge = new PrivateKnowledgeStore();

  messages = {
    command: (client: Client, payload: unknown) => this.handleCommand(client, payload),
    "agent-command": (client: Client, payload: unknown) => this.handleAgentCommand(client, payload),
  };

  async onCreate(rawOptions: unknown): Promise<void> {
    const parsed = roomOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid room options.");
    const options = parsed.data;
    if (options.visibility === "private" && !options.password) {
      throw new Error("Private rooms require a six digit password.");
    }
    this.visibility = options.visibility;
    this.targetScore = options.targetScore;
    this.state.roomName = options.roomName?.trim() || `${options.name}'s room`;
    this.state.targetScore = this.targetScore;
    if (options.password) this.passwordHash = this.hashPassword(options.password);
    await this.setPrivate(this.visibility === "private");
    await this.updateListing();
  }

  private validateJoin(rawOptions: unknown): { name: string } {
    if (this.state.phase !== "LOBBY") throw new Error("ROOM_STARTED");
    const parsed = joinOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid join options.");
    if (this.visibility === "private" && !this.passwordMatches(parsed.data.password)) {
      throw new Error("INVALID_PASSWORD");
    }
    const normalized = parsed.data.name.toLocaleLowerCase();
    for (const player of this.state.players.values()) {
      if (player.name.toLocaleLowerCase() === normalized) throw new Error("NICKNAME_TAKEN");
    }
    return { name: parsed.data.name };
  }

  async onJoin(client: Client, rawOptions: unknown): Promise<void> {
    const auth = this.validateJoin(rawOptions);
    const player = new PlayerState().assign({
      id: client.sessionId,
      name: auth.name,
      seat: this.state.players.size,
      connected: true,
      isHost: this.state.players.size === 0,
    });
    this.state.players.set(client.sessionId, player);
    this.bumpRevision();
    if (!this.hostId) this.hostId = client.sessionId;
    await this.updateListing();
    this.broadcast("event", { type: "joined", playerId: client.sessionId, name: auth.name });
  }

  onDrop(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.connected = false;
    this.bumpRevision();
    this.broadcast("event", { type: "disconnected", playerId: client.sessionId, graceSeconds: 60 });
    this.allowReconnection(client, 60);
  }

  onReconnect(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = true;
      this.bumpRevision();
    }
    this.broadcast("event", { type: "reconnected", playerId: client.sessionId });
    this.sendKnowledge(client.sessionId);
  }

  async onLeave(client: Client): Promise<void> {
    if (this.state.phase === "LOBBY") {
      this.state.players.delete(client.sessionId);
      if (this.hostId === client.sessionId) this.transferHost();
      this.bumpRevision();
      await this.updateListing();
      return;
    }
    if (this.engine) {
      this.dispatch(this.engine.forfeit(client.sessionId));
      this.sendAllKnowledge();
      this.syncFromEngine();
      this.startNextRoundIfReady();
    }
  }

  private handleCommand(client: Client, rawPayload: unknown): void {
    const parsed = clientCommandSchema.safeParse(normalizeLegacyClientCommand(rawPayload));
    if (!parsed.success) {
      this.sendError(client, "INVALID_COMMAND", parsed.error.issues[0]?.message ?? "Invalid command.");
      return;
    }
    try {
      this.runCommand(client, parsed.data);
    } catch (error) {
      if (error instanceof GameRuleError) {
        this.sendError(client, error.code, error.message);
      } else {
        this.sendError(client, "INVALID_COMMAND", error instanceof Error ? error.message : "Command failed.");
      }
    }
  }

  private handleAgentCommand(client: Client, rawPayload: unknown): void {
    const parsed = agentCommandRequestSchema.safeParse(rawPayload);
    const id = typeof (rawPayload as { id?: unknown } | null)?.id === "string"
      ? (rawPayload as { id: string }).id
      : "";
    if (!parsed.success) {
      this.sendAgentResult(client, {
        id,
        ok: false,
        revision: this.state.revision,
        error: { code: "INVALID_COMMAND", message: parsed.error.issues[0]?.message ?? "Invalid command." },
      });
      return;
    }
    try {
      this.runCommand(client, parsed.data.command);
      this.sendAgentResult(client, { id: parsed.data.id, ok: true, revision: this.state.revision });
    } catch (error) {
      const payload: ErrorMessage = error instanceof GameRuleError
        ? { code: error.code, message: error.message }
        : { code: "INVALID_COMMAND", message: error instanceof Error ? error.message : "Command failed." };
      this.sendAgentResult(client, { id: parsed.data.id, ok: false, revision: this.state.revision, error: payload });
    }
  }

  private runCommand(client: Client, command: ClientCommand): void {
    if (command.type === "start") {
      this.startGame(client);
      return;
    }
    if (command.type === "leave") {
      if (this.engine) this.dispatch(this.engine.forfeit(client.sessionId));
      this.sendAllKnowledge();
      this.syncFromEngine();
      this.startNextRoundIfReady();
      return;
    }
    if (!this.engine) throw new GameRuleError("INVALID_PHASE", "The game has not started.");

    if (command.type === "ready-next-round") {
      this.readyNextRound(client.sessionId);
      return;
    }

    let events: EngineEvent[];
    const discardBefore = this.engine.getSnapshot().discardTop;
    const pendingDraw = this.engine.getPendingDraw();
    switch (command.type) {
      case "draw-deck":
        events = this.engine.drawDeck(client.sessionId);
        break;
      case "draw-discard":
        events = this.engine.drawDiscard(client.sessionId);
        break;
      case "replace":
        events = this.engine.replaceHeld(client.sessionId, command.positions as Position[], command.replacementPosition as Position);
        break;
      case "resolve-mismatch":
        events = this.engine.resolveMismatch(client.sessionId, command.drawnPlacement, command.penaltyPlacement);
        break;
      case "discard":
        events = this.engine.discardHeld(client.sessionId);
        break;
      case "peek-self":
        events = this.engine.peekSelf(client.sessionId, command.position as Position);
        break;
      case "peek-other":
        events = this.engine.peekOther(client.sessionId, command.targetPlayerId, command.position as Position);
        break;
      case "swap":
        events = this.engine.swap(client.sessionId, command.targetPlayerId, command.position as Position);
        break;
      case "skip":
        events = this.engine.skipPower(client.sessionId);
        break;
      case "cabo":
        events = this.engine.callCabo(client.sessionId);
        break;
      default:
        throw new GameRuleError("INVALID_COMMAND", "Unsupported command.");
    }
    const action = publicAction(command, client.sessionId, events, discardBefore as Card | undefined, pendingDraw);
    if (action) {
      this.knowledge.applyAction(action);
      this.broadcast("event", action);
    }
    this.dispatch(events, command);
    this.sendAllKnowledge();
    this.syncFromEngine();
  }

  private startGame(client: Client): void {
    if (client.sessionId !== this.hostId) throw new GameRuleError("NOT_HOST", "Only the host can start the game.");
    const connectedPlayers = [...this.state.players.values()].filter((player) => player.connected && !player.forfeited);
    if (connectedPlayers.length < 2) throw new GameRuleError("NOT_ENOUGH_PLAYERS", "At least two connected players are required.");
    if (this.state.phase !== "LOBBY") throw new GameRuleError("INVALID_PHASE", "The game has already started.");
    this.engine = new GameEngine({
      players: [...this.state.players.values()].sort((a, b) => a.seat - b.seat).map((player) => ({ id: player.id, name: player.name })),
      targetScore: this.targetScore,
    });
    void this.lock();
    void this.setPrivate(true);
    const events = this.engine.startMatch();
    const snapshot = this.engine.getSnapshot();
    this.knowledge.reset(snapshot.round, snapshot.players.filter((player) => !player.forfeited).map((player) => player.id));
    this.dispatch(events);
    this.sendAllKnowledge();
    this.syncFromEngine();
  }

  private dispatch(events: EngineEvent[], command?: ClientCommand): void {
    for (const event of events) {
      if (event.type === "private-reveal") {
        this.knowledge.applyPrivateReveal(event, command);
        this.clients.find((client) => client.sessionId === event.playerId)?.send("reveal", {
          card: event.card,
          ...(event.position ? { position: event.position } : {}),
          reason: event.reason,
        });
      } else if (event.type !== "exchange-mismatch" && event.type !== "mismatch-resolved") {
        if (event.type === "forfeit") this.knowledge.removePlayer(event.playerId);
        this.broadcast("event", event);
      }
    }
  }

  private readyNextRound(playerId: string): void {
    if (!this.engine || this.engine.phase !== "ROUND_RESULT") {
      throw new GameRuleError("INVALID_PHASE", "The next round is not waiting for confirmations.");
    }
    const player = this.state.players.get(playerId);
    if (!player || player.forfeited) throw new GameRuleError("INVALID_TARGET", "Only active players can confirm the next round.");
    if (player.nextRoundReady) return;
    player.nextRoundReady = true;
    this.bumpRevision();
    this.startNextRoundIfReady();
  }

  private startNextRoundIfReady(): void {
    if (!this.engine || this.engine.phase !== "ROUND_RESULT") return;
    const activePlayers = [...this.state.players.values()].filter((player) => !player.forfeited);
    if (activePlayers.length === 0 || activePlayers.some((player) => !player.nextRoundReady)) return;
    for (const player of this.state.players.values()) player.nextRoundReady = false;
    const nextEvents = this.engine.startNextRound();
    const snapshot = this.engine.getSnapshot();
    this.knowledge.reset(snapshot.round, snapshot.players.filter((player) => !player.forfeited).map((player) => player.id));
    this.dispatch(nextEvents);
    this.sendAllKnowledge();
    this.syncFromEngine();
  }

  private sendKnowledge(playerId: string): void {
    const snapshot = this.knowledge.snapshot(playerId);
    if (!snapshot) return;
    this.clients.find((client) => client.sessionId === playerId)?.send("knowledge", snapshot);
  }

  private sendAllKnowledge(): void {
    for (const client of this.clients) this.sendKnowledge(client.sessionId);
  }

  private syncFromEngine(): void {
    if (!this.engine) return;
    const snapshot = this.engine.getSnapshot();
    this.state.phase = snapshot.phase;
    this.state.round = snapshot.round;
    this.state.currentPlayerId = snapshot.currentPlayerId ?? "";
    this.state.caboCallerId = snapshot.caboCallerId ?? "";
    this.state.drawSource = snapshot.drawSource ?? "";
    this.state.mismatchPenaltyCardPending = snapshot.mismatchPenaltyCardPending;
    this.state.discardLabel = snapshot.discardTop?.label ?? "";
    this.state.discardRank = snapshot.discardTop?.rank ?? -1;
    this.state.deckCount = snapshot.deckCount;
    this.state.winners.clear();
    for (const winner of snapshot.winners) this.state.winners.push(winner);
    for (const publicPlayer of snapshot.players) {
      const statePlayer = this.state.players.get(publicPlayer.id);
      if (!statePlayer) continue;
      statePlayer.score = publicPlayer.score;
      statePlayer.forfeited = publicPlayer.forfeited;
      statePlayer.cardCount = publicPlayer.cardCount;
    }
    this.bumpRevision();
    void this.updateListing();
  }

  private bumpRevision(): void {
    // revision 是 Agent 的状态屏障：动作回执只能引用已经提交到 Schema 的版本。
    this.state.revision += 1;
  }

  private transferHost(): void {
    const next = [...this.state.players.values()].sort((a, b) => a.seat - b.seat)[0];
    this.hostId = next?.id ?? "";
    for (const player of this.state.players.values()) player.isHost = player.id === this.hostId;
  }

  private async updateListing(): Promise<void> {
    await this.setMetadata({
      visibility: this.visibility,
      roomName: this.state.roomName,
      phase: this.state.phase,
      targetScore: this.targetScore,
      playerCount: this.state.players.size,
      maxClients: this.maxClients,
    });
  }

  private hashPassword(password: string): Buffer {
    return createHash("sha256").update(`${this.roomId}:${password}`).digest();
  }

  private passwordMatches(password: string | undefined): boolean {
    if (!this.passwordHash || !password) return false;
    const candidate = this.hashPassword(password);
    return candidate.length === this.passwordHash.length && timingSafeEqual(candidate, this.passwordHash);
  }

  private sendError(client: Client, code: string, message: string): void {
    const payload: ErrorMessage = { code, message };
    client.send("error", payload);
  }

  private sendAgentResult(client: Client, payload: AgentCommandResult): void {
    client.send("agent-result", payload);
  }
}

function normalizeLegacyClientCommand(rawPayload: unknown): unknown {
  if (typeof rawPayload !== "object" || rawPayload === null) return rawPayload;
  const command = rawPayload as { type?: unknown; positions?: unknown; replacementPosition?: unknown };
  if (command.type !== "replace" || command.replacementPosition !== undefined || !Array.isArray(command.positions)) return rawPayload;
  const [firstPosition] = command.positions;
  if (typeof firstPosition !== "number") return rawPayload;
  return { ...command, replacementPosition: firstPosition };
}
