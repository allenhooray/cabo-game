import { createDeck, shuffle, type RandomSource } from "./deck.js";
import {
  GameRuleError,
  type Card,
  type EngineEvent,
  type EnginePlayer,
  type GamePhase,
  type Position,
  type PublicGameSnapshot,
} from "./types.js";

export interface GameEngineOptions {
  players: Array<{ id: string; name: string }>;
  targetScore: number;
  random?: RandomSource;
}

export class GameEngine {
  readonly players: EnginePlayer[];
  readonly targetScore: number;
  phase: GamePhase = "LOBBY";
  round = 0;
  currentPlayerId: string | undefined = undefined;
  caboCallerId: string | undefined = undefined;
  winners: string[] = [];

  private readonly random: RandomSource;
  private deck: Card[] = [];
  private discardPile: Card[] = [];
  private heldCard: Card | undefined = undefined;
  private pendingPower: number | undefined = undefined;
  private finalTurns: string[] = [];
  private roundStarterSeat = 0;

  constructor(options: GameEngineOptions) {
    if (options.players.length < 2 || options.players.length > 4) {
      throw new GameRuleError("INVALID_COMMAND", "A game requires 2 to 4 players.");
    }
    if (!Number.isInteger(options.targetScore) || options.targetScore < 20 || options.targetScore > 500) {
      throw new GameRuleError("INVALID_COMMAND", "Target score must be an integer from 20 to 500.");
    }
    this.players = options.players.map((player, seat) => ({ ...player, seat, score: 0, forfeited: false, hand: [] }));
    this.targetScore = options.targetScore;
    this.random = options.random ?? Math.random;
  }

  startMatch(): EngineEvent[] {
    this.assertPhase("LOBBY");
    this.roundStarterSeat = Math.floor(this.random() * this.players.length);
    return this.startRound();
  }

  startNextRound(): EngineEvent[] {
    this.assertPhase("ROUND_RESULT");
    this.roundStarterSeat = this.nextActiveSeat(this.roundStarterSeat);
    return this.startRound();
  }

  drawDeck(playerId: string): EngineEvent[] {
    this.assertTurnStart(playerId);
    this.ensureDeck();
    const drawn = this.deck.pop();
    if (!drawn) throw new GameRuleError("INVALID_COMMAND", "The deck is empty.");
    this.heldCard = drawn;
    this.phase = "DRAWN";
    return [{ type: "private-reveal", playerId, card: drawn, reason: "draw" }];
  }

  drawDiscard(playerId: string, position: Position): EngineEvent[] {
    this.assertTurnStart(playerId);
    const player = this.player(playerId);
    const drawn = this.discardPile.pop();
    if (!drawn) throw new GameRuleError("INVALID_COMMAND", "The discard pile is empty.");
    const replaced = player.hand[position - 1];
    if (!replaced) throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    player.hand[position - 1] = drawn;
    this.discardPile.push(replaced);
    return [{ type: "discard", playerId, card: replaced }, ...this.finishTurn()];
  }

  replaceHeld(playerId: string, position: Position): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("DRAWN");
    const player = this.player(playerId);
    const replaced = player.hand[position - 1];
    if (!replaced || !this.heldCard) throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    player.hand[position - 1] = this.heldCard;
    this.heldCard = undefined;
    this.discardPile.push(replaced);
    return [{ type: "discard", playerId, card: replaced }, ...this.finishTurn()];
  }

  discardHeld(playerId: string): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("DRAWN");
    if (!this.heldCard) throw new GameRuleError("INVALID_COMMAND", "There is no drawn card to discard.");
    const card = this.heldCard;
    this.heldCard = undefined;
    this.discardPile.push(card);
    if (card.rank >= 7 && card.rank <= 12) {
      this.pendingPower = card.rank;
      this.phase = "POWER_PENDING";
      return [{ type: "discard", playerId, card }];
    }
    return [{ type: "discard", playerId, card }, ...this.finishTurn()];
  }

  peekSelf(playerId: string, position: Position): EngineEvent[] {
    this.assertPower(playerId, [7, 8]);
    const card = this.cardAt(playerId, position);
    this.pendingPower = undefined;
    return [{ type: "private-reveal", playerId, card, position, reason: "peek" }, ...this.finishTurn()];
  }

  peekOther(playerId: string, targetPlayerId: string, position: Position): EngineEvent[] {
    this.assertPower(playerId, [9, 10]);
    this.assertOtherActive(playerId, targetPlayerId);
    const card = this.cardAt(targetPlayerId, position);
    this.pendingPower = undefined;
    return [{ type: "private-reveal", playerId, card, position, reason: "peek" }, ...this.finishTurn()];
  }

  swap(playerId: string, targetPlayerId: string, position: Position): EngineEvent[] {
    this.assertPower(playerId, [11, 12]);
    this.assertOtherActive(playerId, targetPlayerId);
    const player = this.player(playerId);
    const target = this.player(targetPlayerId);
    const own = player.hand[position - 1];
    const other = target.hand[position - 1];
    if (!own || !other) throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    player.hand[position - 1] = other;
    target.hand[position - 1] = own;
    this.pendingPower = undefined;
    return [{ type: "swap", playerId, targetPlayerId, position }, ...this.finishTurn()];
  }

  skipPower(playerId: string): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("POWER_PENDING");
    this.pendingPower = undefined;
    return this.finishTurn();
  }

  callCabo(playerId: string): EngineEvent[] {
    this.assertTurnStart(playerId);
    if (this.caboCallerId) throw new GameRuleError("INVALID_PHASE", "Cabo has already been called.");
    this.caboCallerId = playerId;
    this.finalTurns = this.activeIdsAfter(playerId);
    const events: EngineEvent[] = [{ type: "cabo", playerId }];
    if (this.finalTurns.length === 0) return [...events, ...this.scoreRound()];
    this.phase = "FINAL_TURNS";
    this.currentPlayerId = this.finalTurns[0];
    events.push({ type: "turn", playerId: this.currentPlayerId as string, finalTurn: true });
    return events;
  }

  forfeit(playerId: string): EngineEvent[] {
    const player = this.player(playerId);
    if (player.forfeited) return [];
    player.forfeited = true;
    player.hand = [];
    const events: EngineEvent[] = [{ type: "forfeit", playerId }];
    const active = this.activePlayers();
    if (active.length <= 1) {
      this.phase = "MATCH_RESULT";
      this.winners = active.map((entry) => entry.id);
      this.currentPlayerId = undefined;
      events.push({ type: "match-result", winners: this.winners, totals: this.totals() });
      return events;
    }

    const wasCurrent = this.currentPlayerId === playerId;
    this.finalTurns = this.finalTurns.filter((id) => id !== playerId);
    if (wasCurrent) {
      this.heldCard = undefined;
      this.pendingPower = undefined;
      if (this.caboCallerId) {
        if (this.finalTurns.length === 0) return [...events, ...this.scoreRound()];
        this.currentPlayerId = this.finalTurns[0];
        this.phase = "FINAL_TURNS";
        events.push({ type: "turn", playerId: this.currentPlayerId as string, finalTurn: true });
      } else {
        this.currentPlayerId = this.players[this.nextActiveSeat(player.seat)]?.id;
        this.phase = "TURN_START";
        events.push({ type: "turn", playerId: this.currentPlayerId as string, finalTurn: false });
      }
    }
    return events;
  }

  getSnapshot(): PublicGameSnapshot {
    return {
      phase: this.phase,
      round: this.round,
      targetScore: this.targetScore,
      ...(this.currentPlayerId ? { currentPlayerId: this.currentPlayerId } : {}),
      ...(this.caboCallerId ? { caboCallerId: this.caboCallerId } : {}),
      ...(this.discardPile.at(-1) ? { discardTop: this.discardPile.at(-1) as Card } : {}),
      deckCount: this.deck.length,
      players: this.players.map(({ id, name, seat, score, forfeited, hand }) => ({
        id,
        name,
        seat,
        score,
        forfeited,
        cardCount: hand.length,
      })),
      winners: [...this.winners],
    };
  }

  debugHand(playerId: string): readonly Card[] {
    return [...this.player(playerId).hand];
  }

  private startRound(): EngineEvent[] {
    this.round += 1;
    this.phase = "INITIAL_REVEAL";
    this.caboCallerId = undefined;
    this.finalTurns = [];
    this.heldCard = undefined;
    this.pendingPower = undefined;
    this.deck = shuffle(createDeck(), this.random);
    this.discardPile = [];

    for (const player of this.activePlayers()) {
      player.hand = [];
      for (let index = 0; index < 4; index += 1) {
        const card = this.deck.pop();
        if (card) player.hand.push(card);
      }
    }
    const firstDiscard = this.deck.pop();
    if (firstDiscard) this.discardPile.push(firstDiscard);

    const events: EngineEvent[] = [];
    for (const player of this.activePlayers()) {
      for (const position of [1, 2] as const) {
        events.push({ type: "private-reveal", playerId: player.id, card: this.cardAt(player.id, position), position, reason: "initial" });
      }
    }
    const starter = this.players[this.nextActiveSeat(this.roundStarterSeat - 1)];
    this.currentPlayerId = starter?.id;
    this.phase = "TURN_START";
    if (this.currentPlayerId) events.push({ type: "turn", playerId: this.currentPlayerId, finalTurn: false });
    return events;
  }

  private finishTurn(): EngineEvent[] {
    this.phase = "TURN_END";
    if (this.caboCallerId) {
      if (this.finalTurns[0] === this.currentPlayerId) this.finalTurns.shift();
      if (this.finalTurns.length === 0) return this.scoreRound();
      this.currentPlayerId = this.finalTurns[0];
      this.phase = "FINAL_TURNS";
      return [{ type: "turn", playerId: this.currentPlayerId as string, finalTurn: true }];
    }
    const current = this.player(this.currentPlayerId as string);
    this.currentPlayerId = this.players[this.nextActiveSeat(current.seat)]?.id;
    this.phase = "TURN_START";
    return [{ type: "turn", playerId: this.currentPlayerId as string, finalTurn: false }];
  }

  private scoreRound(): EngineEvent[] {
    const active = this.activePlayers();
    const handScores = new Map(active.map((player) => [player.id, player.hand.reduce((sum, card) => sum + card.rank, 0)]));
    const caller = this.caboCallerId ? active.find((player) => player.id === this.caboCallerId) : undefined;
    const callerScore = caller ? (handScores.get(caller.id) as number) : undefined;
    const caboSucceeded = Boolean(
      caller && [...handScores.entries()].every(([id, score]) => id === caller.id || (callerScore as number) < score),
    );
    const roundScores: Record<string, number> = {};
    for (const player of active) {
      const handScore = handScores.get(player.id) as number;
      const score = player.id === caller?.id ? (caboSucceeded ? 0 : handScore + 5) : handScore;
      player.score += score;
      roundScores[player.id] = score;
    }
    const totals = this.totals();
    const result: EngineEvent = {
      type: "round-result",
      hands: active.map((player) => ({ playerId: player.id, cards: [...player.hand], handScore: handScores.get(player.id) as number })),
      roundScores,
      totals,
      caboSucceeded,
    };
    this.currentPlayerId = undefined;
    if (active.some((player) => player.score >= this.targetScore)) {
      const minimum = Math.min(...active.map((player) => player.score));
      this.winners = active.filter((player) => player.score === minimum).map((player) => player.id);
      this.phase = "MATCH_RESULT";
      return [result, { type: "match-result", winners: this.winners, totals }];
    }
    this.phase = "ROUND_RESULT";
    return [result];
  }

  private ensureDeck(): void {
    if (this.deck.length > 0) return;
    const top = this.discardPile.pop();
    if (!top) return;
    this.deck = shuffle(this.discardPile, this.random);
    this.discardPile = [top];
  }

  private assertTurnStart(playerId: string): void {
    this.assertCurrent(playerId);
    if (this.phase !== "TURN_START" && this.phase !== "FINAL_TURNS") {
      throw new GameRuleError("INVALID_PHASE", "This action is only allowed at the beginning of your turn.");
    }
  }

  private assertCurrent(playerId: string): void {
    if (this.currentPlayerId !== playerId) throw new GameRuleError("NOT_YOUR_TURN", "It is not your turn.");
  }

  private assertPhase(expected: GamePhase): void {
    if (this.phase !== expected) throw new GameRuleError("INVALID_PHASE", `Expected phase ${expected}, got ${this.phase}.`);
  }

  private assertPower(playerId: string, ranks: number[]): void {
    this.assertCurrent(playerId);
    this.assertPhase("POWER_PENDING");
    if (!this.pendingPower || !ranks.includes(this.pendingPower)) {
      throw new GameRuleError("INVALID_POWER", "The pending card does not have that power.");
    }
  }

  private assertOtherActive(playerId: string, targetPlayerId: string): void {
    const target = this.player(targetPlayerId);
    if (targetPlayerId === playerId || target.forfeited) {
      throw new GameRuleError("INVALID_TARGET", "Choose another active player.");
    }
  }

  private player(playerId: string): EnginePlayer {
    const player = this.players.find((entry) => entry.id === playerId);
    if (!player) throw new GameRuleError("INVALID_TARGET", "Player not found.");
    return player;
  }

  private cardAt(playerId: string, position: Position): Card {
    const card = this.player(playerId).hand[position - 1];
    if (!card) throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    return card;
  }

  private activePlayers(): EnginePlayer[] {
    return this.players.filter((player) => !player.forfeited);
  }

  private nextActiveSeat(afterSeat: number): number {
    for (let offset = 1; offset <= this.players.length; offset += 1) {
      const seat = (afterSeat + offset + this.players.length) % this.players.length;
      if (!this.players[seat]?.forfeited) return seat;
    }
    return afterSeat;
  }

  private activeIdsAfter(playerId: string): string[] {
    const player = this.player(playerId);
    const ids: string[] = [];
    for (let offset = 1; offset < this.players.length; offset += 1) {
      const candidate = this.players[(player.seat + offset) % this.players.length];
      if (candidate && !candidate.forfeited) ids.push(candidate.id);
    }
    return ids;
  }

  private totals(): Record<string, number> {
    return Object.fromEntries(this.players.map((player) => [player.id, player.score]));
  }
}
