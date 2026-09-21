import { describe, expect, it } from "vitest";
import { seededRandom } from "./deck.js";
import { GameEngine } from "./engine.js";
import { GameRuleError, type EngineEvent, type Position, type Rank } from "./types.js";

const players = [
  { id: "a", name: "Alice" },
  { id: "b", name: "Bob" },
  { id: "c", name: "Chloe" },
];

function start(seed = 1, targetScore = 500): { engine: GameEngine; events: EngineEvent[] } {
  const engine = new GameEngine({ players, targetScore, random: seededRandom(seed) });
  return { engine, events: engine.startMatch() };
}

describe("GameEngine", () => {
  it("deals four hidden cards and only emits two initial private reveals per player", () => {
    const { engine, events } = start();
    expect(events.filter((event) => event.type === "private-reveal" && event.reason === "initial")).toHaveLength(6);
    expect(engine.getSnapshot().players.every((player) => player.cardCount === 4)).toBe(true);
    expect(JSON.stringify(engine.getSnapshot())).not.toContain("hand");
  });

  it("rejects actions from a player who does not own the turn without mutation", () => {
    const { engine } = start();
    const current = engine.currentPlayerId as string;
    const other = players.find((player) => player.id !== current)?.id as string;
    const before = engine.getSnapshot();
    expect(() => engine.drawDeck(other)).toThrowError(GameRuleError);
    expect(engine.getSnapshot()).toEqual(before);
  });

  it("requires a discard-pile draw to be placed before the turn ends", () => {
    const { engine } = start(6);
    const playerId = engine.currentPlayerId as string;
    const oldCard = engine.debugHand(playerId)[2];
    const previousTop = engine.getSnapshot().discardTop;
    engine.drawDiscard(playerId);
    engine.replaceHeld(playerId, [3], 3);
    expect(engine.debugHand(playerId)[2]).toEqual(previousTop);
    expect(engine.getSnapshot().discardTop).toEqual(oldCard);
    expect(engine.phase).toBe("TURN_START");
  });

  it("supports deck draws, replacements, discard powers, peeks and blind swaps", () => {
    const { engine } = start(9);
    const seen = new Set<string>();
    for (let turn = 0; turn < 80 && seen.size < 3; turn += 1) {
      const playerId = engine.currentPlayerId as string;
      const reveal = engine.drawDeck(playerId).find((event) => event.type === "private-reveal");
      if (!reveal || reveal.type !== "private-reveal") throw new Error("missing draw reveal");
      const rank = reveal.card.rank;
      if (rank >= 7 && rank <= 12) {
        engine.discardHeld(playerId);
        if (rank <= 8) {
          const result = engine.peekSelf(playerId, 1);
          expect(result[0]?.type).toBe("private-reveal");
          seen.add("self");
        } else if (rank <= 10) {
          const target = players.find((player) => player.id !== playerId)?.id as string;
          const result = engine.peekOther(playerId, target, 1);
          expect(result[0]?.type).toBe("private-reveal");
          seen.add("other");
        } else {
          const target = players.find((player) => player.id !== playerId)?.id as string;
          expect(engine.swap(playerId, target, 1)[0]?.type).toBe("swap");
          seen.add("swap");
        }
      } else {
        const position = ((turn % 4) + 1) as Position;
        engine.replaceHeld(playerId, [position], position);
      }
    }
    expect(seen).toEqual(new Set(["self", "other", "swap"]));
  });

  it("runs one final turn per opponent and produces an auditable round result", () => {
    const { engine } = start(15);
    const caller = engine.currentPlayerId as string;
    engine.callCabo(caller);
    const finalPlayers = players.length - 1;
    for (let index = 0; index < finalPlayers; index += 1) {
      const current = engine.currentPlayerId as string;
      engine.drawDeck(current);
      const events = engine.replaceHeld(current, [1], 1);
      if (index === finalPlayers - 1) {
        const result = events.find((event) => event.type === "round-result");
        expect(result?.type).toBe("round-result");
        if (result?.type === "round-result") {
          expect(result.hands).toHaveLength(3);
          expect(Object.keys(result.roundScores)).toHaveLength(3);
        }
      }
    }
    expect(engine.phase).toBe("ROUND_RESULT");
  });

  it("applies the exact Cabo success or failure scoring formula", () => {
    const engine = new GameEngine({ players: players.slice(0, 2), targetScore: 500, random: seededRandom(27) });
    engine.startMatch();
    const caller = engine.currentPlayerId as string;
    engine.callCabo(caller);
    const opponent = engine.currentPlayerId as string;
    engine.drawDeck(opponent);
    const events = engine.replaceHeld(opponent, [1], 1);
    const result = events.find((event) => event.type === "round-result");
    expect(result?.type).toBe("round-result");
    if (result?.type !== "round-result") return;
    const callerHand = result.hands.find((hand) => hand.playerId === caller)?.handScore as number;
    const opponentHand = result.hands.find((hand) => hand.playerId === opponent)?.handScore as number;
    expect(result.outcome).toEqual({ type: "cabo", callerId: caller, succeeded: callerHand < opponentHand });
    expect(result.roundScores[caller]).toBe(callerHand < opponentHand ? 0 : callerHand + 5);
    expect(result.roundScores[opponent]).toBe(opponentHand);
  });

  it("supports five players and rejects player counts outside 2-5", () => {
    expect(() => new GameEngine({ players: players.slice(0, 1), targetScore: 100 })).toThrow("2 to 5");
    const five = [...players, { id: "d", name: "Dara" }, { id: "e", name: "Eli" }];
    const engine = new GameEngine({ players: five, targetScore: 100, random: seededRandom(2) });
    engine.startMatch();
    expect(engine.getSnapshot().players).toHaveLength(5);
    expect(engine.getSnapshot().players.every((player) => player.cardCount === 4)).toBe(true);
    expect(() => new GameEngine({ players: [...five, { id: "f", name: "Finn" }], targetScore: 100 })).toThrow("2 to 5");
  });

  it("replaces matching multiple cards and compacts the hand", () => {
    const { engine } = start(3);
    const playerId = engine.currentPlayerId as string;
    const hand = engine.players.find((player) => player.id === playerId)?.hand as any[];
    hand[0] = { id: "x1", label: "5S", rank: 5 };
    hand[2] = { id: "x2", label: "5H", rank: 5 };
    engine.drawDeck(playerId);
    const held = engine.getPendingDraw()?.card;
    engine.replaceHeld(playerId, [1, 3], 3);
    expect(engine.debugHand(playerId)).toHaveLength(3);
    expect(engine.debugHand(playerId)[1]).toEqual(held);
  });

  it.each([2, 3, 4])("replaces %i matching cards from either draw source", (count) => {
    for (const source of ["deck", "discard"] as const) {
      const { engine } = start(30 + count + (source === "discard" ? 10 : 0));
      const playerId = engine.currentPlayerId as string;
      const hand = engine.players.find((player) => player.id === playerId)?.hand as any[];
      const positions = Array.from({ length: count }, (_, index) => index + 1);
      positions.forEach((position, index) => { hand[position - 1] = { id: `${source}-${index}`, label: `${count}X`, rank: 6 }; });
      if (source === "deck") engine.drawDeck(playerId);
      else engine.drawDiscard(playerId);
      const held = engine.getPendingDraw()?.card;
      engine.replaceHeld(playerId, positions, count);
      expect(engine.debugHand(playerId)).toHaveLength(5 - count);
      expect(engine.debugHand(playerId)[0]).toEqual(held);
    }
  });

  it("reveals mismatches and applies the extra-card placement penalty", () => {
    const { engine } = start(4);
    const playerId = engine.currentPlayerId as string;
    const hand = engine.players.find((player) => player.id === playerId)?.hand as any[];
    hand[0] = { id: "x1", label: "2S", rank: 2 };
    hand[1] = { id: "x2", label: "3H", rank: 3 };
    hand[2] = { id: "x3", label: "4D", rank: 4 };
    engine.drawDeck(playerId);
    const events = engine.replaceHeld(playerId, [1, 2, 3], 1);
    expect(events[0]).toMatchObject({ type: "exchange-mismatch", penaltyCardPending: true });
    expect(engine.phase).toBe("MISMATCH_PENDING");
    engine.resolveMismatch(playerId, "left", "right");
    expect(engine.debugHand(playerId)).toHaveLength(6);
  });

  it("adds no penalty for a two-card mismatch and rejects malformed selections atomically", () => {
    const { engine } = start(5);
    const playerId = engine.currentPlayerId as string;
    const player = engine.players.find((entry) => entry.id === playerId) as (typeof engine.players)[number];
    player.hand[0] = { id: "x1", label: "2S", rank: 2 };
    player.hand[1] = { id: "x2", label: "3H", rank: 3 };
    engine.drawDeck(playerId);
    const before = [...engine.debugHand(playerId)];
    expect(() => engine.replaceHeld(playerId, [1, 1], 1)).toThrow("unique");
    expect(engine.debugHand(playerId)).toEqual(before);
    expect(engine.replaceHeld(playerId, [1, 2], 1)[0]).toMatchObject({ type: "exchange-mismatch", penaltyCardPending: false });
    engine.resolveMismatch(playerId, "right");
    expect(engine.debugHand(playerId)).toHaveLength(5);
  });

  it("scores shooting the moon before Cabo and allows half points", () => {
    const engine = new GameEngine({ players: players.slice(0, 2), targetScore: 101, random: seededRandom(8) });
    engine.startMatch();
    const caller = engine.currentPlayerId as string;
    const shooter = engine.players.find((player) => player.id === caller) as (typeof engine.players)[number];
    const other = engine.players.find((player) => player.id !== caller) as (typeof engine.players)[number];
    other.score = 51;
    shooter.hand = [
      { id: "q1", label: "QS", rank: 12 }, { id: "q2", label: "QH", rank: 12 },
      { id: "k1", label: "K-A", rank: 13 }, { id: "k2", label: "K-B", rank: 13 },
    ];
    engine.callCabo(caller);
    const opponent = engine.currentPlayerId as string;
    engine.drawDeck(opponent);
    const result = engine.replaceHeld(opponent, [1], 1).find((event) => event.type === "round-result");
    expect(result?.type).toBe("round-result");
    if (result?.type !== "round-result") return;
    expect(result.outcome).toEqual({ type: "shooting-the-moon", playerId: caller });
    expect(result.roundScores[caller]).toBe(0);
    expect(result.roundScores[opponent]).toBe(50.5);
    expect(engine.phase).toBe("MATCH_RESULT");
  });

  it.each([
    ["an extra card", [12, 12, 13, 13, 1]],
    ["the wrong four-card combination", [12, 12, 13, 1]],
  ])("does not shoot the moon with %s", (_name, ranks) => {
    const engine = new GameEngine({ players: players.slice(0, 2), targetScore: 500, random: seededRandom(18) });
    engine.startMatch();
    const caller = engine.currentPlayerId as string;
    const candidate = engine.players.find((player) => player.id === caller) as (typeof engine.players)[number];
    candidate.hand = ranks.map((rank, index) => ({ id: `near-${index}`, label: `near-${rank}`, rank: rank as Rank }));
    engine.callCabo(caller);
    const opponent = engine.currentPlayerId as string;
    engine.drawDeck(opponent);
    const result = engine.replaceHeld(opponent, [1], 1).find((event) => event.type === "round-result");
    expect(result?.type === "round-result" && result.outcome.type).toBe("cabo");
  });

  it("removes forfeited players and awards the match when one player remains", () => {
    const { engine } = start();
    engine.forfeit("b");
    const events = engine.forfeit("c");
    expect(engine.phase).toBe("MATCH_RESULT");
    expect(engine.winners).toEqual(["a"]);
    expect(events.at(-1)).toMatchObject({ type: "match-result", winners: ["a"] });
  });
});
