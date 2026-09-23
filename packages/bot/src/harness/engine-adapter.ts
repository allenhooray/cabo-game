/**
 * 自对弈适配层：把 `GameEngine` 归约成与线上同构的座位视图。
 *
 * 这是整个 harness 的诚信基础。bot 在自对弈里拿到的信息必须**严格等于**
 * 它在真实服务端能拿到的信息，否则自对弈结论毫无意义。
 *
 * 具体做法：完全镜像 `CaboRoom` 的信息管线——
 *   - 位置知识走 `PrivateKnowledgeStore`（已上移到 shared，与线上同源）；
 *   - 合法动作走 `client-core` 的 `legalActions`；
 *   - 公开动作事件走 `publicAction`；
 *   - `engine.debugHand()` 在这里**不可用**，由守卫测试强制。
 */
import {
  GameEngine,
  PrivateKnowledgeStore,
  publicAction,
  seededRandom,
  type Card,
  type ClientCommand,
  type EngineEvent,
  type MemoryMode,
  type PrivateKnowledgeSnapshot,
  type PrivateRevealMessage,
  type PublicActionEvent,
  type RandomSource,
} from "@cabo-game/shared";
import { caboRisk, legalActions, type CaboStateLike, type RoundHistoryEntry, type StatePlayer } from "@cabo-game/client-core";
import type { AgentAction, AgentObservation, CaboRisk } from "@cabo-game/shared";

/**
 * 座位能收到的帧，与 JSONL 协议的 event 帧同构。
 *
 * `PrivateRevealMessage` 本身没有判别字段，协议层会把它包成
 * `{type:"private-reveal", ...}`，这里保持一致。
 */
export interface PrivateRevealEvent extends PrivateRevealMessage {
  type: "private-reveal";
}

export type SeatEvent =
  | PublicActionEvent
  | PrivateRevealEvent
  | Exclude<EngineEvent, { type: "private-reveal" }>;

export interface SeatTurn {
  observation: AgentObservation;
  /** 自上次观察以来该座位收到的事件帧。 */
  events: SeatEvent[];
}

const TURN_DURATION_SECONDS = 60;

export class SelfPlayTable {
  readonly engine: GameEngine;
  readonly playerIds: string[];
  readonly memoryMode: MemoryMode;
  readonly targetScore: number;

  private readonly knowledge = new PrivateKnowledgeStore();
  private revision = 0;
  private readonly roundHistory: RoundHistoryEntry[] = [];
  private readonly pending = new Map<string, SeatEvent[]>();

  constructor(options: {
    playerIds: string[];
    targetScore?: number;
    memoryMode?: MemoryMode;
    seed?: number;
    random?: RandomSource;
  }) {
    this.playerIds = [...options.playerIds];
    this.targetScore = options.targetScore ?? 100;
    this.memoryMode = options.memoryMode ?? "assisted";
    const random = options.random ?? seededRandom(options.seed ?? 1);
    this.engine = new GameEngine({
      players: this.playerIds.map((id) => ({ id, name: id })),
      targetScore: this.targetScore,
      random,
    });
    for (const id of this.playerIds) this.pending.set(id, []);
  }

  get phase(): string {
    return this.engine.phase;
  }

  get currentPlayerId(): string | undefined {
    return this.engine.currentPlayerId;
  }

  start(): void {
    const events = this.engine.startMatch();
    this.resetKnowledge();
    this.dispatch(events);
    this.revision += 1;
  }

  /** 推进到下一轮（仅 `ROUND_RESULT` 阶段）。 */
  nextRound(): void {
    const events = this.engine.startNextRound();
    this.resetKnowledge();
    this.dispatch(events);
    this.revision += 1;
  }

  /** 取走某个座位当前应处理的帧。事件先于观察到达，与线上一致。 */
  takeTurn(seatId: string): SeatTurn {
    const events = this.pending.get(seatId) ?? [];
    this.pending.set(seatId, []);
    return { observation: this.observationFor(seatId), events };
  }

  observationFor(seatId: string): AgentObservation {
    const snapshot = this.engine.getSnapshot();
    const state = this.stateLike(snapshot.phase);
    const knowledge = this.knowledge.snapshot(seatId) ?? emptySnapshot(this.memoryMode, snapshot.round);
    return {
      roomId: "selfplay",
      roomName: "Self-play",
      selfId: seatId,
      revision: this.revision,
      state: {
        memoryMode: this.memoryMode,
        turnDurationSeconds: TURN_DURATION_SECONDS,
        deadlineAt: 0,
        serverTime: 0,
        phase: snapshot.phase,
        round: snapshot.round,
        targetScore: snapshot.targetScore,
        currentPlayerId: snapshot.currentPlayerId ?? null,
        caboCallerId: snapshot.caboCallerId ?? null,
        drawSource: snapshot.drawSource ?? null,
        mismatchPenaltyCardPending: snapshot.mismatchPenaltyCardPending,
        discardTop: snapshot.discardTop ? { label: snapshot.discardTop.label, rank: snapshot.discardTop.rank } : null,
        deckCount: snapshot.deckCount,
        players: snapshot.players.map((player) => ({
          id: player.id,
          name: player.name,
          seat: player.seat,
          score: player.score,
          connected: true,
          forfeited: player.forfeited,
          nextRoundReady: false,
          cardCount: player.cardCount,
          isHost: player.seat === 0,
        })),
        winners: [...snapshot.winners],
        roundHistory: this.roundHistory.map(cloneHistoryEntry),
      },
      knowledge,
      legalActions: legalActions(state, seatId) as AgentObservation["legalActions"],
      caboRisk: caboRisk(state, seatId, knowledge) as CaboRisk | null,
    };
  }

  /** 执行一个座位提交的动作。返回错误信息表示该动作非法。 */
  apply(seatId: string, action: AgentAction): { ok: true } | { ok: false; error: string } {
    const command = action as ClientCommand;
    const discardBefore = this.engine.getSnapshot().discardTop;
    const pendingDraw = this.engine.getPendingDraw();
    let events: EngineEvent[];
    try {
      events = this.runCommand(seatId, command);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    const publicEvent = publicAction(command, seatId, events, discardBefore as Card | undefined, pendingDraw);
    if (publicEvent) {
      this.knowledge.applyAction(publicEvent);
      this.broadcast(publicEvent);
    }
    this.dispatch(events, command);
    this.revision += 1;
    return { ok: true };
  }

  forfeit(seatId: string): void {
    this.dispatch(this.engine.forfeit(seatId));
    this.knowledge.removePlayer(seatId);
    this.revision += 1;
  }

  private runCommand(playerId: string, command: ClientCommand): EngineEvent[] {
    switch (command.type) {
      case "start": return this.engine.startMatch();
      case "draw-deck": return this.engine.drawDeck(playerId);
      case "draw-discard": return this.engine.drawDiscard(playerId);
      case "replace": return this.engine.replaceHeld(playerId, command.positions, command.replacementPosition);
      case "resolve-mismatch": return this.engine.resolveMismatch(playerId, command.drawnPlacement, command.penaltyPlacement);
      case "discard": return this.engine.discardHeld(playerId);
      case "peek-self": return this.engine.peekSelf(playerId, command.position);
      case "peek-other": return this.engine.peekOther(playerId, command.targetPlayerId, command.position);
      case "swap": return this.engine.swap(playerId, command.targetPlayerId, command.ownPosition, command.targetPosition);
      case "skip": return this.engine.skipPower(playerId);
      case "cabo": return this.engine.callCabo(playerId);
      case "ready-next-round": return [];
      case "leave": return this.engine.forfeit(playerId);
      default: throw new Error(`Unsupported command: ${(command as { type: string }).type}`);
    }
  }

  /** 镜像 `CaboRoom.dispatch`：私密揭示点对点投递，其余事件广播。 */
  private dispatch(events: EngineEvent[], command?: ClientCommand): void {
    for (const event of events) {
      if (event.type === "private-reveal") {
        this.knowledge.applyPrivateReveal(event, command);
        this.push(event.playerId, {
          type: "private-reveal",
          round: this.engine.round,
          memoryMode: this.memoryMode,
          ownerId: command?.type === "peek-other" ? command.targetPlayerId : event.playerId,
          card: event.card,
          ...(event.position !== undefined ? { position: event.position } : {}),
          reason: event.reason,
        });
        continue;
      }
      if (event.type === "exchange-mismatch" || event.type === "mismatch-resolved") continue;
      if (event.type === "forfeit") this.knowledge.removePlayer(event.playerId);
      if (event.type === "round-result") this.recordRoundResult(event);
      this.broadcast(event as unknown as SeatEvent);
    }
  }

  private recordRoundResult(event: Extract<EngineEvent, { type: "round-result" }>): void {
    if (this.roundHistory.some((entry) => entry.round === this.engine.round)) return;
    const outcomeType = event.outcome.type;
    this.roundHistory.push({
      round: this.engine.round,
      outcomeType,
      outcomePlayerId: outcomeType === "cabo" ? event.outcome.callerId : event.outcome.playerId,
      caboSucceeded: outcomeType === "cabo" && event.outcome.succeeded,
      players: event.hands.map((hand) => ({
        playerId: hand.playerId,
        roundScore: event.roundScores[hand.playerId] ?? 0,
        totalScore: event.totals[hand.playerId] ?? 0,
        handScore: hand.handScore,
        cards: hand.cards.map((card) => ({ label: card.label, rank: card.rank })),
      })),
    });
  }

  private broadcast(event: SeatEvent): void {
    for (const id of this.playerIds) this.push(id, event);
  }

  private push(seatId: string, event: SeatEvent): void {
    const queue = this.pending.get(seatId);
    if (queue) queue.push(event);
  }

  private resetKnowledge(): void {
    const snapshot = this.engine.getSnapshot();
    this.knowledge.reset(
      snapshot.round,
      snapshot.players.filter((player) => !player.forfeited).map((player) => player.id),
      this.memoryMode,
    );
  }

  /** 构造 `CaboStateLike`，复用 client-core 的 legalActions / caboRisk。 */
  private stateLike(phase: string): CaboStateLike {
    const snapshot = this.engine.getSnapshot();
    const players = new Map<string, StatePlayer>();
    for (const player of snapshot.players) {
      players.set(player.id, {
        id: player.id,
        name: player.name,
        seat: player.seat,
        score: player.score,
        connected: true,
        forfeited: player.forfeited,
        nextRoundReady: false,
        cardCount: player.cardCount,
        isHost: player.seat === 0,
      });
    }
    return {
      memoryMode: this.memoryMode,
      turnDurationSeconds: TURN_DURATION_SECONDS,
      deadlineAt: 0,
      serverTime: 0,
      revision: this.revision,
      roomName: "Self-play",
      phase: phase as CaboStateLike["phase"],
      round: snapshot.round,
      targetScore: snapshot.targetScore,
      currentPlayerId: snapshot.currentPlayerId ?? "",
      caboCallerId: snapshot.caboCallerId ?? "",
      drawSource: snapshot.drawSource ?? "",
      mismatchPenaltyCardPending: snapshot.mismatchPenaltyCardPending,
      discardLabel: snapshot.discardTop?.label ?? "",
      discardRank: snapshot.discardTop?.rank ?? -1,
      deckCount: snapshot.deckCount,
      players,
      winners: [...snapshot.winners],
      roundHistory: this.roundHistory.map(cloneHistoryEntry),
    };
  }
}

function emptySnapshot(memoryMode: MemoryMode, round: number): PrivateKnowledgeSnapshot {
  return { memoryMode, round, slots: [], opponents: [], held: null };
}

function cloneHistoryEntry(entry: RoundHistoryEntry): RoundHistoryEntry {
  return { ...entry, players: entry.players.map((player) => ({ ...player, cards: player.cards.map((card) => ({ ...card })) })) };
}
