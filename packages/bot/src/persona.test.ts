/**
 * 人设层单测（方案 M4 / §6.3）。
 *
 * M4 的验收门槛是一条**行为差异**，不是参数表差异：
 *
 *   赌徒的 Cabo 宣告频率 > 算盘的 3 倍
 *
 * 参数表看着不一样不算数 —— 阈值必须真的把行为拉开，人设才算立住。
 * 所以这个文件里最重的两条测试是"跑自对弈、比行为"，上面那些参数校验
 * 只是防止抖动/夹取把人设偷偷改坏。
 */
import { describe, expect, it } from "vitest";
import { runSelfPlay } from "./harness/self-play.js";
import {
  PERSONAS,
  PERSONA_IDS,
  PERSONA_RANGES,
  RATIONAL_DISCOUNT,
  clampPersonaValue,
  getPersona,
  jitterPersona,
  opponentDiscount,
  scaleCaution,
  tiltedPersona,
  type BotPersona,
  type NumericPersonaKey,
} from "./persona.js";

const NUMERIC_KEYS = Object.keys(PERSONA_RANGES) as NumericPersonaKey[];

describe("人设参数表", () => {
  it("六个 ID 都有人设，且 id 字段自洽", () => {
    expect(PERSONA_IDS).toHaveLength(6);
    for (const id of PERSONA_IDS) {
      expect(getPersona(id).id).toBe(id);
      expect(getPersona(id).displayName.length).toBeGreaterThan(0);
    }
  });

  it("每个人设的每个数值参数都落在量程内", () => {
    for (const id of PERSONA_IDS) {
      const persona = getPersona(id);
      for (const key of NUMERIC_KEYS) {
        const [min, max] = PERSONA_RANGES[key];
        const value = persona[key];
        expect(Number.isFinite(value), `${id}.${key} 不是有限数`).toBe(true);
        expect(value, `${id}.${key} = ${value} 越界 [${min}, ${max}]`).toBeGreaterThanOrEqual(min);
        expect(value, `${id}.${key} = ${value} 越界 [${min}, ${max}]`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("月神野心只有月神一个人设非零（D5：本期只保留参数位）", () => {
    const ambitious = PERSONA_IDS.filter((id) => getPersona(id).moonAmbition > 0);
    expect(ambitious).toEqual(["moonchild"]);
  });

  it("风险偏好的排序与设计一致：佛系老王 > 算盘 > 记忆大师 > 赌徒", () => {
    const k = (id: (typeof PERSONA_IDS)[number]): number => getPersona(id).cautionFactor;
    expect(k("chill")).toBeGreaterThan(k("abacus"));
    expect(k("abacus")).toBeGreaterThan(k("mnemo"));
    expect(k("mnemo")).toBeGreaterThan(k("gambler"));
  });
});

describe("参数夹取与抖动", () => {
  it("clampPersonaValue 两端都夹", () => {
    expect(clampPersonaValue("cautionFactor", -10)).toBe(PERSONA_RANGES.cautionFactor[0]);
    expect(clampPersonaValue("cautionFactor", 99)).toBe(PERSONA_RANGES.cautionFactor[1]);
    expect(clampPersonaValue("cautionFactor", 1.5)).toBeCloseTo(1.5, 10);
  });

  it("rng 恒为 0.5 时抖动是恒等变换", () => {
    for (const id of PERSONA_IDS) {
      const jittered = jitterPersona(getPersona(id), () => 0.5);
      for (const key of NUMERIC_KEYS) {
        expect(jittered[key], `${id}.${key}`).toBeCloseTo(getPersona(id)[key], 10);
      }
    }
  });

  it("任意抖动都不越界（扫 200 组伪随机）", () => {
    let state = 7;
    const rng = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (const id of PERSONA_IDS) {
      for (let index = 0; index < 200; index += 1) {
        const jittered = jitterPersona(getPersona(id), rng, 0.3);
        for (const key of NUMERIC_KEYS) {
          const [min, max] = PERSONA_RANGES[key];
          expect(jittered[key]).toBeGreaterThanOrEqual(min);
          expect(jittered[key]).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("scaleCaution 只动 cautionFactor，其余字段原样", () => {
    const base = PERSONAS.mnemo;
    const scaled = scaleCaution(base, 1.5);
    expect(scaled.cautionFactor).toBeCloseTo(base.cautionFactor * 1.5, 10);
    for (const key of NUMERIC_KEYS) {
      if (key === "cautionFactor") continue;
      expect(scaled[key], key).toBe(base[key]);
    }
    // 缩放后仍要夹回量程。
    expect(scaleCaution(base, 100).cautionFactor).toBe(PERSONA_RANGES.cautionFactor[1]);
    expect(scaleCaution(base, 0).cautionFactor).toBe(PERSONA_RANGES.cautionFactor[0]);
  });
});

describe("对手折扣与情绪漂移", () => {
  it("opponentDiscount 随 countingSkill 单调下降，两端取值正确", () => {
    expect(opponentDiscount({ ...PERSONAS.mnemo, countingSkill: 0 })).toBeCloseTo(1, 10);
    expect(opponentDiscount({ ...PERSONAS.mnemo, countingSkill: 1 })).toBeCloseTo(RATIONAL_DISCOUNT, 10);
    expect(opponentDiscount({ ...PERSONAS.mnemo, countingSkill: 0.5 }))
      .toBeCloseTo(1 - 0.5 * (1 - RATIONAL_DISCOUNT), 10);
  });

  it("tiltedPersona：mood ≤ 0 或 tiltGain = 0 时是恒等变换", () => {
    const base = PERSONAS.gambler;
    expect(tiltedPersona(base, 0)).toBe(base);
    expect(tiltedPersona(base, -1)).toBe(base);
    const stoic: BotPersona = { ...base, tiltGain: 0 };
    expect(tiltedPersona(stoic, 1)).toBe(stoic);
  });

  it("tiltedPersona：情绪拉满时更莽——失误率、攻击性上升，风险偏好下降", () => {
    const base = PERSONAS.gambler;
    const tilted = tiltedPersona(base, 1);
    expect(tilted.mistakeRate).toBeGreaterThan(base.mistakeRate);
    expect(tilted.swapAggression).toBeGreaterThan(base.swapAggression);
    expect(tilted.cautionFactor).toBeLessThan(base.cautionFactor);
  });
});

/**
 * M4 的正式验收门槛。
 *
 * 用 `gambler,gambler,abacus,abacus` 同桌对打：四个人坐同一副牌、同一批对手，
 * 唯一的差别就是人设。这样比出来的频率差才干净，不受对局难度影响。
 *
 * 实测（120 局）：赌徒 2.40 次/局，算盘 0.42 次/局，比值 5.7。
 * 门槛是 3 倍，留了接近一倍的安全边际。
 */
describe("M4 · 人设差异化验收", () => {
  it("赌徒的 Cabo 宣告频率 > 算盘的 3 倍", () => {
    const report = runSelfPlay({
      personas: ["gambler", "gambler", "abacus", "abacus"],
      games: 120,
      seed: 20260923,
      samples: 100,
      jitter: false,
    });
    expect(report.failures).toEqual([]);

    const gambler = report.stats.find((stat) => stat.personaId === "gambler");
    const abacus = report.stats.find((stat) => stat.personaId === "abacus");
    expect(gambler).toBeDefined();
    expect(abacus).toBeDefined();
    // 两个座位 × 120 局。
    expect(gambler?.seatGames).toBe(240);
    expect(abacus?.seatGames).toBe(240);

    expect(abacus?.caboAttemptsPerGame ?? 0).toBeGreaterThan(0);
    expect(gambler?.caboAttemptsPerGame ?? 0)
      .toBeGreaterThan(3 * (abacus?.caboAttemptsPerGame ?? 0));

    // 顺带确认人设的代价确实存在：赌徒宣告得多、成功率低、总分更差。
    expect(gambler?.caboSuccessRate ?? 1).toBeLessThan(abacus?.caboSuccessRate ?? 0);
    expect(gambler?.averageRoundScore ?? 0).toBeGreaterThan(abacus?.averageRoundScore ?? 0);
  }, 240_000);

  it("风险偏好确实映射到行为：佛系老王宣告得比记忆大师少", () => {
    const report = runSelfPlay({
      personas: ["mnemo", "mnemo", "chill", "chill"],
      games: 120,
      seed: 20260923,
      samples: 100,
      jitter: false,
    });
    expect(report.failures).toEqual([]);
    const mnemo = report.stats.find((stat) => stat.personaId === "mnemo");
    const chill = report.stats.find((stat) => stat.personaId === "chill");
    expect(chill?.caboAttemptsPerGame ?? 1).toBeLessThan(mnemo?.caboAttemptsPerGame ?? 0);
  }, 240_000);
});
