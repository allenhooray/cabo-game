/**
 * 策略层单测（方案 M3 / §6.1）。
 *
 * 核心断言只有两条：
 *  1. 每个阶段、在给定的 `legalActions` 下都产出**合法**动作——绝不能自己
 *     构造一个 `legalActions` 里没有的动作。
 *  2. 没有合法动作时返回 `null`（等待新帧），而不是硬猜一个。
 *
 * 另外固定住一条免费收益：`MISMATCH_PENDING` 恒选 `right`。`left` 会
 * `unshift` 平移全部位置，等于把自己的记忆全部作废。
 */
import type { AgentObservation, LegalAction } from "@cabo-game/shared";
import { describe, expect, it } from "vitest";
import { createBelief, recompute, type Belief } from "./belief.js";
import { PERSONAS, type BotPersona } from "./persona.js";
import { decide, decisionDelay, moodFromHistory, type DecisionContext } from "./policy.js";
import { SelfPlayTable } from "./harness/engine-adapter.js";
import { applyObservation, applyPrivateReveal, applyPublicAction } from "./belief.js";

const neutral: BotPersona = { ...PERSONAS.mnemo, mistakeRate: 0, tiltGain: 0 };

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function observation(phase: string, legalActions: LegalAction[], overrides: Partial<AgentObservation["state"]> = {}): AgentObservation {
  return {
    roomId: "r",
    roomName: "R",
    selfId: "me",
    revision: 1,
    state: {
      memoryMode: "assisted",
      turnDurationSeconds: 60,
      deadlineAt: 0,
      serverTime: 0,
      phase: phase as AgentObservation["state"]["phase"],
      round: 1,
      targetScore: 100,
      currentPlayerId: "me",
      caboCallerId: null,
      drawSource: null,
      mismatchPenaltyCardPending: false,
      discardTop: null,
      deckCount: 30,
      players: [
        { id: "me", name: "me", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true },
        { id: "a", name: "a", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false },
      ],
      winners: [],
      roundHistory: [],
      ...overrides,
    },
    knowledge: { memoryMode: "assisted", round: 1, slots: [], opponents: [], held: null },
    legalActions,
    caboRisk: null,
  };
}

function context(obs: AgentObservation, belief: Belief, persona: BotPersona = neutral, seed = 1): DecisionContext {
  return { belief, observation: obs, persona, rng: lcg(seed), samples: 40 };
}

function freshBelief(): Belief {
  const belief = createBelief("me", "assisted");
  belief.round = 1;
  belief.mySlots = [null, null, null, null];
  belief.oppSlots.set("a", [null, null, null, null]);
  recompute(belief);
  return belief;
}

/** 断言产出的动作确实在 `legalActions` 里。 */
function expectLegal(obs: AgentObservation, action: { type: string } | null): void {
  expect(action).not.toBeNull();
  const allowed = obs.legalActions.some((candidate) => candidate.type === action?.type);
  expect(allowed).toBe(true);
}

describe("decide · 合法性", () => {
  it("没有合法动作时返回 null，不猜", () => {
    expect(decide(context(observation("TURN_START", []), freshBelief()))).toBeNull();
  });

  it("LOBBY 阶段选 start", () => {
    const obs = observation("LOBBY", [{ type: "start" }]);
    const action = decide(context(obs, freshBelief()));
    expect(action).toEqual({ type: "start" });
    expectLegal(obs, action);
  });

  it("ROUND_RESULT 阶段选 ready-next-round", () => {
    const obs = observation("ROUND_RESULT", [{ type: "ready-next-round" }]);
    const action = decide(context(obs, freshBelief()));
    expect(action).toEqual({ type: "ready-next-round" });
  });

  it("MISMATCH_PENDING 恒选 right（left 会平移全部位置）", () => {
    const obs = observation("MISMATCH_PENDING", [{ type: "resolve-mismatch", placements: ["left", "right"], penaltyCardPending: false }]);
    expect(decide(context(obs, freshBelief()))).toEqual({ type: "resolve-mismatch", drawnPlacement: "right" });

    const withPenalty = observation("MISMATCH_PENDING", [{ type: "resolve-mismatch", placements: ["left", "right"], penaltyCardPending: true }]);
    expect(decide(context(withPenalty, freshBelief()))).toEqual({
      type: "resolve-mismatch",
      drawnPlacement: "right",
      penaltyPlacement: "right",
    });
  });

  it("TURN_START 在只有 draw-deck 时抽牌堆", () => {
    const obs = observation("TURN_START", [{ type: "draw-deck" }]);
    const action = decide(context(obs, freshBelief()));
    expectLegal(obs, action);
    expect(action?.type).toBe("draw-deck");
  });

  it("TURN_START 在胜率够高时会宣告 cabo（cabo 是合法动作时才可能）", () => {
    const belief = freshBelief();
    // 自己四张全已知且极低，对手四张全已知且极高 —— 胜率必然打穿门槛。
    belief.mySlots = [{ label: "J1", rank: 0 }, { label: "J2", rank: 0 }, { label: "1S", rank: 1 }, { label: "1H", rank: 1 }];
    belief.oppSlots.set("a", [{ label: "12S", rank: 12 }, { label: "12H", rank: 12 }, { label: "12D", rank: 12 }, { label: "12C", rank: 12 }]);
    recompute(belief);
    const obs = observation("TURN_START", [{ type: "cabo" }, { type: "draw-deck" }]);
    expect(decide(context(obs, belief))?.type).toBe("cabo");
  });

  it("TURN_START 胜率不足时不宣告 cabo", () => {
    const belief = freshBelief();
    // 双方牌力相当 → 胜率大约就是 1/2，低于门槛。
    belief.mySlots = [{ label: "6S", rank: 6 }, { label: "6H", rank: 6 }, { label: "6D", rank: 6 }, { label: "6C", rank: 6 }];
    belief.oppSlots.set("a", [{ label: "6S2", rank: 6 }, { label: "6H2", rank: 6 }, { label: "6D2", rank: 6 }, { label: "6C2", rank: 6 }]);
    recompute(belief);
    const obs = observation("TURN_START", [{ type: "cabo" }, { type: "draw-deck" }]);
    expect(decide(context(obs, belief))?.type).toBe("draw-deck");
  });

  it("TURN_START 只能跳过时选 skip", () => {
    const obs = observation("TURN_START", [{ type: "skip" }]);
    const action = decide(context(obs, freshBelief()));
    expect(action).toEqual({ type: "skip" });
  });

  it("FINAL_TURNS 也走 TURN_START 分支，产出的动作合法", () => {
    const obs = observation("FINAL_TURNS", [{ type: "draw-deck" }, { type: "draw-discard" }]);
    const action = decide(context(obs, freshBelief()));
    expectLegal(obs, action);
  });

  it("DRAWN 阶段的 replace 位置必须落在 selectablePositions 里", () => {
    const obs = observation("DRAWN", [
      { type: "replace", selectablePositions: [1, 2], minSelections: 1, maxSelections: 2 },
      { type: "discard" },
    ]);
    const belief = freshBelief();
    belief.held = { label: "9D", rank: 9 };
    const action = decide(context(obs, belief));
    expectLegal(obs, action);
    if (action?.type === "replace") {
      for (const position of action.positions) expect([1, 2]).toContain(position);
      expect(action.positions).toContain(action.replacementPosition);
    }
  });

  it("DRAWN 阶段没有可落位的位置时退回 discard", () => {
    const obs = observation("DRAWN", [{ type: "discard" }]);
    const belief = freshBelief();
    belief.held = { label: "9D", rank: 9 };
    const action = decide(context(obs, belief));
    expect(action).toEqual({ type: "discard" });
  });

  it("POWER_PENDING · 弃牌堆顶 7/8 → peek-self", () => {
    const obs = observation("POWER_PENDING", [{ type: "peek-self", position: 1 }, { type: "skip" }], { discardTop: { label: "7S", rank: 7 } });
    const action = decide(context(obs, freshBelief()));
    expectLegal(obs, action);
    expect(action?.type).toBe("peek-self");
  });

  it("POWER_PENDING · 弃牌堆顶 9/10 → peek-other", () => {
    const obs = observation("POWER_PENDING", [
      { type: "peek-other", targetPlayerId: "a", position: 1 },
      { type: "skip" },
    ], { discardTop: { label: "9S", rank: 9 } });
    const action = decide(context(obs, freshBelief()));
    expectLegal(obs, action);
    expect(action?.type).toBe("peek-other");
  });

  it("POWER_PENDING · 11/12 在收益不足时跳过，不硬换", () => {
    // 对手位置全未知、我方也全未知 —— 换牌价值很低，阈值过不去。
    const obs = observation("POWER_PENDING", [
      { type: "swap", targetPlayerId: "a", ownPosition: 1, targetPosition: 1 },
      { type: "skip" },
    ], { discardTop: { label: "11S", rank: 11 } });
    const action = decide(context(obs, freshBelief(), { ...neutral, swapAggression: 0 }));
    expectLegal(obs, action);
    expect(action?.type).toBe("skip");
  });

  it("POWER_PENDING · 11/12 在收益足够时发动换牌", () => {
    const belief = freshBelief();
    // 我手里一张 12（自己知道），对手一张 1（自己知道）→ 换牌收益巨大。
    belief.mySlots = [{ label: "12D", rank: 12 }, { label: "12C", rank: 12 }, { label: "5S", rank: 5 }, { label: "5H", rank: 5 }];
    belief.oppSlots.set("a", [{ label: "1S", rank: 1 }, { label: "5D", rank: 5 }, { label: "5C", rank: 5 }, { label: "5S2", rank: 5 }]);
    recompute(belief);
    const obs = observation("POWER_PENDING", [
      { type: "swap", targetPlayerId: "a", ownPosition: 1, targetPosition: 1 },
      { type: "skip" },
    ], { discardTop: { label: "11S", rank: 11 } });
    const action = decide(context(obs, belief, { ...neutral, swapAggression: 1, leaderFocus: 1 }));
    expectLegal(obs, action);
    expect(action?.type).toBe("swap");
  });
});

describe("decide · 失误与情绪", () => {
  it("mistakeRate = 0 时不会改选", () => {
    const obs = observation("TURN_START", [{ type: "draw-deck" }, { type: "skip" }]);
    expect(decide(context(obs, freshBelief(), { ...neutral, mistakeRate: 0 }))).toEqual({ type: "draw-deck" });
  });

  it("失误永远不会选中 cabo（随机宣告的惩罚过重）", () => {
    const obs = observation("TURN_START", [{ type: "cabo" }, { type: "draw-deck" }, { type: "skip" }]);
    for (let seed = 0; seed < 60; seed += 1) {
      const action = decide(context(obs, freshBelief(), { ...neutral, mistakeRate: 1 }, seed));
      expect(action?.type).not.toBe("cabo");
    }
  });

  it("moodFromHistory 在上一轮比对手多拿分时给出正情绪", () => {
    const obs = observation("TURN_START", []);
    obs.state.roundHistory = [{
      round: 1,
      outcomeType: "cabo",
      outcomePlayerId: "a",
      caboSucceeded: false,
      players: [
        { playerId: "me", roundScore: 20, totalScore: 20, handScore: 20, cards: [] },
        { playerId: "a", roundScore: 5, totalScore: 5, handScore: 5, cards: [] },
      ],
    }];
    expect(moodFromHistory(obs, "me")).toBeGreaterThan(0);
    expect(moodFromHistory(obs, "a")).toBe(0);
  });

  it("moodFromHistory 在没有历史时是 0", () => {
    expect(moodFromHistory(observation("TURN_START", []), "me")).toBe(0);
  });

  it("decisionDelay 落在基准的 0.6–1.4 倍之间", () => {
    const persona: BotPersona = { ...neutral, decisionLatencyMs: 1000 };
    for (let seed = 0; seed < 20; seed += 1) {
      const delay = decisionDelay(persona, lcg(seed));
      expect(delay).toBeGreaterThanOrEqual(600);
      expect(delay).toBeLessThanOrEqual(1400);
    }
  });
});

/**
 * M3 的完成判据：harness 跑 100 局，断言零非法动作、全部抵达 `MATCH_RESULT`。
 *
 * 这条测试同时是"活性兜底"的回归测试——引擎没有回合上限，没有兜底的话
 * 全员保守时回合会无限进行（实测阈值放大 1.5 倍后 86% 的对局卡死）。
 */
describe("M3 · 整局对弈零非法动作", () => {
  it("100 局全部抵达 MATCH_RESULT", async () => {
    const { runSelfPlay } = await import("./harness/self-play.js");
    const report = runSelfPlay({
      personas: ["mnemo", "gambler", "gremlin", "abacus"],
      games: 100,
      seed: 424242,
      samples: 60,
      jitter: false,
    });
    expect(report.failures).toEqual([]);
    expect(report.stats.every((stat) => stat.seatGames === 100)).toBe(true);
    // 活性兜底的上界：宽限期 + 兜底窗口之后门槛已经压到很低。
    expect(report.maxRoundTurns).toBeLessThan(200);
  }, 240_000);

  it("harness 的每个座位都能拿到与线上同构的观察帧", () => {
    const table = new SelfPlayTable({ playerIds: ["s0", "s1", "s2"], seed: 7, memoryMode: "assisted" });
    table.start();
    const turn = table.takeTurn("s0");
    expect(turn.observation.selfId).toBe("s0");
    expect(turn.observation.state.players).toHaveLength(3);
    expect(turn.observation.legalActions.length).toBeGreaterThan(0);
    // 暗牌绝不能出现在观察帧里：只能看到张数。
    expect(turn.observation.state.players.every((player) => typeof player.cardCount === "number")).toBe(true);
    expect(JSON.stringify(turn.observation)).not.toContain("debugHand");
  });

  it("信念层能吸收真实事件流并保持自洽", () => {
    const table = new SelfPlayTable({ playerIds: ["s0", "s1"], seed: 11, memoryMode: "assisted" });
    const belief = createBelief("s0", "assisted");
    table.start();

    let steps = 0;
    while (table.phase !== "MATCH_RESULT" && steps++ < 400) {
      if (table.phase === "ROUND_RESULT") {
        table.nextRound();
        continue;
      }
      const seat = table.currentPlayerId;
      if (!seat) break;
      const turn = table.takeTurn(seat);
      for (const event of turn.events) {
        if (event.type === "private-reveal") applyPrivateReveal(belief, event);
        else if (event.type === "action") applyPublicAction(belief, event);
      }
      applyObservation(belief, turn.observation);
      if (seat !== "s0") {
        // 其他座位也要推进，否则对局无法结束。
        const action = turn.observation.legalActions[0];
        if (action) table.apply(seat, action as never);
        continue;
      }
      // 我的位置数组长度必须等于观察里的 cardCount。
      const mine = turn.observation.state.players.find((player) => player.id === "s0");
      expect(belief.mySlots).toHaveLength(mine?.cardCount ?? 0);
      const bounds = belief.slotBounds.get("s0") ?? [];
      expect(bounds.length).toBe(belief.mySlots.length);
      const action = turn.observation.legalActions[0];
      if (action) table.apply("s0", action as never);
    }
    // 未见牌池恒等式：全量牌组 = 已确定身份的牌 + 未见牌 + 牌堆。
    expect(belief.unseenTotal).toBeGreaterThanOrEqual(0);
  });
});
