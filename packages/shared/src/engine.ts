import { createDeck, shuffle, type RandomSource } from "./deck.js";
import {
  GameRuleError,
  type Card,
  type DrawSource,
  type EndPlacement,
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
  private heldSource: DrawSource | undefined = undefined;
  private mismatchPenaltyCard: Card | undefined = undefined;
  private pendingPower: number | undefined = undefined;
  private finalTurns: string[] = [];
  private roundStarterSeat = 0;

  constructor(options: GameEngineOptions) {
    if (options.players.length < 2 || options.players.length > 5) {
      throw new GameRuleError("INVALID_COMMAND", "A game requires 2 to 5 players.");
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
    this.heldSource = "deck";
    this.phase = "DRAWN";
    return [{ type: "private-reveal", playerId, card: drawn, reason: "draw" }];
  }

  drawDiscard(playerId: string): EngineEvent[] {
    this.assertTurnStart(playerId);
    const drawn = this.discardPile.pop();
    if (!drawn) throw new GameRuleError("INVALID_COMMAND", "The discard pile is empty.");
    this.heldCard = drawn;
    this.heldSource = "discard";
    this.phase = "DRAWN";
    return [{ type: "private-reveal", playerId, card: drawn, reason: "draw" }];
  }

  replaceHeld(playerId: string, positions: Position[], replacementPosition: Position): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("DRAWN");
    const player = this.player(playerId);
    if (!this.heldCard) throw new GameRuleError("INVALID_COMMAND", "There is no drawn card to place.");
    const normalized = this.validateExchangePositions(player, positions, replacementPosition);
    const selected = normalized.map((position) => player.hand[position - 1] as Card);
    const matches = selected.length === 1 || selected.every((card) => card.rank === selected[0]?.rank);
    if (!matches) {
      if (normalized.length >= 3) {
        this.ensureDeck();
        const penalty = this.deck.pop();
        if (!penalty) throw new GameRuleError("INVALID_COMMAND", "No card is available for the mismatch penalty.");
        this.mismatchPenaltyCard = penalty;
      }
      this.phase = "MISMATCH_PENDING";
      return [{
        type: "exchange-mismatch",
        playerId,
        positions: normalized,
        cards: [...selected],
        penaltyCardPending: Boolean(this.mismatchPenaltyCard),
      }];
    }

    const held = this.heldCard;
    const selectedSet = new Set(normalized);
    player.hand = player.hand.flatMap((card, index) => {
      const position = index + 1;
      if (!selectedSet.has(position)) return [card];
      return position === replacementPosition ? [held] : [];
    });
    this.heldCard = undefined;
    this.heldSource = undefined;
    for (const card of selected) this.discardPile.push(card);
    return [...selected.map((card): EngineEvent => ({ type: "discard", playerId, card })), ...this.finishTurn()];
  }

  resolveMismatch(
    playerId: string,
    drawnPlacement: EndPlacement,
    penaltyPlacement?: EndPlacement,
  ): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("MISMATCH_PENDING");
    const player = this.player(playerId);
    if (!this.heldCard) throw new GameRuleError("INVALID_COMMAND", "There is no drawn card to place.");
    if (Boolean(this.mismatchPenaltyCard) !== Boolean(penaltyPlacement)) {
      throw new GameRuleError(
        "INVALID_COMMAND",
        this.mismatchPenaltyCard ? "Choose where to place the penalty card." : "No penalty card placement is allowed.",
      );
    }
    this.insertAtEnd(player.hand, this.heldCard, drawnPlacement);
    if (this.mismatchPenaltyCard && penaltyPlacement) {
      this.insertAtEnd(player.hand, this.mismatchPenaltyCard, penaltyPlacement);
    }
    this.heldCard = undefined;
    this.heldSource = undefined;
    this.mismatchPenaltyCard = undefined;
    const event: EngineEvent = {
      type: "mismatch-resolved",
      playerId,
      drawnPlacement,
      ...(penaltyPlacement ? { penaltyPlacement } : {}),
    };
    return [event, ...this.finishTurn()];
  }

  discardHeld(playerId: string): EngineEvent[] {
    this.assertCurrent(playerId);
    this.assertPhase("DRAWN");
    if (!this.heldCard) throw new GameRuleError("INVALID_COMMAND", "There is no drawn card to discard.");
    if (this.heldSource !== "deck") throw new GameRuleError("INVALID_COMMAND", "A card taken from the discard pile must replace cards.");
    const card = this.heldCard;
    this.heldCard = undefined;
    this.heldSource = undefined;
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
      this.heldSource = undefined;
      this.mismatchPenaltyCard = undefined;
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
      ...(this.heldSource ? { drawSource: this.heldSource } : {}),
      mismatchPenaltyCardPending: Boolean(this.mismatchPenaltyCard),
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

  getPendingDraw(): { card: Card; source: DrawSource } | undefined {
    return this.heldCard && this.heldSource ? { card: this.heldCard, source: this.heldSource } : undefined;
  }

  private startRound(): EngineEvent[] {
    this.round += 1;
    this.phase = "INITIAL_REVEAL";
    this.caboCallerId = undefined;
    this.finalTurns = [];
    this.heldCard = undefined;
    this.heldSource = undefined;
    this.mismatchPenaltyCard = undefined;
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
    const moonShooter = active.find((player) => {
      if (player.hand.length !== 4) return false;
      return player.hand.filter((card) => card.rank === 12).length === 2
        && player.hand.filter((card) => card.rank === 13).length === 2;
    });
    const roundScores: Record<string, number> = {};
    for (const player of active) {
      const handScore = handScores.get(player.id) as number;
      const score = moonShooter
        ? (player.id === moonShooter.id ? 0 : this.targetScore / 2)
        : player.id === caller?.id ? (caboSucceeded ? 0 : handScore + 5) : handScore;
      player.score += score;
      roundScores[player.id] = score;
    }
    const totals = this.totals();
    const result: EngineEvent = {
      type: "round-result",
      hands: active.map((player) => ({ playerId: player.id, cards: [...player.hand], handScore: handScores.get(player.id) as number })),
      roundScores,
      totals,
      outcome: moonShooter
        ? { type: "shooting-the-moon", playerId: moonShooter.id }
        : { type: "cabo", callerId: caller?.id ?? "", succeeded: caboSucceeded },
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
    if (!Number.isInteger(position) || position < 1) {
      throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    }
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

  private validateExchangePositions(player: EnginePlayer, positions: Position[], replacementPosition: Position): Position[] {
    if (positions.length < 1 || positions.length > 4) {
      throw new GameRuleError("INVALID_POSITION", "Choose between 1 and 4 card positions.");
    }
    if (new Set(positions).size !== positions.length) {
      throw new GameRuleError("INVALID_POSITION", "Card positions must be unique.");
    }
    if (!positions.includes(replacementPosition)) {
      throw new GameRuleError("INVALID_POSITION", "The replacement position must be one of the selected cards.");
    }
    const normalized = [...positions].sort((a, b) => a - b);
    if (normalized.some((position) => !Number.isInteger(position) || position < 1 || position > player.hand.length)) {
      throw new GameRuleError("INVALID_POSITION", "That card position does not exist.");
    }
    return normalized;
  }

  private insertAtEnd(hand: Card[], card: Card, placement: EndPlacement): void {
    if (placement === "left") hand.unshift(card);
    else hand.push(card);
  }
}
