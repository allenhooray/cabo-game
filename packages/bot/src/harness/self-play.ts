/**
 * 自对弈：用 `GameEngine` + `seededRandom` 直接驱动，绕过网络跑批量对局。
 *
 * 用途是调参与回归（方法论文档 §9），所以对局必须可复现——
 * 同一个 seed 必须产生完全相同的对局。
 *
 * 报告里包含 **p̂ 分桶校准**（方案 §6.2）：把宣告时的预测胜率分桶，
 * 对比每桶的实际成功率。校准误差过大说明蒙特卡洛模型有偏，
 * 必须先修模型再调参，否则后续所有调参都是在错误的基础上优化。
 */
import { seededRandom, type MemoryMode } from "@cabo-game/shared";
import { applyObservation, applyPrivateReveal, applyPublicAction, createBelief, type Belief } from "../belief.js";
import { caboThreshold, evaluate } from "../evaluate.js";
import { decide, moodFromHistory } from "../policy.js";
import { jitterPersona, PERSONAS, scaleCaution, type BotPersona, type PersonaId } from "../persona.js";
import { SelfPlayTable, type SeatEvent } from "./engine-adapter.js";

export interface SelfPlayConfig {
  /** 参与对局的座位人设，按座位顺序。 */
  personas: PersonaId[];
  /**
   * 每个座位的 `cautionFactor` 缩放，按座位顺序，缺省为 1。
   * 调参用：只动阈值、不动其他性格参数，才能把"阈值是否合适"单独隔离出来。
   */
  cautionScales?: number[];
  games: number;
  seed: number;
  targetScore?: number;
  memoryMode?: MemoryMode;
  /** 蒙特卡洛采样数；调参时可调低以加快批量跑分。 */
  samples?: number;
  /** 是否对每个人设做开局抖动。 */
  jitter?: boolean;
  onGameComplete?: (gameIndex: number, winners: string[]) => void;
}

export interface DeclarationRecord {
  personaId: PersonaId;
  seat: number;
  round: number;
  /** 宣告时刻的预测胜率 p̂。 */
  probability: number;
  /** 宣告时刻的阈值 k·5/(Ĥ+5)。 */
  threshold: number;
  expectedScore: number;
  succeeded: boolean;
}

export interface PersonaStats {
  personaId: PersonaId;
  displayName: string;
  seatGames: number;
  wins: number;
  winRate: number;
  averageRoundScore: number;
  caboAttempts: number;
  caboSuccesses: number;
  caboSuccessRate: number;
  /** 每局宣告次数——阈值是否合适的第一个信号。 */
  caboAttemptsPerGame: number;
  averageDeclarationProbability: number;
  averageDeclarationThreshold: number;
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  count: number;
  /** 桶内平均预测胜率。 */
  predicted: number;
  /** 桶内实际成功率。 */
  actual: number;
  /**
   * 实际成功率的标准误 `√(p(1−p)/n)`。
   *
   * 没有这个数就没法判断偏差是"模型有偏"还是"样本太少"。实测里
   * 一个 n=9 的桶能报出 −29.5% 的偏差，看着吓人，实际只有 2.5 个标准误；
   * 而 n=116 报 −11.4% 反而更值得查。旧指标把两者同等看待，于是
   * 校准误差这个门槛数字被最小的桶绑架。
   */
  standardError: number;
}

export interface SelfPlayReport {
  games: number;
  rounds: number;
  stats: PersonaStats[];
  /** 等宽分桶，用于人工阅读。 */
  calibration: CalibrationBucket[];
  /** 等量分桶（每个桶样本数相近），用于计算校准误差。 */
  quantileCalibration: CalibrationBucket[];
  /** 校准误差：等量分桶上的样本加权 ECE。 */
  calibrationError: number;
  /** 样本足够多的桶里 |预测 − 实际| 的最大值（含标准误判定）。 */
  worstDeviation: number;
  declarations: DeclarationRecord[];
  /** 单轮最长回合数——活性兜底是否生效的观测量。 */
  maxRoundTurns: number;
  /** 未按预期结束的对局（用于暴露策略死循环或非法动作）。 */
  failures: string[];
}

interface MutableStats {
  seatGames: number;
  wins: number;
  roundScores: number[];
  caboAttempts: number;
  caboSuccesses: number;
  probabilities: number[];
  thresholds: number[];
}

/**
 * 单局步数上限。一轮正常 12–16 回合，活性兜底保证最多 ~60 回合，
 * 一局到 100 分约 20 轮，所以 20000 步是很宽松的上限——真撞上它
 * 说明活性兜底失效了，属于必须查的 bug，而不是"回合有点长"。
 */
const MAX_STEPS_PER_GAME = 20000;
const CALIBRATION_SAMPLES = 400;
/** 少于这个样本数的桶不参与校准误差统计。 */
const MIN_BUCKET_SAMPLES = 25;
/** 报告里最多列出的桶数。 */
const CALIBRATION_BUCKETS = 10;

export function runSelfPlay(config: SelfPlayConfig): SelfPlayReport {
  const targetScore = config.targetScore ?? 100;
  const memoryMode = config.memoryMode ?? "assisted";
  const samples = config.samples ?? 200;
  const useJitter = config.jitter ?? false;

  const stats = new Map<PersonaId, MutableStats>();
  for (const id of config.personas) {
    stats.set(id, { seatGames: 0, wins: 0, roundScores: [], caboAttempts: 0, caboSuccesses: 0, probabilities: [], thresholds: [] });
  }

  const failures: string[] = [];
  const declarations: DeclarationRecord[] = [];
  let totalRounds = 0;
  let maxRoundTurns = 0;

  for (let game = 0; game < config.games; game += 1) {
    const gameSeed = config.seed + game * 7919;
    const result = playGame({
      personas: config.personas,
      ...(config.cautionScales ? { cautionScales: config.cautionScales } : {}),
      seed: gameSeed,
      targetScore,
      memoryMode,
      samples,
      jitter: useJitter,
    });

    if (result.error) {
      failures.push(`game ${game}: ${result.error}`);
      continue;
    }
    totalRounds += result.rounds;
    maxRoundTurns = Math.max(maxRoundTurns, result.maxRoundTurns);
    for (const record of result.declarations) declarations.push(record);

    config.personas.forEach((personaId, seat) => {
      const entry = stats.get(personaId);
      if (!entry) return;
      entry.seatGames += 1;
      if (result.winners.includes(`seat-${seat}`)) entry.wins += 1;
      entry.caboAttempts += result.caboAttempts[seat] ?? 0;
      entry.caboSuccesses += result.caboSuccesses[seat] ?? 0;
      for (const score of result.roundScores[seat] ?? []) entry.roundScores.push(score);
      for (const record of result.declarations) {
        if (record.seat !== seat) continue;
        entry.probabilities.push(record.probability);
        entry.thresholds.push(record.threshold);
      }
    });

    config.onGameComplete?.(game, result.winners);
  }

  const calibration = bucketCalibration(declarations);
  const quantile = quantileCalibration(declarations);
  return {
    games: config.games,
    rounds: totalRounds,
    maxRoundTurns,
    failures,
    declarations,
    calibration,
    quantileCalibration: quantile,
    calibrationError: calibrationError(quantile),
    worstDeviation: worstDeviation(quantile),
    stats: [...stats.entries()].map(([personaId, entry]) => ({
      personaId,
      displayName: PERSONAS[personaId].displayName,
      seatGames: entry.seatGames,
      wins: entry.wins,
      winRate: entry.seatGames > 0 ? entry.wins / entry.seatGames : 0,
      averageRoundScore: average(entry.roundScores),
      caboAttempts: entry.caboAttempts,
      caboSuccesses: entry.caboSuccesses,
      caboSuccessRate: entry.caboAttempts > 0 ? entry.caboSuccesses / entry.caboAttempts : 0,
      caboAttemptsPerGame: entry.seatGames > 0 ? entry.caboAttempts / entry.seatGames : 0,
      averageDeclarationProbability: average(entry.probabilities),
      averageDeclarationThreshold: average(entry.thresholds),
    })),
  };
}

export function bucketCalibration(records: readonly DeclarationRecord[], buckets = CALIBRATION_BUCKETS): CalibrationBucket[] {
  const result: CalibrationBucket[] = [];
  for (let index = 0; index < buckets; index += 1) {
    const lower = index / buckets;
    const upper = (index + 1) / buckets;
    const inBucket = records.filter((record) => record.probability >= lower && (index === buckets - 1 ? record.probability <= upper : record.probability < upper));
    result.push(makeBucket(lower, upper, inBucket));
  }
  return result;
}

/**
 * 等量分桶：按预测 p̂ 排序后切成样本数相近的若干桶。
 *
 * 为什么不用等宽分桶算校准误差：p̂ 的分布高度集中在低区间（实测 2712 个
 * 宣告里 443 个落在 0–10%、9 个落在 80–90%），等宽分桶会产出 n=9 的桶。
 * 这种桶的实际成功率标准误有 12%，一个 ±29% 的偏差纯属噪声，却会把
 * "最大偏差"这个指标顶到天上，让人误以为模型在高置信区间坏掉了。
 * 等量分桶保证每桶样本数相近，指标才由真实偏差而不是样本量决定。
 */
export function quantileCalibration(records: readonly DeclarationRecord[], buckets = CALIBRATION_BUCKETS): CalibrationBucket[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((left, right) => left.probability - right.probability);
  const result: CalibrationBucket[] = [];
  for (let index = 0; index < buckets; index += 1) {
    const start = Math.floor((index * sorted.length) / buckets);
    const end = Math.floor(((index + 1) * sorted.length) / buckets);
    const slice = sorted.slice(start, end);
    if (slice.length === 0) continue;
    result.push(makeBucket(slice[0]!.probability, slice[slice.length - 1]!.probability, slice));
  }
  return result;
}

function makeBucket(lower: number, upper: number, records: readonly DeclarationRecord[]): CalibrationBucket {
  const count = records.length;
  const actual = count > 0 ? records.filter((record) => record.succeeded).length / count : 0;
  return {
    lower,
    upper,
    count,
    predicted: average(records.map((record) => record.probability)),
    actual,
    standardError: count > 0 ? Math.sqrt((actual * (1 - actual)) / count) : 0,
  };
}

/**
 * 样本加权 ECE：`Σ (n_b / N) · |p̂_b − 实际_b|`。
 *
 * 比"最大偏差"更合适作为门槛：它对每个桶按样本量加权，所以既不会被
 * 小桶绑架，也不会因为一个大桶的偶然偏差而漏报。样本不足的桶直接排除，
 * 因为它们只能贡献噪声。
 */
export function calibrationError(buckets: readonly CalibrationBucket[]): number {
  let total = 0;
  let weighted = 0;
  for (const bucket of buckets) {
    if (bucket.count < MIN_BUCKET_SAMPLES) continue;
    total += bucket.count;
    weighted += bucket.count * Math.abs(bucket.predicted - bucket.actual);
  }
  return total > 0 ? weighted / total : 0;
}

/** 样本足够的桶里最大的 |预测 − 实际|。用于定位"哪一段最需要修模型"。 */
export function worstDeviation(buckets: readonly CalibrationBucket[]): number {
  let worst = 0;
  for (const bucket of buckets) {
    if (bucket.count < MIN_BUCKET_SAMPLES) continue;
    worst = Math.max(worst, Math.abs(bucket.predicted - bucket.actual));
  }
  return worst;
}

interface GameResult {
  winners: string[];
  rounds: number;
  maxRoundTurns: number;
  roundScores: number[][];
  caboAttempts: number[];
  caboSuccesses: number[];
  declarations: DeclarationRecord[];
  error?: string;
}

function playGame(options: {
  personas: PersonaId[];
  cautionScales?: number[];
  seed: number;
  targetScore: number;
  memoryMode: MemoryMode;
  samples: number;
  jitter: boolean;
}): GameResult {
  const rng = seededRandom(options.seed);
  // 独立的测量随机源：记录 p̂ 时不能扰动对局轨迹。
  const measureRng = seededRandom(options.seed ^ 0x9e3779b9);
  const seats = options.personas.map((_, index) => `seat-${index}`);
  const table = new SelfPlayTable({
    playerIds: seats,
    targetScore: options.targetScore,
    memoryMode: options.memoryMode,
    seed: options.seed,
  });

  const beliefs = new Map<string, Belief>();
  const personas = new Map<string, BotPersona>();
  options.personas.forEach((personaId, index) => {
    const seat = `seat-${index}`;
    beliefs.set(seat, createBelief(seat, options.memoryMode));
    const base = PERSONAS[personaId];
    const jittered = options.jitter ? jitterPersona(base, rng) : base;
    const scale = options.cautionScales?.[index] ?? 1;
    personas.set(seat, scale === 1 ? jittered : scaleCaution(jittered, scale));
  });

  const caboAttempts = options.personas.map(() => 0);
  const declarations: DeclarationRecord[] = [];
  let maxRoundTurns = 0;
  table.start();

  let steps = 0;
  while (table.phase !== "MATCH_RESULT") {
    if (steps++ > MAX_STEPS_PER_GAME) {
      return fail("step limit exceeded", caboAttempts);
    }
    if (table.phase === "ROUND_RESULT") {
      // 每个座位的 turnCount 应该一致（所有摸牌动作都是公开广播的），取 0 号即可。
      maxRoundTurns = Math.max(maxRoundTurns, beliefs.get(seats[0] as string)?.turnCount ?? 0);
      table.nextRound();
      continue;
    }
    const seat = table.currentPlayerId;
    if (!seat) return fail(`no current player in phase ${table.phase}`, caboAttempts);

    const belief = beliefs.get(seat);
    const persona = personas.get(seat);
    if (!belief || !persona) return fail(`unknown seat ${seat}`, caboAttempts);

    const turn = table.takeTurn(seat);
    absorb(belief, turn.events);
    applyObservation(belief, turn.observation);

    const action = decide({
      belief,
      observation: turn.observation,
      persona,
      rng,
      mood: moodFromHistory(turn.observation, seat),
      samples: options.samples,
    });
    if (!action) return fail(`no action in phase ${table.phase}`, caboAttempts);

    if (action.type === "cabo") {
      const seatIndex = seatIndex0(seat);
      caboAttempts[seatIndex] = (caboAttempts[seatIndex] ?? 0) + 1;
      const measurement = { belief, observation: turn.observation, persona, rng: measureRng };
      const evaluation = evaluate(measurement, CALIBRATION_SAMPLES);
      declarations.push({
        personaId: persona.id,
        seat: seatIndex,
        round: turn.observation.state.round,
        probability: evaluation.winProbability,
        threshold: caboThreshold(persona, evaluation.expectedHandScore, measurement),
        expectedScore: evaluation.expectedHandScore,
        succeeded: false,
      });
    }

    const applied = table.apply(seat, action);
    if (!applied.ok) return fail(`illegal action ${action.type}: ${applied.error}`, caboAttempts);
  }

  const history = table.observationFor(seats[0] as string).state.roundHistory;
  const roundScores = seats.map(() => [] as number[]);
  const caboSuccesses = seats.map(() => 0);
  for (const entry of history) {
    for (const player of entry.players) {
      const index = seats.indexOf(player.playerId);
      if (index >= 0) (roundScores[index] as number[]).push(player.roundScore);
    }
    if (entry.outcomeType === "cabo" && entry.caboSucceeded) {
      const index = seats.indexOf(entry.outcomePlayerId);
      if (index >= 0) caboSuccesses[index] = (caboSuccesses[index] ?? 0) + 1;
    }
  }

  // 把宣告记录与回合结果对上。月神触发的回合（shooting-the-moon）语义不同，跳过。
  for (const record of declarations) {
    const entry = history.find((item) => item.round === record.round);
    if (!entry || entry.outcomeType !== "cabo") continue;
    record.succeeded = entry.outcomePlayerId === seats[record.seat] && entry.caboSucceeded;
  }

  return {
    winners: [...table.engine.winners],
    rounds: history.length,
    maxRoundTurns,
    roundScores,
    caboAttempts,
    caboSuccesses,
    declarations,
  };
}

function fail(error: string, caboAttempts: number[]): GameResult {
  return { winners: [], rounds: 0, maxRoundTurns: 0, roundScores: [], caboAttempts, caboSuccesses: [], declarations: [], error };
}

function seatIndex0(seat: string): number {
  return Number(seat.split("-")[1]);
}

function absorb(belief: Belief, events: SeatEvent[]): void {
  for (const event of events) {
    if (event.type === "private-reveal") {
      applyPrivateReveal(belief, event);
      continue;
    }
    if (event.type === "action") {
      applyPublicAction(belief, event);
    }
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function formatReport(report: SelfPlayReport): string {
  const lines: string[] = [];
  lines.push(`games=${report.games} rounds=${report.rounds} 单轮最长回合数=${report.maxRoundTurns}`);
  lines.push("");
  lines.push("人设          局数   胜率    平均每轮分  宣告/局  成功率   宣告时p̂  宣告时阈值");
  for (const stat of report.stats) {
    lines.push(
      `${stat.displayName.padEnd(12)}${String(stat.seatGames).padStart(5)}`
      + `${(stat.winRate * 100).toFixed(1).padStart(7)}%`
      + `${stat.averageRoundScore.toFixed(2).padStart(11)}`
      + `${stat.caboAttemptsPerGame.toFixed(2).padStart(9)}`
      + `${(stat.caboSuccessRate * 100).toFixed(1).padStart(8)}%`
      + `${(stat.averageDeclarationProbability * 100).toFixed(1).padStart(10)}%`
      + `${(stat.averageDeclarationThreshold * 100).toFixed(1).padStart(11)}%`,
    );
  }

  lines.push("");
  lines.push("p̂ 校准 · 等量分桶（每桶样本数相近，用于判定模型是否有偏）");
  lines.push(`区间          样本   预测p̂   实际成功率   偏差      标准误   显著`);
  for (const bucket of report.quantileCalibration) {
    const deviation = bucket.actual - bucket.predicted;
    const significant = Math.abs(deviation) > 2 * bucket.standardError ? "是" : "";
    lines.push(
      `${`${(bucket.lower * 100).toFixed(0)}-${(bucket.upper * 100).toFixed(0)}%`.padEnd(14)}`
      + `${String(bucket.count).padStart(4)}`
      + `${(bucket.predicted * 100).toFixed(1).padStart(8)}%`
      + `${(bucket.actual * 100).toFixed(1).padStart(12)}%`
      + `${`${deviation >= 0 ? "+" : ""}${(deviation * 100).toFixed(1)}%`.padStart(9)}`
      + `${(bucket.standardError * 100).toFixed(1).padStart(9)}%`
      + `${significant.padStart(7)}`,
    );
  }
  lines.push(`校准误差（样本加权 ECE）= ${(report.calibrationError * 100).toFixed(1)}%   最大偏差 = ${(report.worstDeviation * 100).toFixed(1)}%   门槛 5%`);

  lines.push("");
  lines.push("p̂ 校准 · 等宽分桶（看分布落在哪，不用于判定）");
  lines.push("区间        样本   预测p̂   实际成功率   偏差");
  for (const bucket of report.calibration) {
    if (bucket.count === 0) continue;
    const deviation = bucket.actual - bucket.predicted;
    lines.push(
      `${`${(bucket.lower * 100).toFixed(0)}-${(bucket.upper * 100).toFixed(0)}%`.padEnd(12)}`
      + `${String(bucket.count).padStart(4)}`
      + `${(bucket.predicted * 100).toFixed(1).padStart(8)}%`
      + `${(bucket.actual * 100).toFixed(1).padStart(12)}%`
      + `${`${deviation >= 0 ? "+" : ""}${(deviation * 100).toFixed(1)}%`.padStart(9)}`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`failures (${report.failures.length}):`);
    for (const failure of report.failures.slice(0, 10)) lines.push(`  ${failure}`);
  }
  return lines.join("\n");
}

const isDirectRun = process.argv[1]?.endsWith("self-play.ts") || process.argv[1]?.endsWith("self-play.js");
if (isDirectRun) {
  const games = Number(process.env.GAMES ?? 200);
  const samples = Number(process.env.SAMPLES ?? 200);
  const jitter = process.env.JITTER !== "0";
  // `PERSONAS` 支持 `id` 或 `id@k`，`k` 是该座位 `cautionFactor` 的缩放倍率。
  const specs = (process.env.PERSONAS ?? "abacus,gambler,mnemo,gremlin").split(",");
  const personas: PersonaId[] = specs.map((spec) => spec.split("@")[0] as PersonaId);
  const cautionScales = specs.map((spec) => {
    const scale = spec.split("@")[1];
    return scale === undefined ? 1 : Number(scale);
  });
  const started = Date.now();
  const report = runSelfPlay({ personas, cautionScales, games, seed: 20260923, samples, jitter });
  process.stdout.write(`${formatReport(report)}\n`);
  process.stdout.write(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}
