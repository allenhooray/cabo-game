/**
 * 评估层单测（方案 M2 / §6.1）。
 *
 * 两个硬门槛：
 *  1. `E[H]` 与暴力枚举的误差 < 1e-6。蒙特卡洛里的期望手牌分必须能被
 *     精确算出来，否则后面所有以它为输入的阈值都在漂。
 *  2. 阈值公式的边界：`H = 5` 附近应落在 40%–45%（`k = 1` 时），
 *     并且 H 从 7 涨到 36 门槛只从 0.43 涨到 0.56 —— 几乎是一条平线。
 *
 * 另外固定住几个**曾经把校准带偏**的建模点，防止回归：
 *  - 我方终局分不能打对手理性折扣 ρ；
 *  - 未知位置要按上界抽，不能按池均值抽；
 *  - 对手抽牌要用**牌堆**那一堆，不能和手牌共用同一个池；
 *  - 对手换牌的目标要挑最低的那家，不能写死成我。
 */
import type { AgentObservation } from "@cabo-game/shared";
import { describe, expect, it } from "vitest";
import { createBelief, MEAN_CARD_RANK, recompute, type Belief } from "./belief.js";
import {
  LIVENESS_GRACE_TURNS,
  LIVENESS_LIMIT_TURNS,
  caboThreshold,
  clamp,
  continuationDelta,
  evaluate,
  expectedHandScore,
  livenessMultiplier,
  opponentExpectedScore,
  sampleFinalState,
  winProbability,
  type EvaluationContext,
} from "./evaluate.js";
import { PERSONAS, opponentDiscount, RATIONAL_DISCOUNT } from "./persona.js";
import type { BotPersona } from "./persona.js";

/** 可复现的伪随机源（与 `seededRandom` 无关，只为让测试确定性）。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const abacus = PERSONAS.abacus;
const neutral: BotPersona = { ...abacus, optimismBias: 0, memoryFidelity: 1 };

/**
 * `cautionFactor = 1` 且不受落后补偿影响的基准人设。
 *
 * 阈值公式是 `k_eff · (5 + δ(Ĥ)) / (Ĥ + 5) · 活性兜底`，而 `abacus` 的 `k = 2.2`。
 * 要对照实测门槛（那些数字是 k = 1 下算出来的）就必须把 k 归一化，
 * 否则整组断言会整体偏 2.2 倍——这正是本组测试第一版的 bug。
 */
const kOne: BotPersona = { ...neutral, cautionFactor: 1, catchUpGain: 0 };

function belief(selfId = "me"): Belief {
  const next = createBelief(selfId, "assisted");
  next.round = 1;
  return next;
}

function observation(overrides: Partial<AgentObservation["state"]> = {}, selfId = "me"): AgentObservation {
  return {
    roomId: "r",
    roomName: "R",
    selfId,
    revision: 1,
    state: {
      memoryMode: "assisted",
      turnDurationSeconds: 60,
      deadlineAt: 0,
      serverTime: 0,
      phase: "TURN_START",
      round: 1,
      targetScore: 100,
      currentPlayerId: selfId,
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
    legalActions: [],
    caboRisk: null,
  };
}

function context(b: Belief, persona: BotPersona = neutral, state: Partial<AgentObservation["state"]> = {}): EvaluationContext {
  return { belief: b, observation: observation(state, b.selfId), persona, rng: lcg(12345) };
}

describe("expectedHandScore · 与暴力枚举对照", () => {
  /**
   * 全部位置都未知时，期望手牌分 = 4 × 未见牌池均值。这是可精确计算的，
   * 用来锁住 `E[H]` 的定义（也顺带证明"我方未知牌不打 ρ"这条规则）。
   */
  it("四张全未知时等于 4 × 池均值（误差 < 1e-6）", () => {
    const b = belief();
    b.mySlots = [null, null, null, null];
    recompute(b);

    // 暴力枚举：把整副牌当成池，取 4 张的期望和 = 4 × 池均值。
    const pool: number[] = [];
    for (const [rank, count] of b.unseen) for (let index = 0; index < count; index += 1) pool.push(rank);
    const bruteForce = (4 * pool.reduce((sum, value) => sum + value, 0)) / pool.length;

    expect(Math.abs(expectedHandScore(b, neutral) - bruteForce)).toBeLessThan(1e-6);
    expect(expectedHandScore(b, neutral)).toBeCloseTo(4 * MEAN_CARD_RANK, 6);
  });

  it("已知位置精确计入，未知位置按池均值补齐", () => {
    const b = belief();
    b.mySlots = [{ label: "1S", rank: 1 }, null, { label: "3S", rank: 3 }, null];
    // 把这两张从池里扣掉，池均值随之上移。
    recompute(b);
    const expected = 1 + 3 + 2 * (b.meanUnseen);
    expect(expectedHandScore(b, neutral)).toBeCloseTo(expected, 6);
  });

  it("我方未知牌不打对手理性折扣 ρ（打上去会低估自己约 1.6 分）", () => {
    const b = belief();
    b.mySlots = [null, null, null, null];
    recompute(b);
    const withDiscount = expectedHandScore(b, { ...neutral, optimismBias: 0 });
    // 换成一个 ρ 很小的对手估值，我方估计不应该跟着变。
    const discounted = 4 * b.meanUnseen * opponentDiscount({ ...neutral, leaderFocus: 0, dumpBias: 0 });
    expect(withDiscount).toBeGreaterThan(discounted);
    expect(RATIONAL_DISCOUNT).toBeLessThan(1);
  });

  it("乐观偏置按比例压低未知牌估值，对已知牌无效", () => {
    const b = belief();
    b.mySlots = [{ label: "5S", rank: 5 }, null, null, null];
    recompute(b);
    const pessimistic: BotPersona = { ...neutral, optimismBias: 0 };
    const optimistic: BotPersona = { ...neutral, optimismBias: 0.5 };
    const diff = expectedHandScore(b, pessimistic) - expectedHandScore(b, optimistic);
    expect(diff).toBeCloseTo(1.5 * b.meanUnseen, 6);
  });

  it("上界收紧后我方未知牌估值下降（上界确实参与计算）", () => {
    const b = belief();
    b.mySlots = [null, null, null, null];
    recompute(b);
    const before = expectedHandScore(b, neutral);
    b.slotBounds.set("me", [4, null, null, null]);
    const after = expectedHandScore(b, neutral);
    expect(after).toBeLessThan(before);
  });
});

describe("opponentExpectedScore", () => {
  it("对手估值打理性折扣 ρ", () => {
    const b = belief();
    b.mySlots = [null, null, null, null];
    b.oppSlots.set("a", [null, null, null, null]);
    recompute(b);
    const me = expectedHandScore(b, neutral);
    const rival = opponentExpectedScore(b, neutral, "a");
    expect(rival).toBeLessThan(me);
    expect(rival).toBeCloseTo(4 * b.meanUnseen * opponentDiscount(neutral), 6);
  });
});

describe("caboThreshold · 公式边界", () => {
  it("δ(H) 在低手牌分端饱和到负值（继续打反而可能被换牌抬分）", () => {
    expect(continuationDelta(0)).toBeCloseTo(-2.7, 10);
    expect(continuationDelta(6.8)).toBeCloseTo(0, 10);
    expect(continuationDelta(26)).toBeGreaterThan(11);
  });

  it("门槛复现实测的平坦形状（H 从 7 涨到 36，实测门槛只从 0.42 涨到 0.62）", () => {
    const b = belief();
    const ctx = context(b, kOne);
    // 实测锚点（continuation.ts）：H=7.16→0.417，13.85→0.479，29.02→0.548。
    // 拟合曲线落在 0.430 / 0.497 / 0.552，三点都在 ±0.02 以内。
    const at7 = caboThreshold(kOne, 7.16, ctx);
    const at14 = caboThreshold(kOne, 13.85, ctx);
    const at29 = caboThreshold(kOne, 29.02, ctx);
    expect(at7).toBeCloseTo(0.43, 2);
    expect(at14).toBeCloseTo(0.5, 2);
    expect(at29).toBeCloseTo(0.55, 2);
    // 旧公式 5/(H+5) 在这三点是 0.41 / 0.27 / 0.15 —— 差手牌那一端低得离谱。
    expect(5 / (7.16 + 5)).toBeCloseTo(0.41, 2);
    expect(5 / (29.02 + 5)).toBeCloseTo(0.15, 2);
    // 实测门槛的整个跨度不到 1.5 倍：这条曲线几乎是平的。
    expect(at29 / at7).toBeLessThan(1.4);
  });

  it("手牌很好时门槛反而下降（该锁定胜利），但不是无限下降", () => {
    const b = belief();
    const ctx = context(b, kOne);
    // δ(1.44) 已撞到地板 −2.7 → (5−2.7)/(1.44+5) ≈ 0.357。
    expect(continuationDelta(1.44)).toBeCloseTo(-2.7, 10);
    const veryGood = caboThreshold(kOne, 1.44, ctx);
    const mid = caboThreshold(kOne, 7.16, ctx);
    expect(veryGood).toBeLessThan(mid);
    // 地板保证它不会一路掉到 0 —— 手牌再低也不该"无限等待"。
    expect(veryGood).toBeGreaterThan(0.3);
  });

  it("回合开头手牌全未知时不会宣告（旧公式在这里会误判）", () => {
    const b = belief();
    const ctx = context(b, kOne);
    // H ≈ 26（4 张未知牌 × 池均值 6.5），4 人桌 p̂ 上界约 1/4。
    const threshold = caboThreshold(kOne, 26, ctx);
    expect(threshold).toBeGreaterThan(0.5);
    // 旧公式在同一处给出 0.147，低于 p̂ 的 0.25，会直接宣告。
    expect(5 / (26 + 5)).toBeLessThan(0.25);
  });

  it("总分落后越多门槛越低（catchUpGain 生效）", () => {
    const b = belief();
    const behind = context(b, neutral, {
      players: [
        { id: "me", name: "me", seat: 0, score: 60, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true },
        { id: "a", name: "a", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false },
      ],
    });
    const even = context(b, neutral);
    const persona: BotPersona = { ...neutral, catchUpGain: 0.8 };
    expect(caboThreshold(persona, 10, behind)).toBeLessThan(caboThreshold(persona, 10, even));
  });

  it("门槛被夹在 [0, 1]", () => {
    const b = belief();
    const ctx = context(b, kOne);
    expect(caboThreshold(kOne, 0, ctx)).toBeLessThanOrEqual(1);
    expect(caboThreshold({ ...kOne, cautionFactor: 4 }, 0, ctx)).toBe(1);
    expect(caboThreshold({ ...kOne, cautionFactor: 0 }, 40, ctx)).toBeGreaterThanOrEqual(0);
    // k 也有下界 0.3，所以门槛永远不会被压到 0。
    expect(caboThreshold({ ...kOne, cautionFactor: 0 }, 40, ctx)).toBeGreaterThan(0);
  });

  it("cautionFactor 越大门槛越高（人格参数仍然有效）", () => {
    const b = belief();
    const ctx = context(b, kOne);
    const aggressive = caboThreshold({ ...kOne, cautionFactor: 0.5 }, 10, ctx);
    const conservative = caboThreshold({ ...kOne, cautionFactor: 2 }, 10, ctx);
    expect(conservative).toBeGreaterThan(aggressive);
  });
});

describe("活性兜底", () => {
  it("宽限期内不生效", () => {
    expect(livenessMultiplier(0)).toBe(1);
    expect(livenessMultiplier(LIVENESS_GRACE_TURNS)).toBe(1);
  });

  it("回合拖长后单调下降，且有下界", () => {
    const mid = livenessMultiplier(LIVENESS_GRACE_TURNS + 10);
    const late = livenessMultiplier(LIVENESS_LIMIT_TURNS);
    expect(mid).toBeLessThan(1);
    expect(late).toBeLessThan(mid);
    expect(livenessMultiplier(10_000)).toBeCloseTo(late, 10);
    expect(late).toBeGreaterThan(0);
  });

  it("兜底生效后门槛确实下降，从而保证回合能结束", () => {
    const b = belief();
    const ctx = context(b, kOne);
    b.turnCount = 0;
    const early = caboThreshold(kOne, 10, ctx);
    b.turnCount = LIVENESS_LIMIT_TURNS;
    const late = caboThreshold(kOne, 10, ctx);
    expect(late).toBeLessThan(early);
    // 到上限时正好压到 LIVENESS_FLOOR（0.35）倍。
    expect(late).toBeCloseTo(early * 0.35, 6);
    // 但宽限期内必须**完全**不受影响，否则校准结论会被兜底污染。
    b.turnCount = LIVENESS_GRACE_TURNS;
    expect(caboThreshold(kOne, 10, ctx)).toBeCloseTo(early, 10);
  });
});

describe("winProbability / sampleFinalState", () => {
  it("没有对手时胜率是 1", () => {
    const b = belief();
    b.mySlots = [{ label: "1S", rank: 1 }, null, null, null];
    const ctx: EvaluationContext = { ...context(b), observation: observation({ players: [
      { id: "me", name: "me", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true },
    ] }) };
    expect(winProbability(ctx, 50)).toBe(1);
  });

  it("比的是**手牌总分**而不是最小牌：我总分更低才赢", () => {
    const b = belief();
    b.mySlots = [{ label: "1S", rank: 1 }, { label: "2S", rank: 2 }, { label: "3S", rank: 3 }, { label: "4S", rank: 4 }];
    // 我 10 分，对手 12 分 → 赢。
    b.oppSlots.set("a", [{ label: "3H", rank: 3 }, { label: "3D", rank: 3 }, { label: "3C", rank: 3 }, { label: "3S2", rank: 3 }]);
    recompute(b);
    expect(winProbability(context(b, neutral), 20)).toBe(1);

    // 我 10 分，对手 4 分 → 输。
    b.oppSlots.set("a", [{ label: "1H", rank: 1 }, { label: "1D", rank: 1 }, { label: "1C", rank: 1 }, { label: "1S2", rank: 1 }]);
    recompute(b);
    expect(winProbability(context(b, neutral), 20)).toBe(0);
  });

  it("平局算输（必须**严格**最低）", () => {
    const b = belief();
    b.mySlots = [{ label: "1S", rank: 1 }, { label: "2S", rank: 2 }, { label: "3S", rank: 3 }, { label: "4S", rank: 4 }];
    // 对手总分也是 10 → 10 < 10 不成立 → 输。
    b.oppSlots.set("a", [{ label: "1H", rank: 1 }, { label: "2H", rank: 2 }, { label: "3H", rank: 3 }, { label: "4H", rank: 4 }]);
    recompute(b);
    expect(winProbability(context(b, neutral), 20)).toBe(0);
  });

  it("全部认出来也**不**提前返回：对手仍有最终回合（回归）", () => {
    const b = belief();
    b.mySlots = [{ label: "5S", rank: 5 }, { label: "5H", rank: 5 }, { label: "5D", rank: 5 }, { label: "5C", rank: 5 }];
    b.oppSlots.set("a", [{ label: "12S", rank: 12 }, { label: "12H", rank: 12 }, { label: "12D", rank: 12 }, { label: "12C", rank: 12 }]);
    recompute(b);
    // 牌堆就是池里剩下的那些牌。
    b.deckCount = b.unseenTotal;

    const ctx = context(b, neutral);
    const rng = lcg(5);
    const outcomes = Array.from({ length: 100 }, () => sampleFinalState(ctx, rng));
    // 对手手里四张 12，最终回合必然塌缩掉二十几分。
    // 如果早返回"已知分"，这里会恒等于 48 —— 这正是最确定的局面被高估的来源。
    expect(outcomes.every((outcome) => outcome.rivalScores[0] !== 48)).toBe(true);
    expect(outcomes.every((outcome) => outcome.rivalScores[0] < 48)).toBe(true);
    expect(outcomes.some((outcome) => outcome.rivalScores[0] < 20)).toBe(true);
  });

  it("牌堆为 0 时对手抽不到牌，手牌原样保留（不能被塞一张不存在的牌）", () => {
    const b = belief();
    b.mySlots = [{ label: "5S", rank: 5 }, { label: "5H", rank: 5 }, { label: "5D", rank: 5 }, { label: "5C", rank: 5 }];
    b.oppSlots.set("a", [{ label: "12S", rank: 12 }, { label: "12H", rank: 12 }, { label: "12D", rank: 12 }, { label: "12C", rank: 12 }]);
    recompute(b);
    b.deckCount = 0;
    b.discardPile = [];
    const ctx = context(b, neutral);
    const rng = lcg(5);
    const outcomes = Array.from({ length: 50 }, () => sampleFinalState(ctx, rng));
    expect(outcomes.every((outcome) => outcome.rivalScores[0] === 48)).toBe(true);
    expect(outcomes.every((outcome) => outcome.myScore === 20)).toBe(true);
  });

  /**
   * 对手的最终回合确实被建模，而且**必须靠牌堆**才能发生。
   *
   * 这条是 A/B 对照：同一个局面，只改 `deckCount`。`belief.deckCount` 默认是 0，
   * 所以"对手能改善手牌"这件事在默认信念下根本不会发生 —— 第一版这条测试就是
   * 忘了给对手牌堆，于是断言了一个恒为 1 的胜率。断言落在**对手分数**上，
   * 比落在胜率上更贴近要验证的性质（也免于手牌分差太悬殊导致的恒真）。
   */
  it("对手的最终回合确实被建模：给对手牌堆后其分数下降，没牌堆时原样保留", () => {
    const build = (): Belief => {
      const b = belief();
      b.mySlots = [{ label: "5S", rank: 5 }, { label: "5H", rank: 5 }, { label: "5D", rank: 5 }, { label: "5C", rank: 5 }];
      b.oppSlots.set("a", [
        { label: "12S", rank: 12 }, { label: "12H", rank: 12 }, { label: "12D", rank: 12 }, { label: "12C", rank: 12 },
      ]);
      recompute(b);
      return b;
    };
    const meanRival = (b: Belief): number => {
      const ctx = context(b, neutral);
      const rng = lcg(5);
      const outcomes = Array.from({ length: 200 }, () => sampleFinalState(ctx, rng));
      return outcomes.reduce((total, outcome) => total + (outcome.rivalScores[0] as number), 0) / outcomes.length;
    };

    const noDeck = build();
    noDeck.deckCount = 0;
    noDeck.discardPile = [];
    // 抽不到牌 → 四张 12 原样留着，一分不减。
    expect(meanRival(noDeck)).toBeCloseTo(48, 6);

    const withDeck = build();
    withDeck.deckCount = 20;
    // 能抽到牌 → 要么把一张 12 换成更小的牌，要么四张同点直接塌缩成一张。
    expect(meanRival(withDeck)).toBeLessThan(47);
    expect(meanRival(withDeck)).toBeGreaterThan(0);
  });

  it("sampleFinalState 的对手分数与我的分数都有限且非负", () => {
    const b = belief();
    b.mySlots = [null, null, null, null];
    b.oppSlots.set("a", [null, null, null, null]);
    recompute(b);
    const ctx = context(b, neutral);
    const rng = lcg(7);
    for (let index = 0; index < 50; index += 1) {
      const outcome = sampleFinalState(ctx, rng);
      expect(Number.isFinite(outcome.myScore)).toBe(true);
      expect(outcome.myScore).toBeGreaterThanOrEqual(0);
      for (const score of outcome.rivalScores) {
        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * 回归：对手的最终回合抽牌必须来自**牌堆**那一堆。
   *
   * 曾经的写法是让对手和我共用一个池：认得越多池越小，给手牌填完位置池就见底，
   * 抽牌回落到"期望值"这个小数，于是永远抽不到 11/12，换牌能力凭空消失，
   * p̂ 冲到 99%（实测该桶实际只有 48.5%）。
   *
   * 构造一个"牌堆只剩 11/12"的局面：如果对手真的从牌堆抽，就一定换走我的 0 分牌。
   */
  it("牌堆只剩 11/12 时，对手必然发动换牌（分池抽牌回归）", () => {
    const b = belief();
    // 我全已知，且手里有一张 0 分王；对手全已知且最高是 12。
    b.mySlots = [{ label: "J1", rank: 0 }, { label: "1S", rank: 1 }, { label: "1H", rank: 1 }, { label: "1D", rank: 1 }];
    b.oppSlots.set("a", [{ label: "12S", rank: 12 }, { label: "3S", rank: 3 }, { label: "3H", rank: 3 }, { label: "3D", rank: 3 }]);
    // 把其余所有牌都塞进弃牌堆，池里只剩牌堆那两张 11/12。
    for (const [rank, count] of b.unseen) {
      for (let index = 0; index < count; index += 1) b.discardPile.push({ label: `${rank}-${index}`, rank });
    }
    b.discardPile = b.discardPile.filter((entry) => entry.rank !== 11 && entry.rank !== 12);
    // 池里只留 11 和 12。
    b.unseen = new Map([[11, 4], [12, 4]]);
    b.unseenTotal = 8;
    b.meanUnseen = 11.5;
    b.deckCount = 8;

    const ctx = context(b, neutral);
    const rng = lcg(99);
    // 对手最高 12 会换走我的 0 → 我的终局分必然被抬起来。
    const outcomes = Array.from({ length: 200 }, () => sampleFinalState(ctx, rng));
    const lifted = outcomes.filter((outcome) => outcome.myScore > 3).length;
    expect(lifted).toBeGreaterThan(150);
  });

  it("evaluate 同时给出期望手牌分与胜率，且采样数被如实记录", () => {
    const b = belief();
    b.mySlots = [{ label: "1S", rank: 1 }, null, null, null];
    b.oppSlots.set("a", [null, null, null, null]);
    recompute(b);
    const result = evaluate(context(b, neutral), 64);
    expect(result.samples).toBe(64);
    expect(result.winProbability).toBeGreaterThanOrEqual(0);
    expect(result.winProbability).toBeLessThanOrEqual(1);
    expect(result.expectedHandScore).toBeGreaterThan(0);
  });
});

describe("clamp", () => {
  it("夹取边界", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
