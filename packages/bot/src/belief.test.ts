/**
 * 信念层单测（方案 M1 / §6.1）。
 *
 * 重点不是"函数能跑"，而是**位置位移语义与 `PrivateKnowledgeStore` 逐条对齐**。
 * 两处一旦不一致，bot 的记忆会静默错位：不抛异常、不报错，只是估计慢慢偏掉，
 * 而且极难定位。所以这里的用例刻意照着 `private-knowledge.test.ts` 的
 * 那几个场景写。
 */
import { createDeck } from "@cabo-game/shared";
import type { AgentObservation, KnownCard, PublicActionEvent } from "@cabo-game/shared";
import { describe, expect, it } from "vitest";
import {
  applyObservation,
  applyPrivateReveal,
  applyPublicAction,
  boundAt,
  boundedMeanUnseen,
  createBelief,
  knownScore,
  MEAN_CARD_RANK,
  recompute,
  resetForRound,
  unknownPositionCount,
  type Belief,
} from "./belief.js";

const card = (label: string, rank: number): KnownCard => ({ label, rank });

/** 一副牌的总点数：12 个点数 ×4 张 + 两张 K(13) + 两张 Joker(0)。 */
const DECK_TOTAL = createDeck().reduce((sum, entry) => sum + entry.rank, 0);

function beliefWithSelf(selfId = "me"): Belief {
  const belief = createBelief(selfId, "assisted");
  belief.round = 1;
  return belief;
}

function action(payload: Partial<PublicActionEvent> & { action: string; playerId: string }): PublicActionEvent {
  return { type: "action", ...payload } as PublicActionEvent;
}

describe("createBelief / recompute", () => {
  it("初始未见牌池就是整副牌", () => {
    const belief = createBelief("me", "assisted");
    expect(belief.unseenTotal).toBe(52);
    expect(belief.meanUnseen).toBeCloseTo(MEAN_CARD_RANK, 10);
    expect(MEAN_CARD_RANK).toBeCloseTo(6.5, 6);
  });

  it("认出的牌会从未见牌池里扣掉，且全量重算不累积误差", () => {
    const belief = beliefWithSelf();
    applyPrivateReveal(belief, { round: 1, memoryMode: "assisted", ownerId: "me", card: card("12H", 12), position: 1, reason: "deal" });
    expect(belief.unseen.get(12)).toBe(3);
    expect(belief.unseenTotal).toBe(51);

    // 反复重算不应该把 12 扣成 2。
    recompute(belief);
    recompute(belief);
    expect(belief.unseen.get(12)).toBe(3);
    expect(belief.unseenTotal).toBe(51);
  });

  it("弃牌堆里的牌也会离开未见牌池", () => {
    const belief = beliefWithSelf();
    applyPublicAction(belief, action({ action: "discard", playerId: "rival", discardedCard: card("11S", 11) }));
    expect(belief.unseen.get(11)).toBe(3);
    expect(belief.discardPile).toHaveLength(1);
  });

  it("每轮重置：未见牌池回到整副牌，位置记忆清空", () => {
    const belief = beliefWithSelf();
    applyPrivateReveal(belief, { round: 1, memoryMode: "assisted", ownerId: "me", card: card("9D", 9), position: 1, reason: "deal" });
    expect(belief.unseenTotal).toBe(51);

    resetForRound(belief, 2);
    expect(belief.unseenTotal).toBe(52);
    expect(belief.mySlots).toEqual([]);
    expect(belief.oppSlots.size).toBe(0);
    expect(belief.discardPile).toEqual([]);
  });

  it("round 未变化时 resetForRound 不动任何东西", () => {
    const belief = beliefWithSelf();
    applyPrivateReveal(belief, { round: 1, memoryMode: "assisted", ownerId: "me", card: card("9D", 9), position: 1, reason: "deal" });
    resetForRound(belief, 1);
    expect(belief.unseenTotal).toBe(51);
    expect(belief.mySlots[0]?.rank).toBe(9);
  });
});

describe("applyPublicAction · replace 的位置位移", () => {
  it("单张替换：替换位换成新牌，位置编号不变", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2), card("5S", 5), card("9H", 9), card("12D", 12)]);
    applyPublicAction(belief, action({
      action: "replace",
      playerId: "rival",
      positions: [3],
      replacementPosition: 3,
      discardedCards: [card("9H", 9)],
    }));
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(slots).toHaveLength(4);
    expect(slots[0]?.rank).toBe(2);
    expect(slots[1]?.rank).toBe(5);
    // 从牌堆抽的牌身份未知 —— 必须变成"未知"，不能沿用旧值。
    expect(slots[2]).toBeNull();
    expect(slots[3]?.rank).toBe(12);
  });

  it("从弃牌堆抽到的牌身份公开，落位后仍然已知", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2), card("5S", 5), card("9H", 9), card("12D", 12)]);
    belief.discardPile.push(card("1S", 1));
    applyPublicAction(belief, action({
      action: "replace",
      playerId: "rival",
      positions: [4],
      replacementPosition: 4,
      discardedCards: [card("12D", 12)],
      insertedCard: card("1S", 1),
    }));
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(slots[3]?.rank).toBe(1);
    // 从弃牌堆取走的牌要离开弃牌堆，否则会被重复扣两次。
    expect(belief.discardPile.some((entry) => entry.label === "1S")).toBe(false);
    expect(belief.discardPile.some((entry) => entry.label === "12D")).toBe(true);
  });

  it("同点塌缩：被选中的非落位牌从手牌里消失，手牌张数减少", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("12D", 12), card("12C", 12), card("5S", 5), card("3H", 3)]);
    applyPublicAction(belief, action({
      action: "replace",
      playerId: "rival",
      positions: [1, 2],
      replacementPosition: 1,
      discardedCards: [card("12D", 12), card("12C", 12)],
    }));
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBeNull();
    expect(slots[1]?.rank).toBe(5);
    expect(slots[2]?.rank).toBe(3);
    // 两张 12 都进了弃牌堆。
    expect(belief.discardPile.filter((entry) => entry.rank === 12)).toHaveLength(2);
  });
});

describe("applyPublicAction · slotBounds 上界", () => {
  it("替换位记下被换掉那张牌作为上界", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2), card("5S", 5), card("9H", 9), card("12D", 12)]);
    applyPublicAction(belief, action({
      action: "replace",
      playerId: "rival",
      positions: [3],
      replacementPosition: 3,
      discardedCards: [card("9H", 9)],
    }));
    expect(boundAt(belief, "rival", 3)).toBe(9);
    // 上界只贴在被替换的那个位置上。
    expect(boundAt(belief, "rival", 1)).toBeNull();
  });

  it("连续替换会把上界越收越紧", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("9H", 9), null, null, null]);
    applyPublicAction(belief, action({ action: "replace", playerId: "rival", positions: [1], replacementPosition: 1, discardedCards: [card("9H", 9)] }));
    expect(boundAt(belief, "rival", 1)).toBe(9);
    // 再换一次：被换掉的是上一轮抽进来的那张（这里用 4 代表）。
    belief.oppSlots.set("rival", [card("4D", 4), null, null, null]);
    applyPublicAction(belief, action({ action: "replace", playerId: "rival", positions: [1], replacementPosition: 1, discardedCards: [card("4D", 4)] }));
    expect(boundAt(belief, "rival", 1)).toBe(4);
  });

  it("插入牌身份公开时不记上界（牌已经认出来了，上界没有意义）", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [null, null, null, null]);
    belief.discardPile.push(card("3S", 3));
    applyPublicAction(belief, action({
      action: "replace",
      playerId: "rival",
      positions: [2],
      replacementPosition: 2,
      discardedCards: [card("10H", 10)],
      insertedCard: card("3S", 3),
    }));
    expect(boundAt(belief, "rival", 2)).toBeNull();
  });

  it("上界与位置数组始终等长（塌缩后不错位）", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("12D", 12), card("12C", 12), card("5S", 5), card("3H", 3)]);
    applyPublicAction(belief, action({ action: "replace", playerId: "rival", positions: [1, 2], replacementPosition: 1, discardedCards: [card("12D", 12), card("12C", 12)] }));
    const bounds = belief.slotBounds.get("rival") as Array<number | null>;
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(bounds).toHaveLength(slots.length);
    expect(bounds[0]).toBe(12);
    expect(bounds[1]).toBeNull();
    expect(bounds[2]).toBeNull();
  });

  it("boundedMeanUnseen 把池均值往低处拉，且不会低于池内最小点数", () => {
    const belief = beliefWithSelf();
    const full = boundedMeanUnseen(belief, null);
    const bounded = boundedMeanUnseen(belief, 4);
    expect(full).toBeCloseTo(MEAN_CARD_RANK, 6);
    expect(bounded).toBeLessThan(full);
    // 池里点数 ≤ 4 的是：两张 Joker(0)、四张 1、四张 2、四张 3、四张 4。
    // (0×2 + 1×4 + 2×4 + 3×4 + 4×4) / 18 = 40/18
    expect(bounded).toBeCloseTo(40 / 18, 6);
  });

  it("上界比池内所有牌都小时回落到池均值，而不是编造一张不存在的牌", () => {
    const belief = beliefWithSelf();
    // 把 Joker(0) 全部认出来，池里最小就变成 1 了。
    const jokers = belief.unseen.get(0) as number;
    for (let index = 0; index < jokers; index += 1) belief.discardPile.push(card(`J-${index}`, 0));
    recompute(belief);
    expect(belief.unseen.get(0) ?? 0).toBe(0);
    // 上界 0 在池里找不到任何一张（0 点已经全被认出来了）→ 回落池均值。
    expect(boundedMeanUnseen(belief, 0)).toBeCloseTo(belief.meanUnseen, 10);
  });

  it("上界为 0 是有效上界，不能被当成「没有上界」", () => {
    const belief = beliefWithSelf();
    // 池里有 Joker 时，上界 0 只能取到 Joker，均值必须是 0。
    expect(belief.unseen.get(0)).toBe(2);
    expect(boundedMeanUnseen(belief, 0)).toBe(0);
  });
});

describe("applyPublicAction · swap / resolve-mismatch", () => {
  it("swap 交换双方位置上的牌，上界跟着牌走", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("a", [card("1S", 1), null, null, null]);
    belief.oppSlots.set("b", [card("12D", 12), null, null, null]);
    applyPublicAction(belief, action({ action: "swap", playerId: "a", targetPlayerId: "b", ownPosition: 1, targetPosition: 1 }));
    expect((belief.oppSlots.get("a") as Array<KnownCard | null>)[0]?.rank).toBe(12);
    expect((belief.oppSlots.get("b") as Array<KnownCard | null>)[0]?.rank).toBe(1);
  });

  it("resolve-mismatch 选 right 时既有位置编号不变", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2), card("5S", 5)]);
    applyPublicAction(belief, action({ action: "resolve-mismatch", playerId: "rival", drawnPlacement: "right" }));
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(slots).toHaveLength(3);
    expect(slots[0]?.rank).toBe(2);
    expect(slots[1]?.rank).toBe(5);
    expect(slots[2]).toBeNull();
  });

  it("resolve-mismatch 选 left 会平移全部位置（这正是它该被避免的原因）", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2), card("5S", 5)]);
    applyPublicAction(belief, action({ action: "resolve-mismatch", playerId: "rival", drawnPlacement: "left" }));
    const slots = belief.oppSlots.get("rival") as Array<KnownCard | null>;
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBeNull();
    expect(slots[1]?.rank).toBe(2);
    expect(slots[2]?.rank).toBe(5);
  });

  it("resolve-mismatch 带惩罚牌时插入两张", () => {
    const belief = beliefWithSelf();
    belief.oppSlots.set("rival", [card("2C", 2)]);
    applyPublicAction(belief, action({ action: "resolve-mismatch", playerId: "rival", drawnPlacement: "right", penaltyPlacement: "right" }));
    expect(belief.oppSlots.get("rival")).toHaveLength(3);
  });
});

describe("applyObservation", () => {
  const observation = (overrides: Partial<AgentObservation>): AgentObservation => ({
    roomId: "r",
    roomName: "R",
    selfId: "me",
    revision: 1,
    state: {
      memoryMode: "assisted",
      turnDurationSeconds: 60,
      deadlineAt: 0,
      serverTime: 0,
      phase: "TURN_START",
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
        { id: "rival", name: "rival", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false },
      ],
      winners: [],
      roundHistory: [],
    },
    knowledge: { memoryMode: "assisted", round: 1, slots: [], opponents: [], held: null },
    legalActions: [],
    caboRisk: null,
    ...overrides,
  });

  it("assisted 模式下服务端快照覆盖位置记忆，但保留上界", () => {
    const belief = beliefWithSelf();
    applyPublicAction(belief, action({ action: "replace", playerId: "rival", positions: [2], replacementPosition: 2, discardedCards: [card("10H", 10)] }));
    expect(boundAt(belief, "rival", 2)).toBe(10);

    applyObservation(belief, observation({
      knowledge: {
        memoryMode: "assisted",
        round: 1,
        slots: [card("1S", 1), null, null, null],
        opponents: [{ playerId: "rival", slots: [card("7D", 7), null, null, null] }],
        held: null,
      },
    }));

    expect(belief.mySlots[0]?.rank).toBe(1);
    expect((belief.oppSlots.get("rival") as Array<KnownCard | null>)[0]?.rank).toBe(7);
    // 位置 2 服务端仍然说未知 —— 我们自己记住的上界必须活下来。
    expect(boundAt(belief, "rival", 2)).toBe(10);
  });

  it("服务端把位置认出来之后，旧上界被清掉", () => {
    const belief = beliefWithSelf();
    applyPublicAction(belief, action({ action: "replace", playerId: "rival", positions: [1], replacementPosition: 1, discardedCards: [card("10H", 10)] }));
    expect(boundAt(belief, "rival", 1)).toBe(10);

    applyObservation(belief, observation({
      knowledge: {
        memoryMode: "assisted",
        round: 1,
        slots: [],
        opponents: [{ playerId: "rival", slots: [card("3C", 3), null, null, null] }],
        held: null,
      },
    }));
    expect(boundAt(belief, "rival", 1)).toBeNull();
  });

  /**
   * 回归：`ensureDeck` 的重洗**不发事件**，只能靠恒等式自纠错。
   *
   * 恒等式是 `池 = 牌堆 + 未知手牌位`。重洗之后服务端牌堆一下变多，而 bot
   * 的弃牌堆记录没变，池子于是比它该有的还小。缺口**精确等于重洗张数**：
   * 重洗前 `池 = 牌堆 + 未知位`，重洗后牌堆多了 `弃牌堆 − 1` 张，池子没变。
   *
   * 不修的话后果很重：`sampleFinalState` 给未知手牌位发不出牌，剩下的位置
   * 回落到池均值（≈6.5），对手手牌分被整体抬高、p̂ 系统性偏高。
   */
  it("牌堆重洗：池子按恒等式自纠错，缺口精确等于重洗张数", () => {
    const belief = beliefWithSelf();
    // 4 + 4 个未知手牌位。
    applyObservation(belief, observation({ state: { ...observation({}).state, deckCount: 0 } }));
    // 攒一摞弃牌：每个点数两张，共 24 张。
    for (let rank = 1; rank <= 12; rank += 1) {
      belief.discardPile.push(card(`${rank}a`, rank), card(`${rank}b`, rank));
    }
    recompute(belief);
    expect(belief.discardPile).toHaveLength(24);
    const before = belief.unseenTotal;
    expect(before).toBe(52 - 24);

    // 重洗：牌堆一下涨到 30 张。恒等式要求池子至少有 `牌堆 + 未知手牌位` 张。
    const unknown = unknownPositionCount(belief);
    const required = 30 + unknown;
    expect(required).toBeGreaterThan(before);

    belief.deckCount = 30;
    recompute(belief);
    // 补齐到正好等于恒等式，不多不少；缺口多少张就从最老的弃牌还多少张。
    expect(belief.unseenTotal).toBe(required);
    expect(belief.discardPile).toHaveLength(24 - (required - before));
  });

  it("自纠错不会把弃牌堆吃到 0：栈顶那张是公开的，必须留着", () => {
    const belief = beliefWithSelf();
    applyObservation(belief, observation({ state: { ...observation({}).state, deckCount: 0 } }));
    belief.discardPile.push(card("12D", 12), card("11S", 11), card("1C", 1));
    recompute(belief);
    // 牌堆声称有 50 张，缺口远超弃牌堆张数 —— 只能吃到剩栈顶一张为止。
    belief.deckCount = 50;
    recompute(belief);
    expect(belief.discardPile).toHaveLength(1);
    expect(belief.discardPile[0]?.rank).toBe(1);
  });
});

describe("辅助量", () => {
  it("knownScore 只累加已知位置", () => {
    expect(knownScore([card("1S", 1), null, card("5S", 5), null])).toBe(6);
  });

  it("unknownPositionCount 统计自己与对手的未知位置", () => {
    const belief = beliefWithSelf();
    belief.mySlots = [card("1S", 1), null, null, null];
    belief.oppSlots.set("rival", [null, null, card("5S", 5), null]);
    // 自己 3 个未知 + 对手 3 个未知
    expect(unknownPositionCount(belief)).toBe(6);
  });

  it("整副牌总点数与 DECK_TOTAL 一致（防止牌组定义漂移）", () => {
    const belief = createBelief("me", "assisted");
    let total = 0;
    for (const [rank, count] of belief.unseen) total += rank * count;
    expect(total).toBe(DECK_TOTAL);
  });
});
