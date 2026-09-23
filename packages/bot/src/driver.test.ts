/**
 * 线上驱动单测（方案 M6 / §6.4）。
 *
 * M6 的验收门槛是**端到端零超时、零非法动作**。这条只能用真实服务端跑，
 * 所以本文件末尾有一条真·端到端测试（两个驱动 + 一个本地服务端打完整局）。
 *
 * 但"事件先于观察""STATE_UNCERTAIN 恢复""局中绝不主动离房""延迟夹进预算"
 * 这四条协议语义用真服务端很难稳定触发（超时要等真的超时、不确定态要等
 * 真的超时之后），所以前半段用一个能按剧本吐帧的 `cabo-agent` 替身
 * （`harness/fixtures/fake-agent.mjs`）精确验证。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotDriver, type BotDriverOptions } from "./driver.js";
import { PERSONAS } from "./persona.js";

const here = import.meta.dirname;
const FIXTURE = resolve(here, "harness/fixtures/fake-agent.mjs");
const ROOT = resolve(here, "../../..");

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.length = 0;
});

function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolveWait();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`等待超时：${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("M6 · 协议语义", () => {
  it("事件先于观察：事件帧被缓存并按序喂给信念层", async () => {
    process.env.FAKE_SCENARIO = "happy";
    const logs: string[] = [];
    const driver = new BotDriver({
      command: process.execPath,
      args: [FIXTURE],
      cwd: ROOT,
      create: { memoryMode: "assisted", turnDurationSeconds: 60, targetScore: 100 },
      persona: { ...PERSONAS.mnemo, decisionLatencyMs: 0 },
      samples: 40,
      seed: 3,
      jitter: false,
      log: (line) => logs.push(line),
    });
    await driver.start();
    await waitUntil(() => driver.summary.matches > 0, 15_000, "到达 MATCH_RESULT");

    // 替身在 observation 之前推了一条 `draw-deck` 公开事件；
    // `applyPublicAction` 对它的唯一影响是把回合计数 +1。
    expect(driver.currentBelief?.turnCount).toBeGreaterThanOrEqual(1);
    expect(driver.summary.actions).toBeGreaterThan(0);
    expect(driver.summary.illegalActions).toBe(0);
    expect(driver.summary.timeouts).toBe(0);
    expect(driver.summary.errors).toEqual([]);
    await driver.stop();
  }, 30_000);

  it("STATE_UNCERTAIN：先 observe 恢复，再继续出手", async () => {
    process.env.FAKE_SCENARIO = "uncertain";
    const logs: string[] = [];
    const driver = new BotDriver({
      command: process.execPath,
      args: [FIXTURE],
      cwd: ROOT,
      create: { memoryMode: "assisted", turnDurationSeconds: 60, targetScore: 100 },
      persona: { ...PERSONAS.mnemo, decisionLatencyMs: 0 },
      samples: 40,
      seed: 3,
      jitter: false,
      log: (line) => logs.push(line),
    });
    await driver.start();
    await waitUntil(() => driver.summary.actions > 0, 15_000, "动作最终提交成功");

    expect(driver.summary.timeouts).toBe(1);
    expect(driver.summary.stateUncertainRecoveries).toBeGreaterThanOrEqual(1);
    // 关键：超时没有被算成"非法动作"，恢复之后动作照常成功。
    expect(driver.summary.illegalActions).toBe(0);
    expect(driver.summary.errors).toEqual([]);
    expect(logs.some((line) => line.includes("REQ observe"))).toBe(true);
    await driver.stop();
  }, 30_000);

  it("拟人延迟被夹进决策预算，而不是硬等", async () => {
    process.env.FAKE_SCENARIO = "tight";
    const driver = new BotDriver({
      command: process.execPath,
      args: [FIXTURE],
      cwd: ROOT,
      create: { memoryMode: "assisted", turnDurationSeconds: 60, targetScore: 100 },
      // 佛系老王的拟人延迟是 2200ms，而替身只给 300ms 预算。
      persona: PERSONAS.chill,
      samples: 40,
      seed: 3,
      jitter: false,
    });
    await driver.start();
    await waitUntil(() => driver.summary.actions > 0, 15_000, "夹取后仍然出手");

    expect(driver.summary.trimmedDelays).toBeGreaterThanOrEqual(1);
    expect(driver.summary.illegalActions).toBe(0);
    await driver.stop();
  }, 30_000);

  it("局中 stop() 绝不主动离房（保留服务端重连宽限期）", async () => {
    process.env.FAKE_SCENARIO = "stall";
    const logs: string[] = [];
    const driver = new BotDriver({
      command: process.execPath,
      args: [FIXTURE],
      cwd: ROOT,
      create: { memoryMode: "assisted", turnDurationSeconds: 60, targetScore: 100 },
      persona: { ...PERSONAS.mnemo, decisionLatencyMs: 0 },
      samples: 40,
      seed: 3,
      jitter: false,
      log: (line) => logs.push(line),
    });
    await driver.start();
    // 局中、但没轮到我：驱动应该安静等着，不发任何动作。
    // 注意必须等**观察**而不是等 create 的 result —— `inMatch` 是在观察里定的，
    // 而替身写 stderr 早于写 result，只等 stderr 会在 `inMatch` 还是 false 时
    // 就去 stop()，于是走成"优雅退出"，测试反而漏判。
    await waitUntil(() => driver.observation?.state.phase === "TURN_START", 10_000, "进入对局");
    expect(driver.summary.actions).toBe(0);
    expect(driver.summary.matches).toBe(0);

    await driver.stop();
    // `leave` / `shutdown` 都会被服务端判弃权，所以一次都不能出现。
    expect(logs.some((line) => line.includes("REQ shutdown"))).toBe(false);
    expect(logs.some((line) => line.includes("REQ leave"))).toBe(false);
  }, 30_000);
});

describe("M6 · 端到端（真实服务端）", () => {
  it("两个驱动打完一整局：零非法动作、零超时、零错误", async () => {
    const tsx = resolve(ROOT, "node_modules/.bin/tsx");
    const port = await freePort();
    const server = spawn(tsx, [resolve(ROOT, "packages/server/src/main.ts")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
    });
    children.push(server);
    await waitForText(server, "Cabo server listening");

    const agentMain = resolve(ROOT, "packages/cli/src/agent-main.ts");
    const base = (name: string): Partial<BotDriverOptions> => ({
      command: tsx,
      args: [agentMain, "--server", `http://localhost:${port}`, "--name", name],
      cwd: ROOT,
      // 拟人延迟置零：这一条验的是协议正确性，不是节奏。
      persona: { ...PERSONAS.mnemo, decisionLatencyMs: 0 },
      samples: 60,
      seed: 11,
      jitter: false,
    });

    const host = new BotDriver({
      ...base("BotHost"),
      // 目标分调低，让整局在 2 轮左右结束，测试才跑得动。
      create: { memoryMode: "assisted", turnDurationSeconds: 60, targetScore: 20, visibility: "public", roomName: "bot-e2e" },
    } as BotDriverOptions);
    await host.start();
    await waitUntil(() => host.observation !== null, 15_000, "拿到首个 observation");
    const roomId = host.observation?.roomId;
    expect(roomId).toBeTruthy();

    const guest = new BotDriver({ ...base("BotGuest"), join: { roomId: roomId as string } } as BotDriverOptions);
    await guest.start();

    // 房主会在第二名玩家到位后自动 start（`decide` 在 LOBBY 返回 `start`）。
    await waitUntil(
      () => host.summary.matches > 0 && guest.summary.matches > 0,
      120_000,
      "双方都抵达 MATCH_RESULT",
    );

    for (const driver of [host, guest]) {
      expect(driver.summary.illegalActions).toBe(0);
      expect(driver.summary.timeouts).toBe(0);
      expect(driver.summary.errors).toEqual([]);
      expect(driver.summary.actions).toBeGreaterThan(0);
      await driver.stop({ leave: true });
    }
  }, 180_000);
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function waitForText(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolveWait, reject) => {
    let output = "";
    // tsx 冷启动要现编译一遍，机器忙的时候 20 秒不够。
    const timer = setTimeout(() => reject(new Error(`服务端没起来：${output}`)), 90_000);
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
