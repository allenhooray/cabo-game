/**
 * 评估层：把信念折算成可比较的数值。
 *
 * 核心是方法论文档里的闭式阈值：宣告 Cabo ⟺ P(严格最低) > 5 / (H + 5)。
 * 推导：宣告期望 (1−P)(H+5)，不宣告期望 H，令两者相等即得。
 * 人格参数 `cautionFactor` 作为该阈值的倍率，是风险偏好的唯一支点。
 */
import type { AgentObservation } from "@cabo-game/shared";
import { MEAN_CARD_RANK, boundAt, boundedMeanUnseen, knownScore, type Belief } from "./belief.js";
import { opponentDiscount, type BotPersona } from "./persona.js";

export interface Evaluation {
  expectedHandScore: number;
  winProbability: number;
  samples: number;
}

export interface EvaluationContext {
  belief: Belief;
  observation: AgentObservation;
  persona: BotPersona;
  rng: () => number;
}

/** 单张未知牌的期望点数，含乐观偏置与对手理性折扣。 */
export function unknownCardValue(belief: Belief, persona: BotPersona, discount = 1, bound: number | null = null): number {
  return boundedMeanUnseen(belief, bound) * discount * (1 - persona.optimismBias);
}

/**
 * 继续打下去后的期望手牌分。
 *
 * 注意这里**不打对手理性折扣**：ρ 是为了修正"对手会留好牌"导致的偏差，
 * 而自己那些没认出来的牌就是未见牌池里的一张普通牌，没有额外信息可言。
 * 误用 ρ 会低估自己的手牌分，进而把 Cabo 阈值推高（实测低置信区间
 * 自己的手牌分被低估约 1.6 分）。
 *
 * 默认不做"继续打会变好"的折扣（`HAND_IMPROVEMENT_DISCOUNT = 1`）。注意偏差方向：
 * 用当前期望分当作最终分，会高估继续打下去的收益，从而**偏激进**地宣告。
 * 是否要打折应由分桶校准检验来定，而不是凭感觉设一个魔数。
 */
export const HAND_IMPROVEMENT_DISCOUNT = 1;

export function expectedHandScore(belief: Belief, persona: BotPersona): number {
  let score = 0;
  belief.mySlots.forEach((card, index) => {
    score += card ? card.rank : unknownCardValue(belief, persona, 1, boundAt(belief, belief.selfId, index + 1));
  });
  return score * HAND_IMPROVEMENT_DISCOUNT;
}

export function opponentExpectedScore(belief: Belief, persona: BotPersona, playerId: string): number {
  const slots = belief.oppSlots.get(playerId) ?? [];
  const discount = opponentDiscount(persona);
  let score = 0;
  slots.forEach((card, index) => {
    score += card ? card.rank : unknownCardValue(belief, persona, discount, boundAt(belief, playerId, index + 1));
  });
  return score;
}

/** 牌堆余量对未知牌估计的影响：牌堆越空，未见牌池越接近真实。 */
export function expandUnseen(belief: Belief): number[] {
  const pool: number[] = [];
  for (const [rank, count] of belief.unseen) {
    for (let index = 0; index < count; index += 1) pool.push(rank);
  }
  return pool;
}

function countUnknown(slots: ReadonlyArray<unknown>): number {
  let count = 0;
  for (const card of slots) if (!card) count += 1;
  return count;
}

export function activeOpponentIds(observation: AgentObservation, selfId: string): string[] {
  return observation.state.players
    .filter((player) => player.id !== selfId && !player.forfeited)
    .map((player) => player.id);
}

/**
 * 蒙特卡洛胜率：我最终手牌分是否**严格低于所有对手**。
 *
 * 这里必须模拟"宣告之后会发生什么"，否则 p̂ 会系统性高估。两个建模要点
 * 都是校准检验（方案 §6.2）抓出来的真问题：
 *
 *  1. 其余存活玩家各得一个最终回合，会继续改善手牌。
 *     只按"手牌冻结"估计，实测宣告成功率会掉到 13%–27%。
 *  2. 对手的最终回合若抽出 11/12 并弃掉，就能发动交换，**把我最低的牌换成
 *     他最高的牌**。这个风险只在我本来会赢时才改变结果——低 p̂ 区间我本来
 *     就在输，换不换都一样；高 p̂ 区间它直接把我从赢翻成输。这解释了为什么
 *     校准偏差随 p̂ 单调放大（60–80% 区间实测只有 30% 成功率）。
 */
export function winProbability(context: EvaluationContext, samples = 300): number {
  const { rng } = context;
  let wins = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const outcome = sampleFinalState(context, rng);
    if (outcome.rivalScores.every((score) => outcome.myScore < score)) wins += 1;
  }
  return wins / samples;
}

/** 一次抽样得到的"宣告之后"终局。 */
export interface SampledFinalState {
  myScore: number;
  rivalScores: number[];
}

/**
 * 抽一次终局。
 *
 * 单独暴露出来是为了让校准诊断（`harness/diagnose.ts`）能把我方终局分和
 * 对手终局分**分开**和实际值对照。只看 p̂ 的偏差只能知道"哪一段错了"，
 * 看到是"对手终局分被高估 8 分"还是"我方终局分被低估 3 分"才知道该改哪。
 *
 * 两个曾把校准带偏的建模点，都是这样量出来的：
 *
 *  1. 未知位置要按 `boundAt` 的上界抽牌，不能按池均值。对手整轮都在用低牌
 *     换高牌，"这个位置被换过"意味着新牌 ≤ 被换掉的旧牌（旧牌是公开的）。
 *     按池均值抽会让对手平均终局分高估 2.4 分。
 *  2. 对手的换牌**不是只换我**。实测 905 次换牌里只有 37.8% 目标是宣告者，
 *     其余都换了别人。把目标写死成我，会凭空给我加 2.1 分的伤害，而实际只有 0.5 分。
 */
export function sampleFinalState(context: EvaluationContext, rng: () => number): SampledFinalState {
  const { belief, observation, persona } = context;
  const discount = opponentDiscount(persona);

  const rivalIds = activeOpponentIds(observation, belief.selfId);
  const myUnknown = countUnknown(belief.mySlots);
  const rivals = rivalIds.map((id) => {
    const slots = belief.oppSlots.get(id) ?? [];
    const known: number[] = [];
    const bounds: Array<number | null> = [];
    let unknown = 0;
    slots.forEach((card, index) => {
      if (card) {
        known.push(card.rank);
        bounds.push(null);
      } else {
        unknown += 1;
        bounds.push(boundAt(belief, id, index + 1));
      }
    });
    return { known, unknown, bounds };
  });
  if (rivals.length === 0) return { myScore: knownScore(belief.mySlots), rivalScores: [] };

  // 注意这里**不能**因为"所有牌都认出来了"就提前返回已知分。
  // 认得出牌不等于对手不会有最终回合：他们照样能摸一张牌、替换最高分、
  // 或者摸到 11/12 发动换牌。早返回会让最确定的那些局面变成"必胜"，
  // 而实测这些局面的真实胜率只有 80% 左右。
  const pool = expandUnseen(belief);
  // 未见牌池恰好分成两堆：牌堆（`deckCount` 张）和还没认出来的手牌
  // （`totalUnknown` 张）。两者必须分开抽。
  //
  // 混在一起抽曾经是校准偏差的最大来源：认得越多，池越小，给手牌填完位置
  // 之后池就见底了，对手的最终回合抽牌只能回落到"期望值"这个小数——
  // 一个永远不会等于 11/12 的数。于是换牌能力凭空消失，p̂ 冲到 99%
  // （实测该桶实际只有 48.5%）。对手是从**牌堆**抽的，牌堆里的牌和手牌里的
  // 牌本来就不重叠，分开抽才是对的。
  const deckCount = Math.max(0, Math.min(belief.deckCount, pool.length));
  const totalUnknown = myUnknown + rivals.reduce((sum, rival) => sum + rival.unknown, 0);
  const shuffled = pool.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(rng() * (index + 1));
    const value = shuffled[index] as number;
    shuffled[index] = shuffled[swapWith] as number;
    shuffled[swapWith] = value;
  }
  // 未知手牌位是**硬约束**：每个位置都必须落到一张真实的牌上。池子不够时
  // 先缩牌堆、绝不缩手牌池——手牌池不够会让剩下的位置回落到池均值（≈6.5），
  // 把对手的手牌分整体抬高。池子本身由 `belief.recompute` 的自纠错保证
  // 不会因为牌堆重洗而缩水（那是这个缺口的历史来源，实测 10.6% 的抽样）。
  const handCount = Math.min(totalUnknown, shuffled.length);
  const deckCountEffective = Math.max(0, Math.min(deckCount, shuffled.length - handCount));
  const handPool = shuffled.slice(0, handCount);
  // 牌堆那一堆必须**正好** `deckCount` 张。写成 `slice(handCount)` 会把池里
  // 剩下的牌全当成牌堆，于是在 `deckCount = 0` 的局面下对手照样能抽牌换牌。
  const deckPool = shuffled.slice(handCount, handCount + deckCountEffective);
  const fallback = unknownCardValue(belief, persona, discount);
  const deckFallback = unknownCardValue(belief, persona, 1);

  // hands[0] 是我，hands[1..] 按对手顺序。换牌要能看到所有玩家，
  // 所以先把牌桌铺开再逐个跑最终回合。
  const hands: number[][] = [[]];
  for (let index = 0; index < myUnknown; index += 1) {
    hands[0]!.push(drawBounded(handPool, boundAt(belief, belief.selfId, index + 1), rng, belief));
  }
  for (const card of belief.mySlots) if (card) hands[0]!.push(card.rank);

  for (const rival of rivals) {
    const hand = rival.known.slice();
    for (let index = 0; index < rival.unknown; index += 1) {
      hand.push(drawBounded(handPool, rival.bounds[index] ?? null, rng, belief));
    }
    hands.push(hand);
  }

  for (let index = 1; index < hands.length; index += 1) {
    rivalFinalTurn(hands[index] as number[], hands, index, deckPool, belief.discardPile, rng, fallback, deckFallback);
  }

  // 对手的交换会改写 hands[0]，所以我的终局分必须在所有对手行动之后再取。
  return { myScore: sum(hands[0] as number[]), rivalScores: hands.slice(1).map((hand) => sum(hand)) };
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) > (values[best] as number)) best = index;
  }
  return best;
}

function argmin(values: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] as number) < (values[best] as number)) best = index;
  }
  return best;
}

/**
 * 模拟对手的最后一个回合，就地改写牌桌，返回该对手的最终分数。
 *
 * 对手只有一次动作，所以下面两条路**互斥**：
 *  A. 抽到 11/12 就弃掉它发动交换——自己手牌不变，但把**某个目标**的最低牌
 *     换成自己的最高牌。目标要在所有其他玩家（含其他对手）里挑，不能写死成我。
 *  B. 否则改善手牌——替换最高分，或同点塌缩，取更优者。
 *
 * 塌缩的威力必须建模：一对 12 塌缩是 `−24 + 抽到的牌`，一次能砍掉十几分。
 * 漏掉 A 或 B 都会让 p̂ 系统性高估（见 `sampleFinalState` 的注释）。
 */
function rivalFinalTurn(
  ownHand: number[],
  hands: number[][],
  ownIndex: number,
  deckPool: number[],
  discardPile: ReadonlyArray<{ rank: number }>,
  rng: () => number,
  fallback: number,
  deckFallback: number,
): number {
  if (ownHand.length === 0) return 0;
  const drawn = rivalDraw(deckPool, discardPile, rng);
  // 牌堆和弃牌堆都空了：引擎那边这一回合直接结束（`skipPower` 的退化分支），
  // 对手没有任何改善机会。这里必须如实返回，不能塞一张"期望值"小数进去。
  if (drawn === null) return sum(ownHand);

  if ((drawn === 11 || drawn === 12) && hands.length > 1) {
    const ownMaxIndex = argmax(ownHand);
    const ownMax = ownHand[ownMaxIndex] as number;
    // 理性的目标选择：谁的**最低牌**最小就换谁。换完之后目标拿到我的最高牌，
    // 我拿到他的最低牌，我的净收益是 `目标最低 − 自己最高`，所以取最小的那个。
    let targetIndex = -1;
    let targetSlot = -1;
    let targetMin = Number.POSITIVE_INFINITY;
    for (let index = 0; index < hands.length; index += 1) {
      if (index === ownIndex) continue;
      const hand = hands[index] as number[];
      if (hand.length === 0) continue;
      const slot = argmin(hand);
      const value = hand[slot] as number;
      if (value < targetMin) {
        targetMin = value;
        targetIndex = index;
        targetSlot = slot;
      }
    }
    if (targetIndex >= 0 && ownMax > targetMin) {
      ownHand[ownMaxIndex] = targetMin;
      (hands[targetIndex] as number[])[targetSlot] = ownMax;
      return sum(ownHand);
    }
  }

  let bestScore = sum(ownHand);
  let bestHand: number[] | null = null;

  const replaced = ownHand.slice();
  replaced[argmax(ownHand)] = drawn;
  if (sum(replaced) < bestScore) {
    bestScore = sum(replaced);
    bestHand = replaced;
  }

  const counts = new Map<number, number>();
  for (const card of ownHand) counts.set(card, (counts.get(card) ?? 0) + 1);
  for (const [rank, count] of counts) {
    if (count < 2) continue;
    const collapsed = ownHand.filter((card) => card !== rank);
    collapsed.push(drawn);
    const score = sum(collapsed);
    if (score < bestScore) {
      bestScore = score;
      bestHand = collapsed;
    }
  }

  if (bestHand) {
    ownHand.length = 0;
    ownHand.push(...bestHand);
  }
  return bestScore;
}

/**
 * 对手抽牌，抽不到返回 `null`。
 *
 * 牌堆还有牌就从牌堆抽；牌堆空了，引擎会把弃牌堆重洗回牌堆（`ensureDeck`），
 * 此时等价于从弃牌堆抽。这一步不能省——如果在这里回落到"期望值"这个小数，
 * 就永远抽不到 11/12，交换能力会凭空消失，p̂ 在高置信区间会离谱地高
 * （实测 p̂≈99% 的桶实际只有 51% 成功率，全是这种"我的 0 分王被换走"的案例）。
 */
function rivalDraw(
  deckPool: number[],
  discardPile: ReadonlyArray<{ rank: number }>,
  rng: () => number,
): number | null {
  if (deckPool.length > 0) return draw(deckPool, rng);
  if (discardPile.length > 0) {
    const index = Math.floor(rng() * discardPile.length);
    return (discardPile[index] as { rank: number }).rank;
  }
  return null;
}

/** 从工作池里无放回抽一张。调用前必须保证池非空。 */
function draw(pool: number[], rng: () => number): number {
  const index = Math.floor(rng() * pool.length);
  const value = pool[index] as number;
  const last = pool.pop() as number;
  if (index < pool.length) pool[index] = last;
  return value;
}

/**
 * 带上界地从工作池抽一张：只在点数 ≤ `bound` 的候选里挑。
 *
 * 这就是"对手换过牌"这条信息的采样落地。池里没有满足条件的牌时回落到
 * `boundedMeanUnseen`，避免为了满足上界而编造一张不存在的牌。
 */
function drawBounded(pool: number[], bound: number | null, rng: () => number, belief: Belief): number {
  if (pool.length === 0) return boundedMeanUnseen(belief, bound);
  if (bound === null) return draw(pool, rng);
  const candidates: number[] = [];
  for (let index = 0; index < pool.length; index += 1) {
    if ((pool[index] as number) <= bound) candidates.push(index);
  }
  if (candidates.length === 0) return boundedMeanUnseen(belief, bound);
  const pick = candidates[Math.floor(rng() * candidates.length)] as number;
  const value = pool[pick] as number;
  const last = pool.pop() as number;
  if (pick < pool.length) pool[pick] = last;
  return value;
}

/**
 * 续打价值模型的拟合参数：`δ(H) = max(FLOOR, SLOPE · (H − KNEE))`。
 *
 * δ 是"继续打下去手牌分平均能降多少"，即 `H − E[H_final]`。
 * 三个常数来自 `harness/continuation.ts` 的实测（300 局、11.1 万个未宣告观测点）：
 *
 *   当前 H    实测 δ   实测最优门槛
 *    1.44    −2.69      0.359
 *    7.16     0.08      0.417
 *   13.85     4.04      0.479
 *   22.67     9.04      0.507
 *   29.02    13.65      0.548
 *   35.54    20.11      0.619
 *
 * `SLOPE = 0.62`、`KNEE = 6.8` 是对这六行的最小二乘拟合。注意拟合质量要在
 * **门槛**上衡量，不是在 δ 上：δ 本身残差最大到 ±1.3 分（曲线不是直线），
 * 但门槛要除以 `H + 5`，误差被压到 ±0.06 以内。对决策有意义的量是门槛。
 *
 * `FLOOR = −2.7` 是低手牌分那一端的饱和值——注意它是**负**的：手牌已经很低时，
 * 继续打下去反而会让分数上升，因为对手的最终回合可能用 11/12 把我的手牌换走。
 * 所以"手牌很好"并不等于"越等越好"，反而更该锁定。
 */
const DELTA_SLOPE = 0.62;
const DELTA_KNEE = 6.8;
const DELTA_FLOOR = -2.7;

/** `δ(H)`：继续打下去期望能降多少分。 */
export function continuationDelta(hand: number): number {
  return Math.max(DELTA_FLOOR, DELTA_SLOPE * (hand - DELTA_KNEE));
}

/**
 * 活性兜底：本轮回合数超过这个值之后，开始下调宣告门槛。
 *
 * 这不是最优化，是**保证回合一定会结束**。引擎没有回合上限——牌堆空了会把
 * 弃牌堆重洗回牌堆，所以一轮可以无限进行。全员保守时它就会真的无限进行
 * （实测阈值放大到 1.5 倍后 86% 的对局卡在步数上限）。真人局里总会有人先
 * 忍不住，机器人必须自己造出这条退出路径。
 *
 * 正常一轮大约 12–16 个回合，所以宽限期内不生效，校准结论不受影响。
 */
export const LIVENESS_GRACE_TURNS = 24;
export const LIVENESS_LIMIT_TURNS = 60;
/** 兜底最多把门槛压到这个比例。 */
const LIVENESS_FLOOR = 0.35;

export function livenessMultiplier(turnCount: number): number {
  if (turnCount <= LIVENESS_GRACE_TURNS) return 1;
  const progress = Math.min(1, (turnCount - LIVENESS_GRACE_TURNS) / (LIVENESS_LIMIT_TURNS - LIVENESS_GRACE_TURNS));
  return Math.max(LIVENESS_FLOOR, 1 - progress * (1 - LIVENESS_FLOOR));
}

/**
 * Cabo 宣告阈值：`k_eff · (5 + δ(Ĥ)) / (Ĥ + 5) · 活性兜底`。
 *
 * 方法论文档里的 `P > 5/(H+5)` 是从
 * `(1−P)(H+5) = H` 解出来的，但右边那项写错了：**不宣告 Cabo 的人不吃 +5 惩罚**，
 * 他的回合分就是最终手牌分 `H_final`，而继续打只会让手牌分更低。正确的不等式是
 *
 *   (1−P)·(H + 5) < E[H_final]      →      P > (5 + δ)/(H + 5),  δ = H − E[H_final]
 *
 * 漏掉 δ 会让门槛在差手牌那一端低得离谱：`H = 26` 时旧公式给 0.147，
 * 实测最优是 0.507。后果是机器人会在**手牌一张都没认出来的回合开头**
 * 就宣告 Cabo（此时 p̂ ≈ 1/人数 ≈ 0.25，已经越过 0.147 的门槛）。
 *
 * `k_eff` 在基准 k 上按落后程度下调——总分落后越多越该赌，
 * 领先时越该守。这是 `catchUpGain`（u）参数的作用。
 */
export function caboThreshold(persona: BotPersona, expectedScore: number, context: EvaluationContext): number {
  const { observation, belief } = context;
  const self = observation.state.players.find((player) => player.id === belief.selfId);
  const myTotal = self?.score ?? 0;
  const rivalTotals = activeOpponentIds(observation, belief.selfId)
    .map((id) => observation.state.players.find((player) => player.id === id)?.score ?? 0);
  const bestRival = rivalTotals.length > 0 ? Math.min(...rivalTotals) : myTotal;
  const target = observation.state.targetScore || 100;

  const gap = (myTotal - bestRival) / target;
  const kEffective = clamp(persona.cautionFactor * (1 - persona.catchUpGain * gap), 0.3, 4.0);
  const hand = Math.max(0, expectedScore);
  const base = kEffective * ((5 + continuationDelta(hand)) / (hand + 5));
  return Math.min(1, Math.max(0, base * livenessMultiplier(belief.turnCount)));
}

export function evaluate(context: EvaluationContext, samples = 300): Evaluation {
  return {
    expectedHandScore: expectedHandScore(context.belief, context.persona),
    winProbability: winProbability(context, samples),
    samples,
  };
}

/** 是否应当宣告 Cabo。阈值大于 1 表示"任何情况下都不宣告"。 */
export function shouldCallCabo(context: EvaluationContext, samples = 300): boolean {
  const evaluation = evaluate(context, samples);
  const threshold = caboThreshold(context.persona, evaluation.expectedHandScore, context);
  return evaluation.winProbability >= threshold;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
