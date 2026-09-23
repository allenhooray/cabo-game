/**
 * 校准诊断：为什么某个 p̂ 区间的宣告仍然会失败？
 *
 * 排查工具，不参与线上决策。用法：
 *   GAMES=300 ../../node_modules/.bin/tsx src/harness/diagnose.ts
 *   BAND=50,70 VERBOSE=1 GAMES=800 ../../node_modules/.bin/tsx src/harness/diagnose.ts
 *
 * 输出把"模型预测量"和"回合实际量"并排放在一起。校准偏差只告诉我们
 * 哪一段错了，这个工具告诉我们**错在哪个量**——是我自己的手牌被低估，
 * 还是对手被高估。
 */
import { seededRandom } from "@cabo-game/shared";
import { applyObservation, applyPrivateReveal, applyPublicAction, createBelief, type Belief } from "../belief.js";
import { evaluate, sampleFinalState } from "../evaluate.js";
import { decide, moodFromHistory } from "../policy.js";
import { PERSONAS, type PersonaId } from "../persona.js";
import { SelfPlayTable, type SeatEvent } from "./engine-adapter.js";

interface Sample {
  seat: string;
  probability: number;
  predictedOwnScore: number;
  unknownOwn: number;
  myKnown: string[];
  rivalKnown: string[][];
  round: number;
  actualHands: string[];
  actualScores: number[];
  /** 回合结束时我自己的真实手牌分。 */
  actualOwnScore: number;
  /** 回合结束时对手的最低真实手牌分。 */
  actualRivalMin: number;
  /** 回合结束时对手的平均真实手牌分。 */
  actualRivalMean: number;
  /** 模型对"宣告之后"的对手平均终局分期望。 */
  modelRivalMean: number;
  /** 模型对"宣告之后"的我方终局分期望。 */
  modelOwnFinal: number;
  /** 模型对"宣告之后"的对手最低终局分期望。 */
  modelRivalMin: number;
  /** 模型对"宣告之后"的我方终局分分布标准差。 */
  modelOwnSpread: number;
  /** 宣告之后实际发生的最终回合动作，用来核对模型假设的换牌频率。 */
  finalTurnActions: string[];
  outcome: string;
  succeeded: boolean;
}

const personas: PersonaId[] = (process.env.PERSONAS?.split(",") as PersonaId[] | undefined) ?? ["abacus", "mnemo", "gremlin"];
const games = Number(process.env.GAMES ?? 200);
const samples = Number(process.env.SAMPLES ?? 150);
const verbose = process.env.VERBOSE === "1";
const band = (process.env.BAND ?? "0,1").split(",").map(Number);
const bandLow = band[0] ?? 0;
const bandHigh = band[1] ?? 1;

const collected: Sample[] = [];

for (let game = 0; game < games; game += 1) {
  const seed = 20260923 + game * 7919;
  const rng = seededRandom(seed);
  const measureRng = seededRandom(seed ^ 0x9e3779b9);
  const seats = personas.map((_, index) => `seat-${index}`);
  const table = new SelfPlayTable({ playerIds: seats, targetScore: 100, memoryMode: "assisted", seed });
  const beliefs = new Map<string, Belief>();
  personas.forEach((_, index) => beliefs.set(`seat-${index}`, createBelief(`seat-${index}`, "assisted")));

  const pending: Array<{ seat: string; sample: Sample }> = [];
  let tracking: { seat: string; sample: Sample } | undefined;
  table.start();

  let steps = 0;
  while (table.phase !== "MATCH_RESULT" && steps++ < 20000) {
    if (table.phase === "ROUND_RESULT") {
      resolveRound(table, pending, collected);
      // 必须在这里断掉跟踪。否则本回合宣告之后的动作会一直累积到**下一回合**
      // 的下一次宣告为止，最终回合动作数会虚高一个数量级（实测 60 个/次宣告），
      // 换牌频率和换牌目标的统计全部失真。
      tracking = undefined;
      table.nextRound();
      continue;
    }
    const seat = table.currentPlayerId;
    if (!seat) break;
    const belief = beliefs.get(seat);
    const persona = PERSONAS[personas[Number(seat.split("-")[1])] as PersonaId];
    if (!belief || !persona) break;

    const turn = table.takeTurn(seat);
    absorb(belief, turn.events);
    applyObservation(belief, turn.observation);

    const action = decide({ belief, observation: turn.observation, persona, rng, mood: moodFromHistory(turn.observation, seat), samples });
    if (!action) break;

    if (action.type === "cabo") {
      const measurement = { belief, observation: turn.observation, persona, rng: measureRng };
      const evaluation = evaluate(measurement, 500);
      const finals = Array.from({ length: 400 }, () => sampleFinalState(measurement, measureRng));
      const ownFinals = finals.map((entry) => entry.myScore);
      const rivalMins = finals.map((entry) => entry.rivalScores.length > 0 ? Math.min(...entry.rivalScores) : 99);
      pending.push({
        seat,
        sample: {
          seat,
          probability: evaluation.winProbability,
          predictedOwnScore: evaluation.expectedHandScore,
          unknownOwn: belief.mySlots.filter((card) => !card).length,
          myKnown: belief.mySlots.map((card) => card ? card.label : "?"),
          rivalKnown: [...belief.oppSlots.entries()].map(([, slots]) => slots.map((card) => card ? card.label : "?")),
          round: turn.observation.state.round,
          actualHands: [],
          actualScores: [],
          actualOwnScore: 0,
          actualRivalMin: 0,
          actualRivalMean: 0,
          modelRivalMean: mean(finals.map((entry) => mean(entry.rivalScores))),
          modelOwnFinal: mean(ownFinals),
          modelRivalMin: mean(rivalMins),
          modelOwnSpread: Math.sqrt(mean(ownFinals.map((value) => (value - mean(ownFinals)) ** 2))),
          finalTurnActions: [],
          outcome: "",
          succeeded: false,
        },
      });
      tracking = pending[pending.length - 1]!;
    }

    // 宣告之后的所有动作都属于最终回合，逐条记下来核对模型假设。
    if (tracking && action.type !== "cabo") {
      tracking.sample.finalTurnActions.push(`${seat}:${describeAction(action)}`);
    }
    if (!table.apply(seat, action).ok) break;
  }
  resolveRound(table, pending, collected);
  tracking = undefined;
}

/** 把动作压成一行，便于在诊断输出里对照模型的换牌假设。 */
function describeAction(action: { type: string } & Record<string, unknown>): string {
  switch (action.type) {
    case "swap":
      return `swap own#${action.ownPosition}<-${action.targetPlayerId}#${action.targetPosition}`;
    case "replace":
      return `replace ${JSON.stringify(action.positions)}@${action.replacementPosition}`;
    case "draw-deck":
    case "draw-discard":
      return action.type;
    default:
      return action.type;
  }
}

function resolveRound(table: SelfPlayTable, pending: Array<{ seat: string; sample: Sample }>, out: Sample[]): void {
  const history = table.observationFor("seat-0").state.roundHistory;
  for (const { seat, sample } of pending.splice(0)) {
    const entry = history.find((item) => item.round === sample.round);
    if (!entry) continue;
    sample.actualHands = entry.players.map((player) => `${player.playerId}=${player.cards.map((card) => card.label).join(",")}(${player.handScore})`);
    sample.actualScores = entry.players.map((player) => player.handScore);
    sample.outcome = entry.outcomeType === "cabo" ? `cabo by ${entry.outcomePlayerId} ok=${entry.caboSucceeded}` : `moon by ${entry.outcomePlayerId}`;
    const mine = entry.players.find((player) => player.playerId === seat);
    const rivals = entry.players.filter((player) => player.playerId !== seat);
    sample.actualOwnScore = mine?.handScore ?? 0;
    sample.actualRivalMin = rivals.length > 0 ? Math.min(...rivals.map((player) => player.handScore)) : 0;
    sample.actualRivalMean = rivals.length > 0 ? rivals.reduce((sum, player) => sum + player.handScore, 0) / rivals.length : 0;
    sample.succeeded = entry.outcomeType === "cabo" && entry.outcomePlayerId === seat && entry.caboSucceeded
      && mine !== undefined && rivals.every((player) => mine.handScore < player.handScore);
    out.push(sample);
  }
}

function absorb(belief: Belief, events: SeatEvent[]): void {
  for (const event of events) {
    if (event.type === "private-reveal") applyPrivateReveal(belief, event);
    else if (event.type === "action") applyPublicAction(belief, event);
  }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(2);
}

const inBand = collected.filter((sample) => sample.probability >= bandLow / 100 && sample.probability < bandHigh / 100);
const failures = inBand.filter((sample) => !sample.succeeded);

process.stdout.write(`总样本 ${collected.length}；区间 ${bandLow}-${bandHigh}% 样本 ${inBand.length}，失败 ${failures.length}\n`);
process.stdout.write(`区间内实际成功率 ${(inBand.length > 0 ? inBand.filter((s) => s.succeeded).length / inBand.length * 100 : 0).toFixed(1)}%`);
process.stdout.write(`；预测 p̂ 均值 ${(mean(inBand.map((s) => s.probability)) * 100).toFixed(1)}%\n\n`);

// 核心对照：模型对"宣告之后"的终局预测 vs 实际终局。两侧分开看，
// 才能判断偏差是"高估了对手"还是"低估了自己"。
const ownPred = mean(inBand.map((s) => s.predictedOwnScore));
const ownAct = mean(inBand.map((s) => s.actualOwnScore));
const modelOwn = mean(inBand.map((s) => s.modelOwnFinal));
const modelRival = mean(inBand.map((s) => s.modelRivalMin));
const actRival = mean(inBand.map((s) => s.actualRivalMin));
process.stdout.write("量                      模型      实际       偏差\n");
process.stdout.write(`${"宣告时我方手牌分".padEnd(22)}${ownPred.toFixed(2).padStart(8)}${ownAct.toFixed(2).padStart(10)}${fmt(ownAct - ownPred).padStart(10)}\n`);
process.stdout.write(`${"我方终局分（含被换）".padEnd(20)}${modelOwn.toFixed(2).padStart(8)}${ownAct.toFixed(2).padStart(10)}${fmt(ownAct - modelOwn).padStart(10)}\n`);
process.stdout.write(`${"对手最低终局分".padEnd(22)}${modelRival.toFixed(2).padStart(8)}${actRival.toFixed(2).padStart(10)}${fmt(actRival - modelRival).padStart(10)}\n`);
const modelRivalMean = mean(inBand.map((s) => s.modelRivalMean));
const actRivalMean = mean(inBand.map((s) => s.actualRivalMean));
process.stdout.write(`${"对手平均终局分".padEnd(22)}${modelRivalMean.toFixed(2).padStart(8)}${actRivalMean.toFixed(2).padStart(10)}${fmt(actRivalMean - modelRivalMean).padStart(10)}\n`);
process.stdout.write(`${"我方未知牌数".padEnd(22)}${mean(inBand.map((s) => s.unknownOwn)).toFixed(2).padStart(8)}\n`);
process.stdout.write(`${"对手未知牌数".padEnd(22)}${mean(inBand.map((s) => s.rivalKnown.reduce((sum, slots) => sum + slots.filter((card) => card === "?").length, 0))).toFixed(2).padStart(8)}\n`);

// 我赢 vs 我输：分别看我的手牌分和对手最低分，判断偏差来自哪一侧。
const won = inBand.filter((s) => s.succeeded);
const lost = inBand.filter((s) => !s.succeeded);
process.stdout.write("\n分组      样本   模型我方终局  实际我方终局  模型对手最低  实际对手最低\n");
for (const [label, group] of [["我赢", won], ["我输", lost]] as const) {
  process.stdout.write(
    `${label.padEnd(8)}${String(group.length).padStart(6)}`
    + `${mean(group.map((s) => s.modelOwnFinal)).toFixed(2).padStart(14)}`
    + `${mean(group.map((s) => s.actualOwnScore)).toFixed(2).padStart(14)}`
    + `${mean(group.map((s) => s.modelRivalMin)).toFixed(2).padStart(14)}`
    + `${mean(group.map((s) => s.actualRivalMin)).toFixed(2).padStart(14)}\n`,
  );
}

// 模型假设对手"抽到 11/12 就换牌"，实际发生的频率是多少？这是本轮
// 校准偏差的头号嫌疑：模型说我方终局分被换高 2.1 分，实际只高 0.5 分。
const withActions = inBand.filter((sample) => sample.finalTurnActions.length > 0);
const swaps = withActions.flatMap((sample) => sample.finalTurnActions.filter((line) => line.includes("swap")));
process.stdout.write(`\n宣告后有最终回合的样本 ${withActions.length}；其中出现换牌 ${withActions.filter((s) => s.finalTurnActions.some((line) => line.includes("swap"))).length}（${(withActions.filter((s) => s.finalTurnActions.some((line) => line.includes("swap"))).length / Math.max(1, withActions.length) * 100).toFixed(1)}%）\n`);
process.stdout.write(`最终回合动作总数 ${withActions.reduce((sum, s) => sum + s.finalTurnActions.length, 0)}；换牌动作 ${swaps.length}\n`);
const actionKinds = new Map<string, number>();
for (const sample of withActions) {
  for (const line of sample.finalTurnActions) {
    const kind = line.split(":")[1]?.split(/[\s<]/)[0] ?? line;
    actionKinds.set(kind, (actionKinds.get(kind) ?? 0) + 1);
  }
}
process.stdout.write(`动作分布 ${[...actionKinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${count}`).join(" ")}\n`);

// 换牌目标：模型假设对手总是换"我"，实际呢？
const swapLines = withActions.flatMap((sample) => sample.finalTurnActions
  .filter((line) => line.includes("swap"))
  .map((line) => ({ line, seat: sample.seat })));
const targetedAtMe = swapLines.filter(({ line, seat }) => line.includes(`<-${seat}#`)).length;
process.stdout.write(`换牌动作 ${swapLines.length}；目标是宣告者本人 ${targetedAtMe}（${(targetedAtMe / Math.max(1, swapLines.length) * 100).toFixed(1)}%）——模型假设 100%\n`);
process.stdout.write(`换牌样本示例：${swaps.slice(0, 6).join(" | ") || "（无）"}\n`);

if (verbose) {
  process.stdout.write("\n--- 失败案例\n");
  for (const sample of failures.slice(0, 15)) {
    process.stdout.write(`--- ${sample.seat} p̂=${(sample.probability * 100).toFixed(0)}% 预测自己=${sample.predictedOwnScore.toFixed(1)} 未知${sample.unknownOwn}张 实际自己=${sample.actualOwnScore} 实际对手最低=${sample.actualRivalMin}\n`);
    process.stdout.write(`    宣告时我的牌: ${sample.myKnown.join(" ")}\n`);
    sample.rivalKnown.forEach((slots, index) => process.stdout.write(`    宣告时对手${index}: ${slots.join(" ")}\n`));
    process.stdout.write(`    回合结果: ${sample.outcome}\n`);
    sample.actualHands.forEach((hand) => process.stdout.write(`    实际 ${hand}\n`));
  }
}
