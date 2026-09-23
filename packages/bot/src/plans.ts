/**
 * 动作规划：把"该出什么牌"折算成可比较的数值。
 *
 * 价值口径统一为"我的期望手牌分下降量"，越高越好。
 *
 * 这里承载了全局最关键的一条机制（见 bot-personas.md §5.7）：
 * 多张同点替换会让手牌**变少**——选中的 k 张牌里只有落点那张被替换，
 * 其余直接移出并进入弃牌堆。所以塌缩的收益必须包含 `λ·(k−1)` 的减张项，
 * 其中 λ 是一张未知牌的期望分。只算分差的评估函数学不会塌缩。
 */
import type { AgentObservation, KnownCard, LegalAction } from "@cabo-game/shared";
import { unknownCardValue, type EvaluationContext } from "./evaluate.js";
import { type BotPersona } from "./persona.js";

/** 7/8 看自己：纯信息价值，约等于半张牌。 */
const PEEK_SELF_VALUE = 3.0;
/** 9/10 看他人：只有后续能兑现成 swap 才有价值。 */
const PEEK_OTHER_VALUE = 2.0;
/** 11/12 交换的净收益是分差的两倍——我降多少，对方就升多少。 */
const SWAP_MULTIPLIER = 2;
/** 错配代价：手牌增加约 1.5 张，且被选牌全部公开。 */
const MISMATCH_PENALTY = 6.0;
/** 攻击领先者的额外加成。 */
const LEADER_BONUS = 3;
/** 弃牌泄漏权重：把好牌放进弃牌堆等于送给下家。 */
const LEAK_WEIGHT = 0.6;
/** 冒险塌缩可容忍的 EV 损失上限（乘以 multiReplaceRisk）。 */
const RISK_TOLERANCE = 4;

export interface ReplacePlan {
  positions: number[];
  replacementPosition: number;
  gain: number;
}

export interface SwapPlan {
  targetPlayerId: string;
  ownPosition: number;
  targetPosition: number;
  value: number;
}

export interface PeekOtherPlan {
  targetPlayerId: string;
  position: number;
}

export function replaceLimits(observation: AgentObservation): { maxSelections: number; selectable: number[] } {
  const replace = observation.legalActions.find(
    (action): action is Extract<LegalAction, { type: "replace" }> => action.type === "replace",
  );
  if (!replace) return { maxSelections: 1, selectable: [] };
  return { maxSelections: replace.maxSelections, selectable: [...replace.selectablePositions] };
}

/** 自己未知牌的价值：不打对手折扣，只吃乐观偏置。 */
function ownUnknownValue(context: EvaluationContext): number {
  return unknownCardValue(context.belief, context.persona, 1);
}

/** 一张牌"被移出手牌"的价值——就是它当前的点数（未知则取期望）。 */
function slotValue(card: KnownCard | null, fallback: number): number {
  return card ? card.rank : fallback;
}

/**
 * 选择最优替换方案。
 *
 * 依次评估三类：单张替换、安全塌缩（已知同点 ≥2 张）、冒险塌缩（混入未知位置）。
 */
export function bestReplacePlan(context: EvaluationContext, insertedRank: number, maxSelections = 4): ReplacePlan {
  const { belief, persona } = context;
  const slots = belief.mySlots;
  const unknown = ownUnknownValue(context);
  const lambda = unknown;

  let best: ReplacePlan = { positions: [1], replacementPosition: 1, gain: Number.NEGATIVE_INFINITY };

  for (let index = 0; index < slots.length; index += 1) {
    const gain = slotValue(slots[index] ?? null, unknown) - insertedRank;
    if (gain > best.gain) best = { positions: [index + 1], replacementPosition: index + 1, gain };
  }
  if (slots.length === 0) return best;

  const byRank = new Map<number, number[]>();
  for (let index = 0; index < slots.length; index += 1) {
    const card = slots[index];
    if (!card) continue;
    const positions = byRank.get(card.rank) ?? [];
    positions.push(index + 1);
    byRank.set(card.rank, positions);
  }

  for (const [rank, positions] of byRank) {
    if (positions.length < 2) continue;
    const selected = positions.slice(0, maxSelections);
    const gain = rank * selected.length - insertedRank + lambda * (selected.length - 1);
    if (gain > best.gain) {
      best = { positions: selected, replacementPosition: selected[selected.length - 1] as number, gain };
    }
  }

  if (persona.multiReplaceRisk > 0) {
    const unknownPositions = slots
      .map((card, index) => (card ? -1 : index + 1))
      .filter((position) => position > 0);
    for (const [rank, positions] of byRank) {
      if (unknownPositions.length === 0) break;
      const selected = [...positions, unknownPositions[0] as number].slice(0, maxSelections);
      if (selected.length < 2) continue;
      const probability = (belief.unseen.get(rank) ?? 0) / Math.max(1, belief.unseenTotal);
      const successGain = rank * selected.length - insertedRank + lambda * (selected.length - 1);
      const failurePenalty = MISMATCH_PENALTY + lambda * (selected.length >= 3 ? 2 : 1);
      const expected = probability * successGain + (1 - probability) * -failurePenalty;
      if (expected > best.gain - persona.multiReplaceRisk * RISK_TOLERANCE) {
        best = { positions: selected, replacementPosition: selected[selected.length - 1] as number, gain: expected };
      }
    }
  }

  return best;
}

/** 交换的单次收益：我降多少 + 对方升多少 = 分差的两倍。 */
export function swapValue(
  context: EvaluationContext,
  targetPlayerId: string,
  ownPosition: number,
  targetPosition: number,
): number {
  const { belief, persona, observation } = context;
  const unknown = ownUnknownValue(context);
  const own = slotValue(belief.mySlots[ownPosition - 1] ?? null, unknown);
  const target = slotValue((belief.oppSlots.get(targetPlayerId) ?? [])[targetPosition - 1] ?? null, unknown);
  let value = SWAP_MULTIPLIER * (own - target);

  if (persona.leaderFocus > 0) {
    const totals = observation.state.players.filter((player) => !player.forfeited).map((player) => ({ id: player.id, score: player.score }));
    const lowest = Math.min(...totals.map((entry) => entry.score));
    const targetPlayer = totals.find((entry) => entry.id === targetPlayerId);
    if (targetPlayer && targetPlayer.score === lowest) value += persona.leaderFocus * LEADER_BONUS;
  }
  return value;
}

/** 枚举所有理论上的交换组合，取最优（不限于 legalActions）。 */
export function bestSwapPlan(context: EvaluationContext): SwapPlan | null {
  const { belief, observation } = context;
  const ownCount = belief.mySlots.length;
  let best: SwapPlan | null = null;
  for (const player of observation.state.players) {
    if (player.id === belief.selfId || player.forfeited) continue;
    const targetCount = (belief.oppSlots.get(player.id) ?? []).length || player.cardCount;
    for (let ownPosition = 1; ownPosition <= ownCount; ownPosition += 1) {
      for (let targetPosition = 1; targetPosition <= targetCount; targetPosition += 1) {
        const value = swapValue(context, player.id, ownPosition, targetPosition);
        if (!best || value > best.value) {
          best = { targetPlayerId: player.id, ownPosition, targetPosition, value };
        }
      }
    }
  }
  return best;
}

/** 交换的接受门槛：攻击性越低，要求的收益越高。 */
export function swapAcceptanceThreshold(persona: BotPersona): number {
  return (1 - persona.swapAggression) * 6;
}

/** 挑一个最值得看的位置：优先未知，其次按 leaderFocus 偏向最低总分者。 */
export function bestPeekSelfPosition(context: EvaluationContext): number | null {
  const slots = context.belief.mySlots;
  for (let index = 0; index < slots.length; index += 1) {
    if (!slots[index]) return index + 1;
  }
  return null;
}

export function bestPeekOtherPlan(context: EvaluationContext): PeekOtherPlan | null {
  const { belief, persona, observation } = context;
  const candidates = observation.legalActions.filter(
    (action): action is Extract<LegalAction, { type: "peek-other" }> => action.type === "peek-other",
  );
  if (candidates.length === 0) return null;

  const totals = observation.state.players.filter((player) => !player.forfeited).map((player) => ({ id: player.id, score: player.score }));
  const lowest = totals.length > 0 ? Math.min(...totals.map((entry) => entry.score)) : 0;

  let best: PeekOtherPlan | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const known = (belief.oppSlots.get(candidate.targetPlayerId) ?? [])[candidate.position - 1];
    // 已经看过的位置没有信息价值。
    let score = known ? -10 : 1;
    if (persona.leaderFocus > 0) {
      const target = totals.find((entry) => entry.id === candidate.targetPlayerId);
      if (target && target.score === lowest) score += persona.leaderFocus * 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { targetPlayerId: candidate.targetPlayerId, position: candidate.position };
    }
  }
  return best;
}

/** 弃牌泄漏：把低于均值的牌放进弃牌堆，等于送给下家一张好牌。 */
export function discardLeak(context: EvaluationContext, rank: number): number {
  return (ownUnknownValue(context) - rank) * LEAK_WEIGHT;
}

/** 能力牌价值（7–12）。11/12 直接取当前盘面最优交换的收益。 */
export function powerValue(context: EvaluationContext, rank: number): number {
  if (rank === 7 || rank === 8) return PEEK_SELF_VALUE;
  if (rank === 9 || rank === 10) {
    return PEEK_OTHER_VALUE * (0.3 + 0.7 * context.persona.swapAggression);
  }
  if (rank === 11 || rank === 12) {
    const plan = bestSwapPlan(context);
    return plan ? Math.max(0, plan.value) : 0;
  }
  return 0;
}

/** 弃掉这张牌的总收益 = 能力价值 − 泄漏。 */
export function discardValue(context: EvaluationContext, rank: number): number {
  return powerValue(context, rank) - discardLeak(context, rank);
}

/** 抽牌堆的期望收益：对未见牌池按点数加权，取每个点数下的最优出路。 */
export function drawDeckValue(context: EvaluationContext, maxSelections: number): number {
  const { belief } = context;
  if (belief.unseenTotal <= 0) return 0;
  let total = 0;
  for (const [rank, count] of belief.unseen) {
    if (count <= 0) continue;
    const replaceGain = bestReplacePlan(context, rank, maxSelections).gain;
    const best = Math.max(replaceGain, discardValue(context, rank));
    total += best * count;
  }
  return total / belief.unseenTotal;
}

/** 抽弃牌堆的收益：牌面已知，且必须替换，所以就是最优替换的收益。 */
export function drawDiscardValue(context: EvaluationContext, maxSelections: number): number | null {
  const top = context.observation.state.discardTop;
  if (!top) return null;
  return bestReplacePlan(context, top.rank, maxSelections).gain;
}

/** 从 legalActions 里挑出收益最高的合法交换。 */
export function bestLegalSwap(context: EvaluationContext): SwapPlan | null {
  const candidates = context.observation.legalActions.filter(
    (action): action is Extract<LegalAction, { type: "swap" }> => action.type === "swap",
  );
  let best: SwapPlan | null = null;
  for (const candidate of candidates) {
    const value = swapValue(context, candidate.targetPlayerId, candidate.ownPosition, candidate.targetPosition);
    if (!best || value > best.value) {
      best = {
        targetPlayerId: candidate.targetPlayerId,
        ownPosition: candidate.ownPosition,
        targetPosition: candidate.targetPosition,
        value,
      };
    }
  }
  return best;
}

/** 决策延迟：人设节奏，含 ±40% 抖动，避免固定间隔暴露 bot 身份。 */
export function decisionDelay(persona: BotPersona, rng: () => number): number {
  const base = persona.decisionLatencyMs;
  if (base <= 0) return 0;
  return Math.max(0, base * (0.6 + rng() * 0.8));
}
