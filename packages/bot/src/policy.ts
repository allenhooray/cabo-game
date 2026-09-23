/**
 * 策略层：纯函数决策树。输入 observation + 信念 + 人设，输出一个合法动作。
 *
 * 设计原则：
 *  - 只从 `observation.legalActions` 里选动作，绝不自行构造非法动作。
 *  - 没有合法动作时返回 `null`，由调用方等待新帧（不轮询、不猜测）。
 *  - 一切数值判断走 evaluate / plans，本文件只负责"先做什么"的优先级。
 */
import type { AgentAction, AgentObservation, LegalAction } from "@cabo-game/shared";
import { degrade, type Belief } from "./belief.js";
import { shouldCallCabo, type EvaluationContext } from "./evaluate.js";
import {
  bestLegalSwap,
  bestPeekOtherPlan,
  bestPeekSelfPosition,
  bestReplacePlan,
  decisionDelay,
  discardValue,
  drawDeckValue,
  drawDiscardValue,
  replaceLimits,
  swapAcceptanceThreshold,
} from "./plans.js";
import { tiltedPersona, type BotPersona } from "./persona.js";

export interface DecisionContext {
  belief: Belief;
  observation: AgentObservation;
  persona: BotPersona;
  rng: () => number;
  /** 情绪漂移强度 0..1，由 `moodFromHistory` 推算。 */
  mood?: number;
  /** 蒙特卡洛采样数。 */
  samples?: number;
}

const DEFAULT_SAMPLES = 300;

export function decide(context: DecisionContext): AgentAction | null {
  if (context.observation.legalActions.length === 0) return null;
  const persona = tiltedPersona(context.persona, context.mood ?? 0);
  // 记忆衰减：classic 模式下才真正生效（assisted 会被服务端快照覆盖）。
  degrade(context.belief, persona.memoryFidelity, context.rng);

  const scoped: EvaluationContext = { ...context, persona };
  const action = decidePhase(scoped, context.samples ?? DEFAULT_SAMPLES);
  if (!action) return null;
  return applyMistake(action, scoped);
}

function decidePhase(context: EvaluationContext, samples: number): AgentAction | null {
  switch (context.observation.state.phase) {
    case "LOBBY":
      return has(context, "start") ? { type: "start" } : null;
    case "ROUND_RESULT":
      return has(context, "ready-next-round") ? { type: "ready-next-round" } : null;
    case "MISMATCH_PENDING":
      return decideMismatch(context);
    case "POWER_PENDING":
      return decidePower(context);
    case "DRAWN":
      return decideDrawn(context);
    case "TURN_START":
    case "FINAL_TURNS":
      return decideTurnStart(context, samples);
    default:
      return null;
  }
}

/**
 * 错配落位一律选 `right`。
 *
 * `insertAtEnd` 里 `right` 走 `push`（位置 1..n 不变），`left` 走 `unshift`
 * （平移全部位置，等于把自己的记忆全部作废）。这是免费的收益。
 */
function decideMismatch(context: EvaluationContext): AgentAction | null {
  const resolve = context.observation.legalActions.find(
    (action): action is Extract<LegalAction, { type: "resolve-mismatch" }> => action.type === "resolve-mismatch",
  );
  if (!resolve) return null;
  return {
    type: "resolve-mismatch",
    drawnPlacement: "right",
    ...(resolve.penaltyCardPending ? { penaltyPlacement: "right" as const } : {}),
  };
}

function decideTurnStart(context: EvaluationContext, samples: number): AgentAction | null {
  if (has(context, "cabo") && shouldCallCabo(context, samples)) return { type: "cabo" };

  const { maxSelections } = replaceLimits(context.observation);
  const deckValue = has(context, "draw-deck") ? drawDeckValue(context, maxSelections) : Number.NEGATIVE_INFINITY;
  const fromDiscard = has(context, "draw-discard") ? drawDiscardValue(context, maxSelections) : null;

  // discardGreed 越高越挑剔：要求弃牌堆的确定性收益明显超过抽牌堆的期望收益。
  if (fromDiscard !== null && fromDiscard >= deckValue + context.persona.discardGreed * 2) {
    return { type: "draw-discard" };
  }
  if (has(context, "draw-deck")) return { type: "draw-deck" };
  if (has(context, "draw-discard")) return { type: "draw-discard" };
  if (has(context, "skip")) return { type: "skip" };
  return null;
}

function decideDrawn(context: EvaluationContext): AgentAction | null {
  const { belief } = context;
  const { maxSelections, selectable } = replaceLimits(context.observation);
  const held = belief.held;
  const heldRank = held ? held.rank : Math.round(belief.meanUnseen);

  const plan = bestReplacePlan(context, heldRank, maxSelections);

  // 从牌堆抽的牌可以直接弃掉；若点数为 7–12 还能触发能力。
  if (has(context, "discard") && discardValue(context, heldRank) > plan.gain) {
    return { type: "discard" };
  }

  const positions = plan.positions.filter((position) => selectable.includes(position)).slice(0, maxSelections);
  if (positions.length === 0) return has(context, "discard") ? { type: "discard" } : null;
  const replacementPosition = positions.includes(plan.replacementPosition)
    ? plan.replacementPosition
    : (positions[0] as number);
  return { type: "replace", positions, replacementPosition };
}

function decidePower(context: EvaluationContext): AgentAction | null {
  const rank = context.observation.state.discardTop?.rank ?? -1;

  if (rank === 7 || rank === 8) {
    const position = bestPeekSelfPosition(context);
    if (position !== null && has(context, "peek-self")) return { type: "peek-self", position };
  } else if (rank === 9 || rank === 10) {
    const plan = bestPeekOtherPlan(context);
    if (plan) return { type: "peek-other", targetPlayerId: plan.targetPlayerId, position: plan.position };
  } else if (rank === 11 || rank === 12) {
    const swap = bestLegalSwap(context);
    if (swap && swap.value > swapAcceptanceThreshold(context.persona)) {
      return {
        type: "swap",
        targetPlayerId: swap.targetPlayerId,
        ownPosition: swap.ownPosition,
        targetPosition: swap.targetPosition,
      };
    }
  }

  if (has(context, "skip")) return { type: "skip" };
  return null;
}

/**
 * 失误：以 `mistakeRate` 的概率改选另一个合法动作。
 *
 * `cabo` 被排除在失误候选之外——随机宣告 Cabo 的惩罚（手牌分 +5）过重，
 * 会让"会犯错的人设"变成"纯粹在送分的人设"，反而不像人。
 */
function applyMistake(action: AgentAction, context: EvaluationContext): AgentAction {
  const { persona, rng, observation } = context;
  if (persona.mistakeRate <= 0 || rng() >= persona.mistakeRate) return action;
  const candidates = observation.legalActions
    .map((candidate) => materialize(candidate))
    .filter((candidate): candidate is AgentAction => candidate !== null && candidate.type !== "cabo");
  if (candidates.length === 0) return action;
  return candidates[Math.floor(rng() * candidates.length)] ?? action;
}

/** 把 legalActions 的选择描述符展开成具体动作。 */
function materialize(action: LegalAction): AgentAction | null {
  if (action.type === "replace") {
    const position = action.selectablePositions[0];
    if (position === undefined) return null;
    return { type: "replace", positions: [position], replacementPosition: position };
  }
  if (action.type === "resolve-mismatch") {
    return {
      type: "resolve-mismatch",
      drawnPlacement: "right",
      ...(action.penaltyCardPending ? { penaltyPlacement: "right" as const } : {}),
    };
  }
  return action;
}

function has(context: EvaluationContext, type: AgentAction["type"]): boolean {
  return context.observation.legalActions.some((action) => action.type === type);
}

/** 情绪漂移：上一轮比对手平均多拿了多少分，归一化到 0..1。 */
export function moodFromHistory(observation: AgentObservation, selfId: string): number {
  const history = observation.state.roundHistory;
  const last = history[history.length - 1];
  if (!last) return 0;
  const mine = last.players.find((player) => player.playerId === selfId)?.roundScore ?? 0;
  const others = last.players.filter((player) => player.playerId !== selfId).map((player) => player.roundScore);
  if (others.length === 0) return 0;
  const average = others.reduce((sum, value) => sum + value, 0) / others.length;
  return Math.max(0, Math.min(1, (mine - average) / 15));
}

export { decisionDelay };
