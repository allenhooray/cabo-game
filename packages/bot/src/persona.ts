/**
 * 人设层：把 13 个可调参数打包成"性格"。
 *
 * 设计依据见 docs/plans/bot-personas.md §6–§8。
 * 参数与人格维度的映射：
 *   风险偏好   ← cautionFactor / optimismBias / multiReplaceRisk
 *   信息掌控   ← memoryFidelity / countingSkill
 *   攻击性     ← swapAggression / leaderFocus / dumpBias
 *   节奏与耐心 ← discardGreed / catchUpGain / decisionLatencyMs
 *   拟人瑕疵   ← mistakeRate / tiltGain / chattiness
 */

export const PERSONA_IDS = ["abacus", "gambler", "mnemo", "gremlin", "chill", "moonchild"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export interface BotPersona {
  readonly id: PersonaId;
  readonly displayName: string;
  /** k — Cabo 阈值倍率。1.0 = 风险中性最优；>1 保守，<1 激进。 */
  readonly cautionFactor: number;
  /** β — 未知牌估值偏移。正数 = 低估未知牌（乐观）。 */
  readonly optimismBias: number;
  /** m — 记忆保真度。1 = 从不忘牌；classic 模式下真正生效。 */
  readonly memoryFidelity: number;
  /** c — 使用未见牌池推断的程度。0 = 纯均匀先验。 */
  readonly countingSkill: number;
  /** a — 换牌攻击性，swap 的收益门槛。 */
  readonly swapAggression: number;
  /** t — 目标选择偏向当前最低总分者。 */
  readonly leaderFocus: number;
  /** d — 优先把高分牌换给对手的倾向。 */
  readonly dumpBias: number;
  /** g — 抽弃牌堆的收益门槛。高 = 更挑剔。 */
  readonly discardGreed: number;
  /** r — 多张替换冒险：非已知同点也敢赌。 */
  readonly multiReplaceRisk: number;
  /** ε — 失误率。 */
  readonly mistakeRate: number;
  /** u — 落后时降低 k 的强度。 */
  readonly catchUpGain: number;
  /** ω — 追月野心。本期仅保留参数位，不实现月相检测（D5）。 */
  readonly moonAmbition: number;
  /** 连续失分后的情绪漂移强度。 */
  readonly tiltGain: number;
  /** L — 决策延迟（毫秒），拟人化节奏。 */
  readonly decisionLatencyMs: number;
  /** 聊天频率。本期仅保留参数位。 */
  readonly chattiness: number;
}

export type NumericPersonaKey = Exclude<keyof BotPersona, "id" | "displayName">;

/**
 * 对手未知牌的理性折扣基准值。
 *
 * 均匀先验会系统性高估对手——真实玩家会把好牌留下、坏牌换掉，所以他们的
 * 实际手牌分低于均匀假设。`countingSkill` 越高，bot 越会做这个折扣；
 * `countingSkill = 0` 时退化为不做折扣的朴素模型。
 */
export const RATIONAL_DISCOUNT = 0.88;

export function opponentDiscount(persona: BotPersona): number {
  return 1 - persona.countingSkill * (1 - RATIONAL_DISCOUNT);
}

/** 每个参数的合法量程。抖动、夹取、以及"人设是否越界"的校验都以它为准。 */
export const PERSONA_RANGES: Record<NumericPersonaKey, readonly [number, number]> = {
  cautionFactor: [0.3, 3.0],
  optimismBias: [-0.3, 0.3],
  memoryFidelity: [0, 1],
  countingSkill: [0, 1],
  swapAggression: [0, 1],
  leaderFocus: [0, 1],
  dumpBias: [0, 1],
  discardGreed: [0, 1],
  multiReplaceRisk: [0, 1],
  mistakeRate: [0, 0.15],
  catchUpGain: [0, 1],
  moonAmbition: [0, 1],
  tiltGain: [0, 1],
  decisionLatencyMs: [0, 3000],
  chattiness: [0, 1],
};

/** 抖动时按比例缩放的参数（其余按绝对量抖动）。 */
const SCALE_KEYS: ReadonlySet<NumericPersonaKey> = new Set(["cautionFactor", "decisionLatencyMs"]);

function persona(
  id: PersonaId,
  displayName: string,
  values: Omit<BotPersona, "id" | "displayName">,
): BotPersona {
  return { id, displayName, ...values };
}

export const PERSONAS: Record<PersonaId, BotPersona> = {
  abacus: persona("abacus", "算盘", {
    cautionFactor: 2.2, optimismBias: -0.05, memoryFidelity: 1.0, countingSkill: 1.0,
    swapAggression: 0.5, leaderFocus: 0.4, dumpBias: 0.4, discardGreed: 0.7,
    multiReplaceRisk: 0.05, mistakeRate: 0.01, catchUpGain: 0.3, moonAmbition: 0,
    tiltGain: 0.05, decisionLatencyMs: 700, chattiness: 0.1,
  }),
  gambler: persona("gambler", "赌徒阿豪", {
    cautionFactor: 0.45, optimismBias: 0.25, memoryFidelity: 0.7, countingSkill: 0.5,
    swapAggression: 0.9, leaderFocus: 0.3, dumpBias: 0.5, discardGreed: 0.8,
    multiReplaceRisk: 0.8, mistakeRate: 0.05, catchUpGain: 1.0, moonAmbition: 0,
    tiltGain: 0.9, decisionLatencyMs: 400, chattiness: 0.5,
  }),
  mnemo: persona("mnemo", "记忆大师", {
    cautionFactor: 1.0, optimismBias: 0, memoryFidelity: 1.0, countingSkill: 1.0,
    swapAggression: 0.6, leaderFocus: 0.6, dumpBias: 0.5, discardGreed: 0.6,
    multiReplaceRisk: 0.15, mistakeRate: 0, catchUpGain: 0.5, moonAmbition: 0,
    tiltGain: 0, decisionLatencyMs: 200, chattiness: 0,
  }),
  gremlin: persona("gremlin", "搅局者", {
    cautionFactor: 1.4, optimismBias: 0, memoryFidelity: 0.9, countingSkill: 0.8,
    swapAggression: 1.0, leaderFocus: 1.0, dumpBias: 1.0, discardGreed: 0.4,
    multiReplaceRisk: 0.3, mistakeRate: 0.03, catchUpGain: 0.5, moonAmbition: 0,
    tiltGain: 0.4, decisionLatencyMs: 600, chattiness: 0.3,
  }),
  chill: persona("chill", "佛系老王", {
    cautionFactor: 3.0, optimismBias: -0.15, memoryFidelity: 0.45, countingSkill: 0.25,
    swapAggression: 0.15, leaderFocus: 0.3, dumpBias: 0.2, discardGreed: 0.5,
    multiReplaceRisk: 0, mistakeRate: 0.12, catchUpGain: 0.1, moonAmbition: 0,
    tiltGain: 0.2, decisionLatencyMs: 2200, chattiness: 0.4,
  }),
  moonchild: persona("moonchild", "月神", {
    cautionFactor: 1.6, optimismBias: 0.1, memoryFidelity: 1.0, countingSkill: 1.0,
    swapAggression: 0.7, leaderFocus: 0.4, dumpBias: 0.6, discardGreed: 0.6,
    multiReplaceRisk: 0.4, mistakeRate: 0.02, catchUpGain: 0.5, moonAmbition: 1.0,
    tiltGain: 0.3, decisionLatencyMs: 900, chattiness: 0.2,
  }),
};

export function getPersona(id: PersonaId): BotPersona {
  return PERSONAS[id];
}

export function clampPersonaValue(key: NumericPersonaKey, value: number): number {
  const [min, max] = PERSONA_RANGES[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * 开局抖动：避免固定参数被玩家摸清（bot-personas.md §3 局限 6）。
 *
 * 比例参数按 ±amount 相对抖动，绝对参数按 ±amount 乘以该参数的量程抖动。
 * 抖动后的值会被夹回合法范围。
 */
export function jitterPersona(persona: BotPersona, rng: () => number, amount = 0.15): BotPersona {
  const next = { ...persona } as Record<string, unknown>;
  for (const key of Object.keys(PERSONA_RANGES) as NumericPersonaKey[]) {
    const current = persona[key];
    const [min, max] = PERSONA_RANGES[key];
    const spread = SCALE_KEYS.has(key) ? Math.abs(current) * amount : (max - min) * amount;
    const delta = (rng() * 2 - 1) * spread;
    next[key] = clampPersonaValue(key, current + delta);
  }
  return next as unknown as BotPersona;
}

/** 情绪漂移：连续失分后放大的失误率与风险偏好（`tilt`）。 */
export function tiltedPersona(persona: BotPersona, mood: number): BotPersona {
  if (persona.tiltGain <= 0 || mood <= 0) return persona;
  const tilt = persona.tiltGain * Math.min(1, Math.max(0, mood));
  return {
    ...persona,
    mistakeRate: clampPersonaValue("mistakeRate", persona.mistakeRate + 0.04 * tilt),
    cautionFactor: clampPersonaValue("cautionFactor", persona.cautionFactor * (1 - 0.3 * tilt)),
    swapAggression: clampPersonaValue("swapAggression", persona.swapAggression + 0.15 * tilt),
  };
}

/**
 * 只缩放 `cautionFactor` 的调参入口。
 *
 * 用来回答一个具体问题：阈值公式里的基准 `k = 1` 是不是太激进？
 * 方法论文档原本给的闭式解是 `5/(H+5)`，但它把"不宣告的人也要吃 +5 惩罚"
 * 当成了前提，而实际上不吃——正确形式是 `(5 + δ)/(H + 5)`，`δ = H − E[H_final]`
 * （见 `evaluate.ts` 的 `caboThreshold`）。这个缺口不该靠感觉补，
 * 而应该扫一遍 k、看每轮平均得分和胜率落在哪里。
 */
export function scaleCaution(persona: BotPersona, scale: number): BotPersona {
  return { ...persona, cautionFactor: clampPersonaValue("cautionFactor", persona.cautionFactor * scale) };
}
