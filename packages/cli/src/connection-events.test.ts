import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionEventGate, isRedundantSelfReconnectEvent } from "./connection-events.js";

afterEach(() => vi.useRealTimers());

describe("connection event reporting", () => {
  it("keeps a quick automatic reconnect out of recent events", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const gate = createConnectionEventGate(emit);

    gate.dropped();
    vi.advanceTimersByTime(250);
    gate.reconnected();
    vi.runAllTimers();

    expect(emit).not.toHaveBeenCalled();
  });

  it("reports a sustained drop and its later recovery once", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const gate = createConnectionEventGate(emit);

    gate.dropped();
    vi.advanceTimersByTime(1_000);
    gate.reconnected();
    gate.reconnected();

    expect(emit.mock.calls.map(([message]) => message)).toEqual([
      "Connection dropped. Your seat is held for 60 seconds; use reconnect if recovery fails.",
      "Reconnected.",
    ]);
  });

  it("suppresses the server broadcast that duplicates this client's reconnect", () => {
    expect(isRedundantSelfReconnectEvent({ type: "reconnected", playerId: "self" }, "self")).toBe(true);
    expect(isRedundantSelfReconnectEvent({ type: "reconnected", playerId: "other" }, "self")).toBe(false);
    expect(isRedundantSelfReconnectEvent({ type: "joined", playerId: "self" }, "self")).toBe(false);
  });
});
