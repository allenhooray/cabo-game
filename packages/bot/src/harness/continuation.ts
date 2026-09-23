/**
 * 续打价值测量：`E[最终手牌分 | 当前手牌分]` 到底是多少？
 *
 * 为什么需要这个：闭式阈值 `P > 5/(H+5)` 的推导里把"继续打下去"的价值
 * 当成了当前手牌分 H，但不宣告 Cabo 的人**不吃那 +5 惩罚**，他的回合分
 * 就是最终手牌分 `H_final`，而继续打只会让手牌分更低。正确的不等式是
 *
 *   (1−P)·(H + 5) < E[H_final]     →     P > 1 − E[H_final]/(H+5)
 *                                      = (5 + δ)/(H+5),  δ = H − E[H_final]
 *
 * δ 不能凭感觉设，所以这里直接量。只统计**没有宣告 cabo 的玩家**——
 * 他们的轨迹是完整的；宣告者的轨迹在宣告那一刻就截断了，拿来拟合会偏低。
 *
 * 用法：
 *   GAMES=400 ../../node_modules/.bin/tsx src/harness/continuation.ts
 */
import { seededRandom, type MemoryMode } from "@cabo-game/shared";
import { applyObservation, applyPrivateReveal, applyPublicAction, createBelief, type Belief } from "../belief.js";
import { expectedHandScore } from "../evaluate.js";
import { decide, moodFromHistory } from "../policy.js";
import { PERSONAS, type BotPersona, type PersonaId } from "../persona.js";
import { SelfPlayTable, type SeatEvent } from "./engine-adapter.js";

interface Sample {
  /** 该回合该玩家**自己估计**的当前手牌分。 */
  current: number;
  /** 该玩家本轮结束时的手牌分。 */
  final: number;
  /** 该玩家本轮是否宣告过 cabo（宣告则轨迹被截断，不参与拟合）。 */
  declared: boolean;
}

const personas: PersonaId[] = (process.env.PERSONAS?.split(",") as PersonaId[] | undefined)
  ?? ["mnemo", "gambler", "gremlin", "abacus"];
const games = Number(process.env.GAMES ?? 400);
const samples = Number(process.env.SAMPLES ?? 100);
const memoryMode: MemoryMode = "assisted";

const collected: Sample[] = [];

for (let game = 0; game < games; game += 1) {
  const seed = 20260923 + game * 7919;
  const rng = seededRandom(seed);
  const seats = personas.map((_, index) => `seat-${index}`);
  const table = new SelfPlayTable({ playerIds: seats, targetScore: 100, memoryMode, seed });
  const beliefs = new Map<string, Belief>();
  const personaBySeat = new Map<string, BotPersona>();
  personas.forEach((personaId, index) => {
    beliefs.set(`seat-${index}`, createBelief(`seat-${index}`, memoryMode));
    personaBySeat.set(`seat-${index}`, PERSONAS[personaId]);
  });

  /** 本轮每个玩家记录下来的观测点。 */
  let roundSamples: Array<{ seat: string; current: number }> = [];
  let declared = new Set<string>();

  const flush = (): void => {
    const history = table.observationFor(seats[0] as string).state.roundHistory;
    const entry = history[history.length - 1];
    if (entry) {
      for (const point of roundSamples) {
        const hand = entry.players.find((player) => player.playerId === point.seat);
        if (!hand) continue;
        collected.push({ current: point.current, final: hand.handScore, declared: declared.has(point.seat) });
      }
    }
    roundSamples = [];
    declared = new Set();
  };

  table.start();
  let steps = 0;
  while (table.phase !== "MATCH_RESULT" && steps++ < 20000) {
    if (table.phase === "ROUND_RESULT") {
      flush();
      table.nextRound();
      continue;
    }
    const seat = table.currentPlayerId;
    if (!seat) break;
    const belief = beliefs.get(seat);
    const persona = personaBySeat.get(seat);
    if (!belief || !persona) break;

    const turn = table.takeTurn(seat);
    for (const event of turn.events as SeatEvent[]) {
      if (event.type === "private-reveal") applyPrivateReveal(belief, event);
      else if (event.type === "action") applyPublicAction(belief, event);
    }
    applyObservation(belief, turn.observation);

    roundSamples.push({ seat, current: expectedHandScore(belief, persona) });

    const action = decide({ belief, observation: turn.observation, persona, rng, mood: moodFromHistory(turn.observation, seat), samples });
    if (!action) break;
    if (action.type === "cabo") declared.add(seat);
    if (!table.apply(seat, action).ok) break;
  }
  flush();
}

const clean = collected.filter((sample) => !sample.declared);
const mean = (values: number[]): number => values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

process.stdout.write(`观测点 ${collected.length}；其中未宣告的 ${clean.length}（${(clean.length / Math.max(1, collected.length) * 100).toFixed(1)}%）\n\n`);

// 按当前手牌分分桶，看"继续打下去"平均能降到多少。
const edges = [0, 3, 6, 9, 12, 16, 20, 26, 34, 60];
process.stdout.write("当前H区间     样本   平均当前H   平均最终H     δ=H−H_final   δ/H    建议门槛(5+δ)/(H+5)\n");
for (let index = 0; index < edges.length - 1; index += 1) {
  const low = edges[index] as number;
  const high = edges[index + 1] as number;
  const bucket = clean.filter((sample) => sample.current >= low && sample.current < high);
  if (bucket.length < 20) continue;
  const current = mean(bucket.map((sample) => sample.current));
  const final = mean(bucket.map((sample) => sample.final));
  const delta = current - final;
  const suggested = (5 + delta) / (current + 5);
  process.stdout.write(
    `${`${low}-${high}`.padEnd(13)}${String(bucket.length).padStart(5)}`
    + `${current.toFixed(2).padStart(12)}`
    + `${final.toFixed(2).padStart(12)}`
    + `${delta.toFixed(2).padStart(14)}`
    + `${(delta / Math.max(1e-9, current)).toFixed(2).padStart(8)}`
    + `${suggested.toFixed(3).padStart(20)}`
    + `   （现行 ${(5 / (current + 5)).toFixed(3)}）\n`,
  );
}

// 顺带量一下：宣告时的手牌分分布，以及"回合刚开始就宣告"的比例。
const decl = collected.filter((sample) => sample.declared);
process.stdout.write(`\n宣告时平均手牌分 ${mean(decl.map((sample) => sample.current)).toFixed(2)}（未宣告的观测点平均 ${mean(clean.map((sample) => sample.current)).toFixed(2)}）\n`);
