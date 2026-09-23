/**
 * 信念层：把 observation + event 归约成 bot 对世界的估计。
 *
 * 两条硬约束（见 docs/plans/bot-implementation-plan.md §2.2）：
 *  1. 每轮牌组会重建（`GameEngine.startRound`），所以未见牌池必须每轮重置。
 *  2. `classic` 模式下服务端不下发任何位置知识，bot 必须自己维护记忆；
 *     `assisted` 模式下服务端快照是权威的，直接覆盖。
 *
 * 位置位移语义与 `PrivateKnowledgeStore.applyAction` 严格对齐——
 * 两处若不一致，bot 的记忆会静默错位，且极难定位。
 */
import {
  createDeck,
  type AgentObservation,
  type KnownCard,
  type PublicActionEvent,
  type PrivateRevealMessage,
} from "@cabo-game/shared";

export interface Belief {
  /** 当前回合号；变化即触发整轮重置。 */
  round: number;
  selfId: string;
  memoryMode: "classic" | "assisted";
  /** 自己每个位置已知的牌。 */
  mySlots: Array<KnownCard | null>;
  /** 对手每个位置已知的牌。 */
  oppSlots: Map<string, Array<KnownCard | null>>;
  /**
   * 每个位置的上界：该位置**最近一次被替换掉**的牌的点数。
   *
   * 为什么需要它：玩家不会用一张更差的牌换掉好牌，所以"这里被替换过"本身
   * 就是信息——新牌 ≤ 旧牌。旧牌是公开进弃牌堆的，于是它给未知位置提供了一个
   * 上界，而且每被替换一次就收紧一次，天然跟踪对手的持续优化。
   *
   * 不记这个界的代价实测很大：对手的未知位置按未见牌池均值估计约 5 点，
   * 实际只有 3.79 点，于是对手平均终局分被高估 2.4 分，p̂ 系统性偏高。
   */
  slotBounds: Map<string, Array<number | null>>;
  /** 已公开的弃牌堆（栈底 → 栈顶）。 */
  discardPile: KnownCard[];
  /** 自己已抽出但尚未落位的牌。 */
  held: KnownCard | null;
  /** 上一次观察到的牌堆张数，用于检测牌堆耗尽后的重洗。 */
  deckCount: number;
  /**
   * 本轮已经开始的回合数（每次有人从牌堆或弃牌堆摸牌就 +1）。
   *
   * 用途是**活性**：引擎没有回合上限，牌堆空了会把弃牌堆重洗回牌堆，
   * 所以一轮理论上可以无限进行下去。全员保守时就会真的无限进行下去
   * （实测把阈值调到 1.5 倍后 86% 的对局卡在步数上限）。机器人不能靠
   * 外部超时来兜底，必须自己有一条"这轮打太久了"的退出路径。
   */
  turnCount: number;
  /** 未见牌池：点数 → 尚未确定身份的剩余张数。 */
  unseen: Map<number, number>;
  unseenTotal: number;
  /** 未见牌池的加权平均点数，即"一张未知牌的期望分"。 */
  meanUnseen: number;
}

/** 牌组全量点数分布，直接由 `createDeck()` 推导，避免与引擎规则漂移。 */
const FULL_DECK_COUNTS: ReadonlyMap<number, number> = (() => {
  const counts = new Map<number, number>();
  for (const card of createDeck()) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
})();

/** 一副牌的期望点数（6.5）。 */
export const MEAN_CARD_RANK = (() => {
  let sum = 0;
  let total = 0;
  for (const [rank, count] of FULL_DECK_COUNTS) {
    sum += rank * count;
    total += count;
  }
  return sum / total;
})();

/** 每回合每个已知位置的遗忘概率系数，乘以 (1 − memoryFidelity)。 */
const FORGET_RATE = 0.15;

export function createBelief(selfId = "", memoryMode: "classic" | "assisted" = "classic"): Belief {
  const belief: Belief = {
    round: 0,
    selfId,
    memoryMode,
    mySlots: [],
    oppSlots: new Map(),
    slotBounds: new Map(),
    discardPile: [],
    held: null,
    deckCount: 0,
    turnCount: 0,
    unseen: new Map(),
    unseenTotal: 0,
    meanUnseen: MEAN_CARD_RANK,
  };
  recompute(belief);
  return belief;
}

export function resetForRound(belief: Belief, round: number): Belief {
  if (belief.round === round) return belief;
  belief.round = round;
  belief.mySlots = [];
  belief.oppSlots = new Map();
  belief.slotBounds = new Map();
  belief.discardPile = [];
  belief.held = null;
  belief.deckCount = 0;
  belief.turnCount = 0;
  recompute(belief);
  return belief;
}

/**
 * 从未见牌池重算。
 *
 * 恒等式：未见牌池 = 全量牌组 − 已确定身份的牌。
 * 每次更新后全量重算，天然自纠错，避免增量扣减累积误差。
 */
export function recompute(belief: Belief): void {
  buildCounts(belief);
  // 池子自纠错，见 `repairPool` 的说明。
  let guard = 0;
  while (belief.unseenTotal < requiredPool(belief) && belief.discardPile.length > 1 && guard < 256) {
    belief.discardPile.shift();
    buildCounts(belief);
    guard += 1;
  }
}

function buildCounts(belief: Belief): void {
  const counts = new Map<number, number>(FULL_DECK_COUNTS);
  const consume = (rank: number): void => {
    const remaining = counts.get(rank);
    if (remaining !== undefined && remaining > 0) counts.set(rank, remaining - 1);
  };

  for (const card of belief.mySlots) if (card) consume(card.rank);
  for (const slots of belief.oppSlots.values()) {
    for (const card of slots) if (card) consume(card.rank);
  }
  for (const card of belief.discardPile) consume(card.rank);
  if (belief.held) consume(belief.held.rank);

  let total = 0;
  let weighted = 0;
  for (const [rank, count] of counts) {
    if (count <= 0) continue;
    total += count;
    weighted += rank * count;
  }
  belief.unseen = counts;
  belief.unseenTotal = total;
  belief.meanUnseen = total > 0 ? weighted / total : MEAN_CARD_RANK;
}

/**
 * 未见牌池的**硬下界**。
 *
 * 恒等式：`池 = 牌堆 + 未知手牌位置`。
 *
 * 手上那张（`held`）已经同时离开牌堆和手牌位，所以它不在等式两边，
 * 不需要加进来。弃牌堆也不在等式里——弃掉的牌既不在牌堆也不在手上。
 */
function requiredPool(belief: Belief): number {
  let unknown = 0;
  for (const card of belief.mySlots) if (!card) unknown += 1;
  for (const slots of belief.oppSlots.values()) {
    for (const card of slots) if (!card) unknown += 1;
  }
  return belief.deckCount + unknown;
}

/**
 * 池子自纠错：把被错误扣掉的牌还回池子。
 *
 * 触发条件是真实存在的，而且**引擎不会发事件**：牌堆抽空时 `ensureDeck` 会把
 * 整个弃牌堆重洗回牌堆（只留栈顶一张）。但弃牌堆是 bot 自己按公开事件攒的，
 * 重洗没有对应事件，于是 bot 会一直把那一摞牌当成"已经出局"。
 *
 * 后果不是"略微偏一点"，而是很重：池子凭空少掉十几张之后，
 * `sampleFinalState` 给未知手牌位发不出牌，剩下的位置回落到**池均值**（≈6.5），
 * 对手的手牌分被整体抬高、看起来更差，p̂ 于是系统性偏高。
 * 实测（200 局 mnemo vs 3×chill）：**10.6% 的抽样**出现缺口，最大缺口 **13 张**。
 *
 * 修法不去猜"哪一次是重洗"，而是直接维护恒等式：池子比
 * `牌堆 + 未知手牌位` 还小，就说明有牌被错当成弃牌，从**最老**的弃牌开始还。
 * 保留最后一张是因为重洗只留栈顶。
 *
 * 顺带一提，这个缺口是**精确等于**重洗张数的：重洗前 `池 = 牌堆 + 未知位`，
 * 重洗后服务端牌堆多了 `弃牌堆 − 1` 张，而 bot 的池子没变，所以
 * `缺口 = 弃牌堆 − 1`。也就是说这个修法不是近似，是把它算准。
 */

function slotsFor(belief: Belief, playerId: string): Array<KnownCard | null> {
  if (playerId === belief.selfId) return belief.mySlots;
  let slots = belief.oppSlots.get(playerId);
  if (!slots) {
    slots = [];
    belief.oppSlots.set(playerId, slots);
  }
  return slots;
}

function boundsFor(belief: Belief, playerId: string): Array<number | null> {
  let bounds = belief.slotBounds.get(playerId);
  if (!bounds) {
    bounds = [];
    belief.slotBounds.set(playerId, bounds);
  }
  return bounds;
}

/** 上界只在位置未知时才有意义；牌一旦认出来就把它清掉。 */
function fitBounds(bounds: Array<number | null>, slots: ReadonlyArray<KnownCard | null>, length: number): Array<number | null> {
  const next = bounds.slice(0, length);
  while (next.length < length) next.push(null);
  for (let index = 0; index < length; index += 1) {
    if (slots[index]) next[index] = null;
  }
  return next;
}

/**
 * 取一个玩家的位置数组与上界数组，并保证两者等长且已对齐。
 *
 * 两个数组必须始终等长——上界数组一旦落后于位置数组，后面所有位置的
 * 上界都会静默错位。这类错误不会抛异常，只会让估计慢慢偏掉，所以
 * 每次读取都强制对齐一次。
 *
 * `minLength` 用来处理一个真实的时序陷阱：harness 里事件**先于**观察到达
 * （与线上一致），所以第一回合的 `applyPublicAction` 会在数组还没被
 * `applyObservation` 定长之前就跑起来。此时若不按动作里的位置先把数组撑开，
 * 上界会写进一个长度为 0 的数组里被丢掉，而且之后再也补不回来。
 */
function trackedSlots(
  belief: Belief,
  playerId: string,
  minLength = 0,
): { slots: Array<KnownCard | null>; bounds: Array<number | null> } {
  const slots = slotsFor(belief, playerId);
  while (slots.length < minLength) slots.push(null);
  const bounds = fitBounds(boundsFor(belief, playerId), slots, slots.length);
  belief.slotBounds.set(playerId, bounds);
  return { slots, bounds };
}

/** 动作里出现过的最大位置编号，用来把数组撑到足够长。 */
function highestPosition(positions: readonly number[]): number {
  let highest = 0;
  for (const position of positions) if (position > highest) highest = position;
  return highest;
}

function fit(slots: Array<KnownCard | null>, length: number): Array<KnownCard | null> {
  const next = slots.slice(0, length);
  while (next.length < length) next.push(null);
  return next;
}

/** 把 observation 合并进信念。assisted 模式下服务端快照直接覆盖位置记忆。 */
export function applyObservation(belief: Belief, observation: AgentObservation): Belief {
  const { state, knowledge } = observation;
  belief.selfId = observation.selfId;
  belief.memoryMode = state.memoryMode;
  if (belief.round !== state.round) resetForRound(belief, state.round);
  belief.deckCount = state.deckCount;

  for (const player of state.players) {
    if (player.id === observation.selfId) {
      belief.mySlots = fit(belief.mySlots, player.cardCount);
      belief.slotBounds.set(observation.selfId, fitBounds(boundsFor(belief, observation.selfId), belief.mySlots, player.cardCount));
    } else {
      const slots = fit(belief.oppSlots.get(player.id) ?? [], player.cardCount);
      belief.oppSlots.set(player.id, slots);
      belief.slotBounds.set(player.id, fitBounds(boundsFor(belief, player.id), slots, player.cardCount));
    }
  }

  // 自己抽到的牌两种模式都由服务端下发（classic 也保留未落位的 held）。
  belief.held = copyCard(knowledge.held);

  if (state.memoryMode === "assisted") {
    // 服务端快照对"牌的身份"是权威的，但对"这个位置曾经被换掉过哪张牌"一无所知。
    // 所以这里只覆盖身份，上界原样保留（牌认出来时由 fitBounds 清掉）。
    belief.mySlots = knowledge.slots.map(copyCard);
    belief.slotBounds.set(observation.selfId, fitBounds(boundsFor(belief, observation.selfId), belief.mySlots, belief.mySlots.length));
    for (const opponent of knowledge.opponents) {
      const slots = opponent.slots.map(copyCard);
      belief.oppSlots.set(opponent.playerId, slots);
      belief.slotBounds.set(opponent.playerId, fitBounds(boundsFor(belief, opponent.playerId), slots, slots.length));
    }
  }

  recompute(belief);
  return belief;
}

/** 合并一次私密揭示。`ownerId` 决定这张牌属于自己还是某个对手。 */
export function applyPrivateReveal(belief: Belief, reveal: PrivateRevealMessage): Belief {
  if (belief.round !== reveal.round) resetForRound(belief, reveal.round);
  const card: KnownCard = { label: reveal.card.label, rank: reveal.card.rank };
  if (reveal.reason === "draw") {
    belief.held = card;
    recompute(belief);
    return belief;
  }
  if (reveal.position === undefined) return belief;
  const { slots, bounds } = trackedSlots(belief, reveal.ownerId, reveal.position);
  slots[reveal.position - 1] = card;
  bounds[reveal.position - 1] = null;
  recompute(belief);
  return belief;
}

/** 合并一次公开动作事件。位置位移语义与 `PrivateKnowledgeStore.applyAction` 一致。 */
export function applyPublicAction(belief: Belief, action: PublicActionEvent): Belief {
  switch (action.action) {
    case "replace": {
      const { slots, bounds } = trackedSlots(
        belief,
        action.playerId,
        highestPosition([...action.positions, action.replacementPosition]),
      );
      const inserted = action.playerId === belief.selfId && belief.held
        ? belief.held
        : action.insertedCard ? { ...action.insertedCard } : null;
      if (action.insertedCard) takeFromDiscard(belief, action.insertedCard);
      // 被替换掉的牌会公开进入弃牌堆。漏掉这一步会让这些牌一直留在未见牌池里，
      // 而玩家弃掉的通常是大牌 —— 于是对手的手牌被系统性高估、p̂ 被系统性高估。
      for (const card of action.discardedCards) belief.discardPile.push({ ...card });
      // `discardedCards` 按位置升序给出（引擎 `replaceHeld` 里 selected 的顺序），
      // 所以替换位的上界就是同序号的那张弃牌。
      const ordered = [...action.positions].sort((left, right) => left - right);
      const boundIndex = ordered.indexOf(action.replacementPosition);
      const newBound = inserted ? null : (boundIndex >= 0 ? action.discardedCards[boundIndex]?.rank ?? null : null);
      const selected = new Set(action.positions);
      const next = slots.flatMap((card, index) => {
        const position = index + 1;
        if (!selected.has(position)) return [card];
        return position === action.replacementPosition ? [inserted] : [];
      });
      const nextBounds = bounds.flatMap((value, index) => {
        const position = index + 1;
        if (!selected.has(position)) return [value];
        return position === action.replacementPosition ? [newBound] : [];
      });
      slots.splice(0, slots.length, ...next);
      bounds.splice(0, bounds.length, ...nextBounds);
      if (action.playerId === belief.selfId) belief.held = null;
      break;
    }
    case "exchange-mismatch": {
      const { slots, bounds } = trackedSlots(belief, action.playerId, highestPosition(action.positions));
      action.positions.forEach((position, index) => {
        const revealed = action.revealedCards[index];
        slots[position - 1] = revealed ? { ...revealed } : null;
        if (revealed) bounds[position - 1] = null;
      });
      break;
    }
    case "resolve-mismatch": {
      const { slots, bounds } = trackedSlots(belief, action.playerId);
      const inserted = action.playerId === belief.selfId && belief.held
        ? belief.held
        : action.insertedCard ? { ...action.insertedCard } : null;
      if (action.insertedCard) takeFromDiscard(belief, action.insertedCard);
      insertAtEnd(slots, inserted, action.drawnPlacement);
      insertAtEnd(bounds, null, action.drawnPlacement);
      if (action.penaltyPlacement) {
        insertAtEnd(slots, null, action.penaltyPlacement);
        insertAtEnd(bounds, null, action.penaltyPlacement);
      }
      if (action.playerId === belief.selfId) belief.held = null;
      break;
    }
    case "discard": {
      belief.discardPile.push({ ...action.discardedCard });
      if (action.playerId === belief.selfId) belief.held = null;
      break;
    }
    case "draw-deck": {
      // 这里**曾经**有一个"牌堆为空就清空弃牌堆记录"的启发式，用来处理
      // `ensureDeck` 的重洗。它不可靠：事件是先于观察到达的，处理事件时
      // `belief.deckCount` 还是上一帧的旧值，所以它几乎不触发——实测
      // 10.6% 的抽样仍带着最多 13 张的池子缺口。
      //
      // 现在重洗统一由 `recompute` 的恒等式自纠错处理，不依赖事件时序。
      belief.turnCount += 1;
      break;
    }
    case "swap": {
      const { slots: own, bounds: ownBounds } = trackedSlots(belief, action.playerId, action.ownPosition);
      const { slots: target, bounds: targetBounds } = trackedSlots(belief, action.targetPlayerId, action.targetPosition);
      const ownCard = own[action.ownPosition - 1] ?? null;
      const targetCard = target[action.targetPosition - 1] ?? null;
      const ownBound = ownBounds[action.ownPosition - 1] ?? null;
      const targetBound = targetBounds[action.targetPosition - 1] ?? null;
      own[action.ownPosition - 1] = targetCard;
      target[action.targetPosition - 1] = ownCard;
      // 上界跟着牌走：位置换到手之后装的是对方的牌，所以继承对方那个位置的上界；
      // 装的是已知牌就没有上界可言。
      ownBounds[action.ownPosition - 1] = targetCard ? null : targetBound;
      targetBounds[action.targetPosition - 1] = ownCard ? null : ownBound;
      break;
    }
    case "draw-discard":
      belief.turnCount += 1;
      break;
    case "peek-self":
    case "peek-other":
    case "skip":
    case "cabo":
      break;
  }
  recompute(belief);
  return belief;
}

/** 从弃牌堆取走一张牌（`draw-discard` 的后续落位）。 */
function takeFromDiscard(belief: Belief, card: KnownCard): void {
  const index = belief.discardPile.findIndex((entry) => entry.rank === card.rank && entry.label === card.label);
  if (index >= 0) belief.discardPile.splice(index, 1);
}

function insertAtEnd<T>(slots: T[], card: T, placement: "left" | "right"): void {
  if (placement === "left") slots.unshift(card);
  else slots.push(card);
}

/**
 * 记忆衰减：按 `1 − memoryFidelity` 的概率遗忘已知位置。
 *
 * 只在 `classic` 模式下生效——`assisted` 模式的位置记忆由服务端权威下发，
 * 遗忘会被下一次 observation 覆盖，没有意义。
 */
export function degrade(belief: Belief, memoryFidelity: number, rng: () => number): Belief {
  if (belief.memoryMode === "assisted" || memoryFidelity >= 1) return belief;
  const forgetChance = (1 - memoryFidelity) * FORGET_RATE;
  if (forgetChance <= 0) return belief;
  let changed = false;
  const sweep = (slots: Array<KnownCard | null>): void => {
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index] && rng() < forgetChance) {
        slots[index] = null;
        changed = true;
      }
    }
  };
  sweep(belief.mySlots);
  for (const slots of belief.oppSlots.values()) sweep(slots);
  if (changed) recompute(belief);
  return belief;
}

export function copyCard(card: KnownCard | null): KnownCard | null {
  return card ? { ...card } : null;
}

/** 未知位置的张数（自己的 + 对手的）。 */
export function unknownPositionCount(belief: Belief): number {
  let count = 0;
  for (const card of belief.mySlots) if (!card) count += 1;
  for (const slots of belief.oppSlots.values()) {
    for (const card of slots) if (!card) count += 1;
  }
  return count;
}

/** 已知位置的点数之和。 */
export function knownScore(slots: ReadonlyArray<KnownCard | null>): number {
  let sum = 0;
  for (const card of slots) if (card) sum += card.rank;
  return sum;
}

/** 某个位置的上界（最近一次被替换掉的牌的点数），没有则返回 null。`position` 从 1 开始。 */
export function boundAt(belief: Belief, playerId: string, position: number): number | null {
  return belief.slotBounds.get(playerId)?.[position - 1] ?? null;
}

/**
 * 未见牌池里点数 ≤ `bound` 的那些牌的平均点数。
 *
 * 这就是"对手愿意用抽到的牌换掉旧牌"这条推理的落地：新牌必然 ≤ 旧牌，
 * 于是旧牌是个上界。`bound` 为 null 时退化成池均值。
 */
export function boundedMeanUnseen(belief: Belief, bound: number | null): number {
  const fallback = belief.unseenTotal > 0 ? belief.meanUnseen : MEAN_CARD_RANK;
  if (bound === null) return fallback;
  let total = 0;
  let weighted = 0;
  for (const [rank, count] of belief.unseen) {
    if (count <= 0 || rank > bound) continue;
    total += count;
    weighted += rank * count;
  }
  return total > 0 ? weighted / total : fallback;
}
