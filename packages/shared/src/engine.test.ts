import { describe, expect, it } from "vitest";
import { seededRandom } from "./deck.js";
import { GameEngine } from "./engine.js";
import { GameRuleError, type EngineEvent, type Position } from "./types.js";

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

  it("requires a discard-pile draw to replace a hand position immediately", () => {
    const { engine } = start(6);
    const playerId = engine.currentPlayerId as string;
    const oldCard = engine.debugHand(playerId)[2];
    const previousTop = engine.getSnapshot().discardTop;
    engine.drawDiscard(playerId, 3);
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
        engine.replaceHeld(playerId, ((turn % 4) + 1) as Position);
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
      const events = engine.replaceHeld(current, 1);
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
    const events = engine.replaceHeld(opponent, 1);
    const result = events.find((event) => event.type === "round-result");
    expect(result?.type).toBe("round-result");
    if (result?.type !== "round-result") return;
    const callerHand = result.hands.find((hand) => hand.playerId === caller)?.handScore as number;
    const opponentHand = result.hands.find((hand) => hand.playerId === opponent)?.handScore as number;
    expect(result.caboSucceeded).toBe(callerHand < opponentHand);
    expect(result.roundScores[caller]).toBe(callerHand < opponentHand ? 0 : callerHand + 5);
    expect(result.roundScores[opponent]).toBe(opponentHand);
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
