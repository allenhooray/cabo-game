import { describe, expect, it } from "vitest";
import { AgentRequestGate } from "./agent-request-gate.js";

describe("Agent request uncertainty gate", () => {
  it("blocks mutations after a timeout until observe succeeds", () => {
    const gate = new AgentRequestGate();
    gate.markTimeout();
    expect(gate.canExecute({ id: "a", type: "action", action: { type: "draw-deck" } })).toBe(false);
    expect(gate.canExecute({ id: "p", type: "ping" })).toBe(true);
    expect(gate.canExecute({ id: "o", type: "observe" })).toBe(true);
    expect(gate.canExecute({ id: "l", type: "leave" })).toBe(true);
    gate.markObserved();
    expect(gate.canExecute({ id: "a2", type: "action", action: { type: "draw-deck" } })).toBe(true);
  });
});
