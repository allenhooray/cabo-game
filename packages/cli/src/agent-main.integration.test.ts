import { createServer } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { agentFrameSchema } from "@cabo-game/shared";
import { afterEach, describe, expect, it } from "vitest";

interface JsonProcess {
  child: ChildProcessWithoutNullStreams;
  frames: any[];
  rawLines: string[];
  errors: string[];
  waitFor(predicate: (frame: any) => boolean): Promise<any>;
  send(frame: unknown): void;
}

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children.length = 0;
});

describe("cabo-agent process protocol", () => {
  it("runs two isolated JSONL agents through a complete turn", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const tsx = resolve(root, "node_modules/.bin/tsx");
    const port = await freePort();
    const server = spawn(tsx, [resolve(root, "packages/server/src/main.ts")], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
    });
    children.push(server);
    await waitForText(server, "Cabo server listening");

    const alice = jsonProcess(spawn(tsx, [resolve(root, "packages/cli/src/agent-main.ts"), "--server", `http://localhost:${port}`, "--name", "Alice"], { cwd: root }));
    const bob = jsonProcess(spawn(tsx, [resolve(root, "packages/cli/src/agent-main.ts"), "--server", `http://localhost:${port}`, "--name", "Bob"], { cwd: root }));
    expect((await alice.waitFor((frame) => frame.type === "ready")).sessionPersistence).toBe(false);
    expect((await bob.waitFor((frame) => frame.type === "ready")).sessionPersistence).toBe(false);
    const described = await request(alice, { id: "describe", type: "describe" });
    expect(described.data.requestTypes).toContain("ping");
    expect(described.data.schemaCommand).toBe("cabo-agent --print-schema");
    const disconnectedPing = await request(bob, { id: "ping-before", type: "ping" });
    expect(disconnectedPing.data).toMatchObject({ connected: false, roomId: null, revision: null });

    const created = await request(alice, { id: "create", type: "create", memoryMode: "assisted", turnDurationSeconds: 60, visibility: "public", targetScore: 100, roomName: "Bots' room" });
    const roomId = created.data.roomId as string;
    expect(created.data.roomName).toBe("Bots' room");
    const listed = await request(bob, { id: "rooms", type: "rooms" });
    expect(listed.data.rooms).toContainEqual(expect.objectContaining({
      roomId, roomName: "Bots' room", isFull: false, isStarted: false, canJoin: true,
    }));
    const joined = await request(bob, { id: "join", type: "join", roomId });
    expect(joined.data.selfId).not.toBe(created.data.selfId);
    const connectedPing = await request(bob, { id: "ping-after", type: "ping" });
    expect(connectedPing.data).toMatchObject({ connected: true, roomId, roomName: "Bots' room", selfId: joined.data.selfId });

    await alice.waitFor((frame) => frame.type === "observation" && frame.state.players.length === 2);
    const started = await request(alice, { id: "start", type: "action", action: { type: "start" } });
    const startRevision = started.data.revision as number;
    const committedStateIndex = alice.frames.findIndex((frame) => frame.type === "observation" && frame.revision >= startRevision);
    const startResultIndex = alice.frames.findIndex((frame) => frame.type === "result" && frame.id === "start");
    expect(committedStateIndex).toBeGreaterThanOrEqual(0);
    expect(startResultIndex).toBeGreaterThan(committedStateIndex);
    const publicTurn = await alice.waitFor((frame) => frame.type === "observation" && frame.revision >= startRevision && frame.state.phase === "TURN_START");
    const active = publicTurn.state.currentPlayerId === created.data.selfId ? alice : bob;
    const waiting = active === alice ? bob : alice;
    const activeId = active === alice ? created.data.selfId : joined.data.selfId;
    const waitingId = active === alice ? joined.data.selfId : created.data.selfId;
    const turn = await active.waitFor((frame) => frame.type === "observation" && frame.revision >= startRevision && frame.state.currentPlayerId === activeId);
    expect(turn.legalActions, JSON.stringify(turn)).toContainEqual({ type: "draw-deck" });

    await request(active, { id: "draw", type: "action", action: { type: "draw-deck" } });
    await active.waitFor((frame) => frame.type === "observation" && frame.state.phase === "DRAWN");
    const discarded = await request(active, { id: "discard", type: "action", action: { type: "discard" } });
    const afterDiscard = await active.waitFor((frame) => frame.type === "observation" && frame.revision >= discarded.data.revision && frame.state.phase !== "DRAWN");
    if (afterDiscard.state.phase === "POWER_PENDING") {
      await request(active, { id: "skip", type: "action", action: { type: "skip" } });
    }
    await waiting.waitFor((frame) => frame.type === "observation" && frame.state.currentPlayerId === waitingId);

    waiting.child.stdin.end();
    expect(await waitForExit(waiting.child)).toBe(0);
    await active.waitFor((frame) => frame.type === "event" && frame.event.type === "forfeit" && frame.event.playerId === waitingId);

    for (const process of [alice, bob]) {
      expect(process.rawLines.length).toBeGreaterThan(0);
      expect(process.rawLines.every((line) => !line.includes("cabo> ") && !line.includes("\u001b["))).toBe(true);
      expect(process.frames.some((frame) => frame.type === "invalid-json")).toBe(false);
      expect(process.frames.every((frame) => agentFrameSchema.safeParse(frame).success)).toBe(true);
      const revisions = process.frames.filter((frame) => frame.type === "observation").map((frame) => frame.revision as number);
      expect(revisions.every((revision, index) => index === 0 || revision >= (revisions[index - 1] as number))).toBe(true);
      expect(process.errors).toEqual([]);
    }
  }, 30_000);
});

function jsonProcess(child: ChildProcessWithoutNullStreams): JsonProcess {
  children.push(child);
  const frames: any[] = [];
  const rawLines: string[] = [];
  const errors: string[] = [];
  const waiters: Array<{ predicate: (frame: any) => boolean; resolve: (frame: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      rawLines.push(line);
      let frame: any;
      try { frame = JSON.parse(line); }
      catch { frame = { type: "invalid-json", line }; }
      frames.push(frame);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter?.predicate(frame)) {
          clearTimeout(waiter.timer);
          waiters.splice(index, 1);
          waiter.resolve(frame);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  return {
    child,
    frames,
    rawLines,
    errors,
    send(frame) { child.stdin.write(`${JSON.stringify(frame)}\n`); },
    waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveFrame, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for frame. Seen: ${JSON.stringify(frames.slice(-5))}`)), 10_000);
        waiters.push({ predicate, resolve: resolveFrame, reject, timer });
      });
    },
  };
}

async function request(process: JsonProcess, frame: { id: string; [key: string]: unknown }): Promise<any> {
  process.send(frame);
  const result = await process.waitFor((candidate) => candidate.type === "result" && candidate.id === frame.id);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child exit.")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function waitForText(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolveWait, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        resolveWait();
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
  });
}
