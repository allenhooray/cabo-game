import { describe, expect, it, vi } from "vitest";
import type { Client } from "colyseus";
import { CaboRoom } from "./CaboRoom.js";

describe("agent command acknowledgements", () => {
  it("keeps the legacy command channel and returns the committed revision", () => {
    const room = new CaboRoom();
    const send = vi.fn();
    const client = { sessionId: "a", send } as unknown as Client;
    const internals = room as unknown as {
      runCommand: (client: Client, command: unknown) => void;
      handleAgentCommand: (client: Client, payload: unknown) => void;
      bumpRevision: () => void;
    };
    internals.runCommand = () => internals.bumpRevision();
    internals.handleAgentCommand(client, { id: "x", command: { type: "start" } });
    expect(send).toHaveBeenCalledWith("agent-result", { id: "x", ok: true, revision: 1 });
    expect(room.messages.command).toBeTypeOf("function");
  });

  it("returns structured errors without changing revision", () => {
    const room = new CaboRoom();
    const send = vi.fn();
    const client = { sessionId: "a", send } as unknown as Client;
    const internals = room as unknown as { handleAgentCommand: (client: Client, payload: unknown) => void };
    internals.handleAgentCommand(client, { id: "bad", command: { type: "replace", position: 9 } });
    expect(send).toHaveBeenCalledWith("agent-result", expect.objectContaining({
      id: "bad", ok: false, revision: 0, error: expect.objectContaining({ code: "INVALID_COMMAND" }),
    }));
  });
});
