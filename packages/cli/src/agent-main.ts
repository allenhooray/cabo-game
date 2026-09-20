#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { ErrorMessage, PrivateRevealMessage } from "@cabo/shared";
import { AgentProtocolError, buildObservation, parseAgentRequest, type AgentRequest } from "./agent-protocol.js";
import { CaboClientCore } from "./client-core.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function write(frame: unknown): void {
  // stdout 是协议通道，任何面向人的诊断信息都必须留在 stderr。
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof AgentProtocolError) return { code: error.code, message: error.message };
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED",
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
}

const serverUrl = (option("--server") ?? "http://localhost:2567").replace(/\/$/, "");
const playerName = (option("--name") ?? process.env.USER ?? "Agent").trim().slice(0, 20);
const sessionPath = option("--session-file");

if (!playerName) {
  write({ type: "fatal", error: { code: "INVALID_ARGUMENT", message: "--name must not be empty." } });
  process.exitCode = 2;
} else {
  let core!: CaboClientCore;
  const emitObservation = (): void => {
    if (!core.room || !core.state) return;
    write({ type: "observation", ...buildObservation(core.state, core.room.sessionId, core.room.roomId, core.knowledge) });
  };

  core = new CaboClientCore({
    serverUrl,
    playerName,
    ...(sessionPath ? { sessionPath } : {}),
    handlers: {
      state: () => emitObservation(),
      reveal: (message: PrivateRevealMessage) => {
        write({ type: "event", event: { type: "private-reveal", ...message } });
        emitObservation();
      },
      event: (event: unknown) => {
        write({ type: "event", event });
        emitObservation();
      },
      error: (message: ErrorMessage) => write({ type: "event", event: { type: "command-error", ...message } }),
      dropped: () => write({ type: "event", event: { type: "connection-dropped" } }),
      reconnected: () => write({ type: "event", event: { type: "connection-restored" } }),
      left: () => write({ type: "event", event: { type: "room-left" } }),
      persistenceError: (error: unknown) => process.stderr.write(`Session persistence failed: ${error instanceof Error ? error.message : String(error)}\n`),
    },
  });

  write({ type: "ready", protocolVersion: 1, server: serverUrl, name: playerName, sessionPersistence: Boolean(sessionPath) });

  async function execute(request: AgentRequest): Promise<boolean> {
    switch (request.type) {
      case "rooms":
        write({ type: "result", id: request.id, ok: true, data: { rooms: await core.listRooms() } });
        break;
      case "create":
        await core.create(request.visibility, request.targetScore, request.password);
        write({ type: "result", id: request.id, ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } });
        break;
      case "join":
        await core.join(request.roomId, request.password);
        write({ type: "result", id: request.id, ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } });
        break;
      case "reconnect":
        await core.reconnect();
        write({ type: "result", id: request.id, ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } });
        break;
      case "observe":
        if (!core.room || !core.state) throw new AgentProtocolError("NOT_CONNECTED", "Join a room first.", request.id);
        write({ type: "result", id: request.id, ok: true, data: buildObservation(core.state, core.room.sessionId, core.room.roomId, core.knowledge) });
        break;
      case "action": {
        const result = await core.sendAgent(request.id, request.action);
        if (result.ok) write({ type: "result", id: request.id, ok: true, data: { revision: result.revision } });
        else write({ type: "result", id: request.id, ok: false, error: result.error, revision: result.revision });
        break;
      }
      case "leave":
        await core.leave();
        write({ type: "result", id: request.id, ok: true });
        break;
      case "shutdown":
        await core.close();
        write({ type: "result", id: request.id, ok: true });
        return false;
    }
    return true;
  }

  const rl = createInterface({ input: stdin, terminal: false });
  let queue = Promise.resolve(true);
  let accepting = true;
  rl.on("line", (line) => {
    if (!accepting || !line.trim()) return;
    queue = queue.then(async (keepRunning) => {
      if (!keepRunning) return false;
      let request: AgentRequest;
      try {
        request = parseAgentRequest(line);
      } catch (error) {
        const protocolError = error instanceof AgentProtocolError ? error : undefined;
        write({ type: "result", id: protocolError?.id ?? null, ok: false, error: errorPayload(error) });
        return true;
      }
      try {
        const keepRunning = await execute(request);
        if (!keepRunning) {
          accepting = false;
          rl.close();
        }
        return keepRunning;
      } catch (error) {
        write({ type: "result", id: request.id, ok: false, error: errorPayload(error) });
        return true;
      }
    });
  });
}
