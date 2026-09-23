import { describe, expect, it } from "vitest";
import type { AgentAction } from "@cabo-game/shared";
import { ACTION_DELAY_RANGES, decisionDelay, decisionDelayRange } from "./plans.js";
import { PERSONAS, jitterPersona } from "./persona.js";

describe("动作与人设的随机节奏", () => {
  for (const persona of Object.values(PERSONAS)) {
    for (const action of Object.keys(ACTION_DELAY_RANGES) as AgentAction["type"][]) {
      it(`${persona.id} / ${action} 保留反应窗口并在上下限内随机`, () => {
        const [min, max] = decisionDelayRange(persona, action);
        expect(min).toBeGreaterThanOrEqual(1200);
        expect(max).toBeGreaterThan(min);
        expect(max).toBeLessThanOrEqual(8000);
        expect(decisionDelay(persona, () => 0, action)).toBe(min);
        expect(decisionDelay(persona, () => 1, action)).toBe(max);
        const samples = [0.1, 0.3, 0.7, 0.9].map((value) => decisionDelay(persona, () => value, action));
        expect(new Set(samples).size).toBe(4);
        for (const sample of samples) {
          expect(sample).toBeGreaterThan(min);
          expect(sample).toBeLessThan(max);
        }
        expect(decisionDelayRange(jitterPersona(persona, () => 0), action)[0]).toBeGreaterThanOrEqual(1200);
      });
    }
  }

  it("相同动作随人设放慢，复杂动作和结算留出更多时间", () => {
    expect(decisionDelayRange(PERSONAS.chill, "swap")[0]).toBeGreaterThan(decisionDelayRange(PERSONAS.mnemo, "swap")[0]);
    expect(decisionDelayRange(PERSONAS.mnemo, "swap")[0]).toBeGreaterThan(decisionDelayRange(PERSONAS.mnemo, "draw-deck")[0]);
    expect(decisionDelayRange(PERSONAS.mnemo, "ready-next-round")[0]).toBeGreaterThan(3000);
  });

  it("零思考时间仍保留动作基础反应窗口", () => {
    expect(decisionDelay({ ...PERSONAS.mnemo, decisionLatencyMs: 0 }, () => 0.5, "swap")).toBe(2850);
  });
});
