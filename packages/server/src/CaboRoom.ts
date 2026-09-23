import { createHash, timingSafeEqual } from "node:crypto";
import {
  agentCommandRequestSchema,
  clientCommandSchema,
  GameEngine,
  GameRuleError,
  joinOptionsSchema,
  PrivateKnowledgeStore,
  publicAction,
  roomChatInputSchema,
  roomOptionsSchema,
  type ClientCommand,
  type AgentCommandResult,
  type Card,
  type EngineEvent,
  type ErrorMessage,
  type Position,
  type RoomChatMessage,
  type MemoryMode,
  type TurnDurationSeconds,
} from "@cabo-game/shared";
import { type Client, Room } from "colyseus";
import { CaboState, PlayerState, RoundHistoryCardState, RoundHistoryEntryState, RoundHistoryPlayerState } from "./state.js";

interface RoomMetadata {
  memoryMode: MemoryMode;
  turnDurationSeconds: TurnDurationSeconds;
  deadlineAt: number;
  serverTime: number;
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
  private memoryMode: MemoryMode = "classic";
  private turnDurationSeconds: TurnDurationSeconds = 60;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private timerGeneration = 0;
  private timingKey = "";
  private readonly knowledge = new PrivateKnowledgeStore();
  private chatSequence = 0;
  private readonly chatBuckets = new Map<string, { tokens: number; updatedAt: number }>();

  messages = {
    command: (client: Client, payload: unknown) => this.handleCommand(client, payload),
    "agent-command": (client: Client, payload: unknown) => this.handleAgentCommand(client, payload),
    chat: (client: Client, payload: unknown) => this.handleChat(client, payload),
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
    this.memoryMode = options.memoryMode;
    this.turnDurationSeconds = options.turnDurationSeconds;
    this.state.memoryMode = this.memoryMode;
    this.state.turnDurationSeconds = this.turnDurationSeconds;
    this.state.serverTime = Date.now();
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
    this.chatBuckets.delete(client.sessionId);
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
    const parsed = clientCommandSchema.safeParse(rawPayload);
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

  private handleChat(client: Client, rawPayload: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) {
      this.sendError(client, "INVALID_CHAT_MESSAGE", "Only seated players can send room chat messages.");
      return;
    }
    const parsed = roomChatInputSchema.safeParse(rawPayload);
    if (!parsed.success) {
      this.sendError(client, "INVALID_CHAT_MESSAGE", parsed.error.issues[0]?.message ?? "Invalid chat message.");
      return;
    }
    if (!this.takeChatToken(client.sessionId)) {
      this.sendError(client, "CHAT_RATE_LIMITED", "You are sending messages too quickly. Try again in a moment.");
      return;
    }
    const message: RoomChatMessage = {
      sequence: ++this.chatSequence,
      playerId: player.id,
      playerName: player.name,
      text: parsed.data.text,
      sentAt: Date.now(),
    };
    this.broadcast("chat", message);
  }

  private takeChatToken(sessionId: string): boolean {
    const now = Date.now();
    const previous = this.chatBuckets.get(sessionId);
    const tokens = previous ? Math.min(3, previous.tokens + Math.max(0, now - previous.updatedAt) / 1_000) : 3;
    if (tokens < 1) {
      this.chatBuckets.set(sessionId, { tokens, updatedAt: now });
      return false;
    }
    this.chatBuckets.set(sessionId, { tokens: tokens - 1, updatedAt: now });
    return true;
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
    // Resolve an elapsed deadline before accepting a late network command.
    if (this.state.deadlineAt && Date.now() >= this.state.deadlineAt) {
      this.handleDeadline(this.timerGeneration);
      throw new GameRuleError("INVALID_PHASE", "The deadline passed; refresh the current action.");
    }
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

    this.applyGameCommand(client.sessionId, command);
  }

  private applyGameCommand(playerId: string, command: ClientCommand): void {
    if (!this.engine) throw new GameRuleError("INVALID_PHASE", "The game has not started.");
    let events: EngineEvent[];
    const discardBefore = this.engine.getSnapshot().discardTop;
    const pendingDraw = this.engine.getPendingDraw();
    switch (command.type) {
      case "draw-deck":
        events = this.engine.drawDeck(playerId);
        break;
      case "draw-discard":
        events = this.engine.drawDiscard(playerId);
        break;
      case "replace":
        events = this.engine.replaceHeld(playerId, command.positions as Position[], command.replacementPosition as Position);
        break;
      case "resolve-mismatch":
        events = this.engine.resolveMismatch(playerId, command.drawnPlacement, command.penaltyPlacement);
        break;
      case "discard":
        events = this.engine.discardHeld(playerId);
        break;
      case "peek-self":
        events = this.engine.peekSelf(playerId, command.position as Position);
        break;
      case "peek-other":
        events = this.engine.peekOther(playerId, command.targetPlayerId, command.position as Position);
        break;
      case "swap":
        events = this.engine.swap(playerId, command.targetPlayerId, command.ownPosition, command.targetPosition);
        break;
      case "skip":
        events = this.engine.skipPower(playerId);
        break;
      case "cabo":
        events = this.engine.callCabo(playerId);
        break;
      default:
        throw new GameRuleError("INVALID_COMMAND", "Unsupported command.");
    }
    const action = publicAction(command, playerId, events, discardBefore as Card | undefined, pendingDraw);
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
    this.knowledge.reset(snapshot.round, snapshot.players.filter((player) => !player.forfeited).map((player) => player.id), this.memoryMode);
    this.dispatch(events);
    this.sendAllKnowledge();
    this.syncFromEngine();
  }

  private dispatch(events: EngineEvent[], command?: ClientCommand): void {
    for (const event of events) {
      if (event.type === "private-reveal") {
        this.knowledge.applyPrivateReveal(event, command);
        this.clients.find((client) => client.sessionId === event.playerId)?.send("reveal", {
          round: this.engine?.round ?? this.state.round,
          memoryMode: this.memoryMode,
          ownerId: command?.type === "peek-other" ? command.targetPlayerId : event.playerId,
          card: event.card,
          ...(event.position ? { position: event.position } : {}),
          reason: event.reason,
        });
      } else if (event.type !== "exchange-mismatch" && event.type !== "mismatch-resolved") {
        if (event.type === "forfeit") this.knowledge.removePlayer(event.playerId);
        if (event.type === "round-result") this.recordRoundResult(event);
        this.broadcast("event", event);
      }
    }
  }

  private recordRoundResult(event: Extract<EngineEvent, { type: "round-result" }>): void {
    if (this.state.roundHistory.some((entry) => entry.round === this.engine?.round)) return;
    const outcomeType = event.outcome.type;
    const entry = new RoundHistoryEntryState().assign({
      round: this.engine?.round ?? this.state.round,
      outcomeType,
      outcomePlayerId: outcomeType === "cabo" ? event.outcome.callerId : event.outcome.playerId,
      caboSucceeded: outcomeType === "cabo" && event.outcome.succeeded,
    });
    for (const hand of event.hands) {
      const player = new RoundHistoryPlayerState().assign({
        playerId: hand.playerId,
        roundScore: event.roundScores[hand.playerId] ?? 0,
        totalScore: event.totals[hand.playerId] ?? 0,
        handScore: hand.handScore,
      });
      for (const card of hand.cards) {
        player.cards.push(new RoundHistoryCardState().assign({ label: card.label, rank: card.rank }));
      }
      entry.players.push(player);
    }
    this.state.roundHistory.push(entry);
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

  private startNextRoundIfReady(force = false): void {
    if (!this.engine || this.engine.phase !== "ROUND_RESULT") return;
    const activePlayers = [...this.state.players.values()].filter((player) => !player.forfeited);
    if (activePlayers.length === 0 || (!force && activePlayers.some((player) => !player.nextRoundReady))) return;
    for (const player of this.state.players.values()) player.nextRoundReady = false;
    const nextEvents = this.engine.startNextRound();
    const snapshot = this.engine.getSnapshot();
    this.knowledge.reset(snapshot.round, snapshot.players.filter((player) => !player.forfeited).map((player) => player.id), this.memoryMode);
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
    this.scheduleDeadline();
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
    this.state.serverTime = Date.now();
  }

  private scheduleDeadline(): void {
    const key = `${this.state.round}:${this.state.phase}:${this.state.currentPlayerId}`;
    if (key === this.timingKey) return;
    this.timingKey = key;
    this.clearDeadline();
    const duration = this.state.phase === "ROUND_RESULT" ? 20
      : ["TURN_START", "FINAL_TURNS", "DRAWN", "POWER_PENDING", "MISMATCH_PENDING"].includes(this.state.phase)
        ? this.turnDurationSeconds : 0;
    this.state.deadlineAt = duration ? Date.now() + duration * 1000 : 0;
    if (duration) {
      const generation = this.timerGeneration;
      this.deadlineTimer = setTimeout(() => this.handleDeadline(generation), duration * 1000);
      this.deadlineTimer.unref?.();
    }
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.timerGeneration += 1;
    this.state.deadlineAt = 0;
  }

  private handleDeadline(generation: number): void {
    if (generation !== this.timerGeneration || !this.engine || !this.state.deadlineAt) return;
    this.clearDeadline();
    if (this.engine.phase === "ROUND_RESULT") {
      this.startNextRoundIfReady(true);
      return;
    }
    const playerId = this.engine.currentPlayerId;
    if (!playerId) return;
    this.broadcast("event", { type: "turn-timeout", playerId, phase: this.engine.phase });
    const apply = (command: ClientCommand) => this.applyGameCommand(playerId, command);
    if (this.engine.phase === "TURN_START" || this.engine.phase === "FINAL_TURNS") {
      if (this.engine.canDrawDeck()) apply({ type: "draw-deck" });
      else if (this.engine.canDrawDiscard()) apply({ type: "draw-discard" });
      else apply({ type: this.engine.caboCallerId ? "skip" : "cabo" });
    }
    // Read the new phase after every ordinary action; never duplicate engine rules.
    if (this.engine.getSnapshot().phase === "DRAWN") {
      if (this.engine.getPendingDraw()?.source === "deck") apply({ type: "discard" });
      else apply({ type: "replace", positions: [1], replacementPosition: 1 });
    } else if (this.engine.getSnapshot().phase === "MISMATCH_PENDING") {
      apply({ type: "resolve-mismatch", drawnPlacement: "right", ...(this.state.mismatchPenaltyCardPending ? { penaltyPlacement: "right" as const } : {}) });
    }
    if (this.engine.currentPlayerId === playerId && this.engine.getSnapshot().phase === "POWER_PENDING") apply({ type: "skip" });
  }

  onDispose(): void { this.clearDeadline(); }

  private transferHost(): void {
    const next = [...this.state.players.values()].sort((a, b) => a.seat - b.seat)[0];
    this.hostId = next?.id ?? "";
    for (const player of this.state.players.values()) player.isHost = player.id === this.hostId;
  }

  private async updateListing(): Promise<void> {
    await this.setMetadata({
      memoryMode: this.memoryMode,
      turnDurationSeconds: this.turnDurationSeconds,
      deadlineAt: this.state.deadlineAt,
      serverTime: this.state.serverTime,
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
