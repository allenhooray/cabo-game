import { describe, expect, it, vi } from "vitest";
import { AgentRequestTimeoutError, CaboClientCore } from "./client-core.js";
import type { CaboStateLike } from "./model.js";

function state(revision = 0): CaboStateLike {
  return {
    revision,
    roomName: "Bot's room",
    phase: "TURN_START",
    round: 1,
    targetScore: 100,
    currentPlayerId: "self",
    caboCallerId: "",
    discardLabel: "4H",
    discardRank: 4,
    deckCount: 40,
    players: new Map(),
    winners: [],
  };
}

describe("agent request timeouts", () => {
  it("cancels result and revision waiters and ignores late acknowledgements", async () => {
    const messages = new Map<string, (payload: any) => void>();
    let stateChange: ((next: CaboStateLike) => void) | undefined;
    const room = {
      state: state(), roomId: "room", sessionId: "self", reconnectionToken: "token",
      send: vi.fn(),
      onStateChange: (callback: (next: CaboStateLike) => void) => { stateChange = callback; },
      onMessage: (type: string, callback: (payload: any) => void) => { messages.set(type, callback); },
      onDrop: vi.fn(), onReconnect: vi.fn(), onLeave: vi.fn(), leave: vi.fn(),
    };
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Bot" });
    const internals = core as unknown as {
      attach(nextRoom: unknown): Promise<void>;
      pendingAgentResults: Map<string, unknown>;
      revisionWaiters: unknown[];
    };
    await internals.attach(room);

    await expect(core.sendAgent("no-ack", { type: "draw-deck" }, 10)).rejects.toBeInstanceOf(AgentRequestTimeoutError);
    expect(internals.pendingAgentResults.size).toBe(0);

    const revisionTimeout = core.sendAgent("late", { type: "draw-deck" }, 20);
    messages.get("agent-result")?.({ id: "late", ok: true, revision: 1 });
    await expect(revisionTimeout).rejects.toBeInstanceOf(AgentRequestTimeoutError);
    expect(internals.revisionWaiters).toHaveLength(0);
    stateChange?.(state(1));

    const reused = core.sendAgent("late", { type: "draw-deck" }, 50);
    messages.get("agent-result")?.({ id: "late", ok: false, revision: 1, error: { code: "INVALID_PHASE", message: "no" } });
    await expect(reused).resolves.toMatchObject({ id: "late", ok: false });
  });

  it("sends the object-style create options including roomName", async () => {
    const room = {
      state: state(), roomId: "room", sessionId: "self", reconnectionToken: "token",
      send: vi.fn(),
      onStateChange: vi.fn(),
      onMessage: vi.fn(),
      onDrop: vi.fn(), onReconnect: vi.fn(), onLeave: vi.fn(), leave: vi.fn(),
    };
    const core = new CaboClientCore({ serverUrl: "http://localhost", playerName: "Bot" });
    const create = vi.spyOn(core.client, "create").mockResolvedValue(room as any);

    await core.create({ memoryMode: "assisted", turnDurationSeconds: 60, visibility: "private", targetScore: 150, roomName: "Bots' room", password: "123456" });

    expect(create).toHaveBeenCalledWith("cabo", {
      name: "Bot", memoryMode: "assisted", turnDurationSeconds: 60, visibility: "private", targetScore: 150, roomName: "Bots' room", password: "123456",
    });
  });
});
