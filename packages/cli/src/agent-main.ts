#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import {
  AGENT_ACTION_TYPES,
  AGENT_FRAME_TYPES,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUEST_TYPES,
  agentProtocolJsonSchema,
  type AgentCommandResult,
  type ErrorMessage,
  type PrivateRevealMessage,
} from "@cabo/shared";
import { AgentOptionError, parseAgentOptions, renderAgentHelp, type AgentCliOptions } from "./agent-options.js";
import { AgentProtocolError, buildObservation, parseAgentRequest, type AgentRequest } from "./agent-protocol.js";
import { AgentRequestGate } from "./agent-request-gate.js";
import { AgentRequestTimeoutError, CaboClientCore } from "./client-core.js";

const CAPABILITIES = ["describe", "ping", "json-schema", "request-timeout"] as const;

function writeJson(frame: unknown): void {
  // stdout 是协议通道，任何面向人的诊断信息都必须留在 stderr。
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof AgentProtocolError || error instanceof AgentOptionError || error instanceof AgentRequestTimeoutError) {
    return { code: error.code, message: error.message };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "REQUEST_FAILED",
    message: typeof candidate?.message === "string" ? candidate.message : String(error),
  };
}

async function readCliVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("CLI package version is unavailable.");
  return packageJson.version;
}

class LocalRequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly uncertain = true;

  constructor(id: string) {
    super(`Request ${id} did not complete before the timeout.`);
    this.name = "LocalRequestTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, id: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocalRequestTimeoutError(id)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

interface ExecutionOutcome {
  ok: boolean;
  data?: unknown;
  error?: ErrorMessage;
  revision?: number;
  shutdown?: boolean;
}

async function run(options: Extract<AgentCliOptions, { mode: "run" }>, cliVersion: string): Promise<void> {
  let core!: CaboClientCore;
  const requestGate = new AgentRequestGate();
  let accepting = true;
  let protocolShutdown = false;
  let signalExitCode: number | undefined;
  let closePromise: Promise<void> | undefined;

  const emitObservation = (): void => {
    if (!core.room || !core.state) return;
    writeJson({ type: "observation", ...buildObservation(core.state, core.room.sessionId, core.room.roomId, core.knowledge) });
  };

  core = new CaboClientCore({
    serverUrl: options.serverUrl,
    playerName: options.playerName,
    ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
    handlers: {
      state: () => emitObservation(),
      reveal: (message: PrivateRevealMessage) => {
        writeJson({ type: "event", event: { type: "private-reveal", ...message } });
        emitObservation();
      },
      event: (event: unknown) => {
        writeJson({ type: "event", event });
        emitObservation();
      },
      error: (message: ErrorMessage) => writeJson({ type: "event", event: { type: "command-error", ...message } }),
      dropped: () => writeJson({ type: "event", event: { type: "connection-dropped" } }),
      reconnected: () => writeJson({ type: "event", event: { type: "connection-restored" } }),
      left: () => writeJson({ type: "event", event: { type: "room-left" } }),
      persistenceError: (error: unknown) => process.stderr.write(`Session persistence failed: ${error instanceof Error ? error.message : String(error)}\n`),
    },
  });

  const closeCore = (): Promise<void> => {
    closePromise ??= core.close();
    return closePromise;
  };

  const describe = () => ({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    cliVersion,
    requestTypes: [...AGENT_REQUEST_TYPES],
    frameTypes: [...AGENT_FRAME_TYPES],
    actionTypes: [...AGENT_ACTION_TYPES],
    defaults: {
      server: options.serverUrl,
      requestTimeoutMs: options.requestTimeoutMs,
      sessionPersistence: Boolean(options.sessionPath),
    },
    schemaCommand: "cabo-agent --print-schema",
  });

  const ping = () => ({
    connected: Boolean(core.room && core.state),
    server: options.serverUrl,
    roomId: core.room?.roomId ?? null,
    selfId: core.room?.sessionId ?? null,
    revision: core.state?.revision ?? null,
    phase: core.state?.phase ?? null,
  });

  async function execute(request: AgentRequest): Promise<ExecutionOutcome> {
    switch (request.type) {
      case "rooms": return { ok: true, data: { rooms: await core.listRooms() } };
      case "create":
        await core.create(request.visibility, request.targetScore, request.password);
        return { ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } };
      case "join":
        await core.join(request.roomId, request.password);
        return { ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } };
      case "reconnect":
        await core.reconnect();
        return { ok: true, data: { roomId: core.room?.roomId, selfId: core.room?.sessionId } };
      case "observe":
        if (!core.room || !core.state) throw new AgentProtocolError("NOT_CONNECTED", "Join a room first.", request.id);
        requestGate.markObserved();
        return { ok: true, data: buildObservation(core.state, core.room.sessionId, core.room.roomId, core.knowledge) };
      case "describe": return { ok: true, data: describe() };
      case "ping": return { ok: true, data: ping() };
      case "action": {
        const result: AgentCommandResult = await core.sendAgent(request.id, request.action, options.requestTimeoutMs);
        return result.ok
          ? { ok: true, data: { revision: result.revision } }
          : { ok: false, error: result.error, revision: result.revision };
      }
      case "leave":
        await core.leave();
        requestGate.markObserved();
        return { ok: true };
      case "shutdown":
        await closeCore();
        return { ok: true, shutdown: true };
    }
  }

  writeJson({
    type: "ready",
    protocolVersion: AGENT_PROTOCOL_VERSION,
    cliVersion,
    server: options.serverUrl,
    name: options.playerName,
    sessionPersistence: Boolean(options.sessionPath),
    requestTimeoutMs: options.requestTimeoutMs,
    capabilities: [...CAPABILITIES],
  });

  const rl = createInterface({ input: stdin, terminal: false });
  let queue = Promise.resolve(true);
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });

  rl.on("line", (line) => {
    if (!accepting || !line.trim()) return;
    queue = queue.then(async (keepRunning) => {
      if (!keepRunning) return false;
      let request: AgentRequest;
      try {
        request = parseAgentRequest(line);
      } catch (error) {
        const protocolError = error instanceof AgentProtocolError ? error : undefined;
        writeJson({ type: "result", id: protocolError?.id ?? null, ok: false, error: errorPayload(error) });
        return true;
      }
      if (!requestGate.canExecute(request)) {
        writeJson({
          type: "result",
          id: request.id,
          ok: false,
          error: { code: "STATE_UNCERTAIN", message: "Run observe before sending another state-changing request." },
          uncertain: true,
        });
        return true;
      }
      try {
        const execution = execute(request);
        const outcome = request.type === "action"
          ? await execution
          : await withTimeout(execution, request.id, options.requestTimeoutMs);
        if (outcome.ok) writeJson({ type: "result", id: request.id, ok: true, ...(outcome.data === undefined ? {} : { data: outcome.data }) });
        else writeJson({ type: "result", id: request.id, ok: false, error: outcome.error, ...(outcome.revision === undefined ? {} : { revision: outcome.revision }) });
        if (outcome.shutdown) {
          protocolShutdown = true;
          accepting = false;
          rl.close();
          return false;
        }
      } catch (error) {
        const uncertain = error instanceof AgentRequestTimeoutError || error instanceof LocalRequestTimeoutError;
        if (uncertain) requestGate.markTimeout();
        writeJson({ type: "result", id: request.id, ok: false, error: errorPayload(error), ...(uncertain ? { uncertain: true } : {}) });
      }
      return true;
    });
  });

  rl.on("close", () => {
    accepting = false;
    if (protocolShutdown) {
      void queue.finally(resolveCompletion);
      return;
    }
    queue = queue.then(async () => {
      try { await closeCore(); }
      catch (error) {
        process.stderr.write(`Graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      if (process.exitCode === undefined) process.exitCode = signalExitCode ?? 0;
      return false;
    });
    void queue.finally(resolveCompletion);
  });

  const handleSignal = (exitCode: number): void => {
    if (protocolShutdown || signalExitCode !== undefined) return;
    signalExitCode = exitCode;
    accepting = false;
    rl.close();
  };
  process.once("SIGINT", () => handleSignal(130));
  process.once("SIGTERM", () => handleSignal(143));
  await completion;
}

async function main(): Promise<void> {
  let options: AgentCliOptions;
  try {
    options = parseAgentOptions(process.argv.slice(2), process.env.USER ?? "Agent");
  } catch (error) {
    writeJson({ type: "fatal", error: errorPayload(error) });
    process.exitCode = 2;
    return;
  }
  if (options.mode === "help") {
    stdout.write(`${renderAgentHelp()}\n`);
    return;
  }
  if (options.mode === "schema") {
    writeJson(agentProtocolJsonSchema());
    return;
  }
  const cliVersion = await readCliVersion();
  if (options.mode === "version") {
    stdout.write(`${cliVersion}\n`);
    return;
  }
  await run(options, cliVersion);
}

try {
  await main();
} catch (error) {
  writeJson({ type: "fatal", error: errorPayload(error) });
  process.exitCode = 1;
}
