/**
 * 线上驱动（方案 M6）：把决策核心接到 `cabo-agent` 的 JSONL 协议上。
 *
 * 这一层只负责**协议、计时、恢复**三件事，不含任何决策逻辑——决策全部来自
 * `belief / evaluate / plans / policy / persona`。守卫测试（§6.5）强制它不许
 * import 引擎、harness、服务端或 client-core，所以它能看到的东西和线上真人
 * 客户端完全一样：`observation` + `event` 帧。
 *
 * 三个必须处理的线上语义（方案 §6.4）：
 *
 *  1. **事件先于观察**。服务端 `CaboRoom.applyGameCommand` 的顺序是
 *     `broadcast("event", publicAction)` → `dispatch(events)` → `sendAllKnowledge()`
 *     → `syncFromEngine()`。所以事件帧一定先到。驱动必须把事件**缓存**起来，
 *     等下一帧 observation 到达时先喂事件、再喂快照。顺序反了信念层会算错
 *     位置（`replace` 会把被选中的牌推进弃牌堆并平移位置）。
 *
 *  2. **截止时间用服务端时间差**。`deadlineAt - serverTime` 才是服务端视角的
 *     剩余时间；本地已经流逝的时间要自己扣。协议明确要求"不要自行判定回合结束"，
 *     所以超时兜底交给服务端（它会用 `turn-timeout` 事件代打），驱动只负责
 *     在预算内把动作发出去。
 *
 *  3. **绝不主动离房**。`leave` / `shutdown` / stdin EOF / SIGINT / SIGTERM 都会
 *     被服务端判定为弃权。需要重连宽限期时只能让连接**异常断开**（进程被杀）。
 *     所以 `stop()` 默认走 `SIGKILL`；只有明确要求"这局打完了，可以走"时才优雅退出。
 *
 * 另外处理 `STATE_UNCERTAIN`：请求超时后 agent 会拒绝一切改状态请求，必须先
 * 成功 `observe` 一次才能继续。驱动把它做成自动恢复（`observe` → 记录，等新帧重来）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentAction,
  AgentObservation,
  MemoryMode,
  PrivateRevealMessage,
  PublicActionEvent,
} from "@cabo-game/shared";
import { applyObservation, applyPrivateReveal, applyPublicAction, createBelief, type Belief } from "./belief.js";
import { decisionDelay } from "./plans.js";
import { decide, moodFromHistory } from "./policy.js";
import { getPersona, jitterPersona, type BotPersona, type PersonaId } from "./persona.js";

export type TurnDuration = 0 | 30 | 60 | 90;

export interface BotDriverOptions {
  /** `cabo-agent` 可执行文件。默认 `tsx`（配合 `args` 走仓库源码）。 */
  command?: string;
  args?: string[];
  cwd?: string;
  server?: string;
  name?: string;
  /** 会话文件。提供后进程意外退出可以 `reconnect` 拿回座位。 */
  sessionFile?: string;
  maxReconnects?: number;
  onFailure?: (error: Error) => void;
  onChildSpawn?: (pid: number) => void;
  onChildExit?: (pid: number) => void;
  requestTimeoutMs?: number;

  persona: PersonaId | BotPersona;
  samples?: number;
  /** 开局抖动，避免固定参数被玩家摸清。 */
  jitter?: boolean;
  seed?: number;

  /** 建房（与 `join` 二选一）。 */
  create?: {
    memoryMode: MemoryMode;
    turnDurationSeconds: TurnDuration;
    visibility?: "public" | "private";
    targetScore?: number;
    roomName?: string;
    password?: string;
  };
  /** 加入已有房间（与 `create` 二选一）。 */
  join?: { roomId: string; password?: string; botToken?: string };
  /** Managed bots wait for a human host to start the lobby. */
  managed?: boolean;

  /** 安全边际：固定扣掉的毫秒数。默认 400。 */
  safetyMarginMs?: number;
  /** 安全边际：按剩余时间比例扣掉的部分。默认 0.3。 */
  safetyRatio?: number;
  /** 拟人延迟最多占预算的比例，超过就砍掉延迟直接出手。默认 0.5。 */
  delayBudgetRatio?: number;

  onObservation?: (observation: AgentObservation) => void;
  onAction?: (action: AgentAction, observation: AgentObservation) => void;
  log?: (line: string) => void;
}

export interface DriverSummary {
  /** 完成的整局数（看到几次 `MATCH_RESULT`）。 */
  matches: number;
  /** 成功提交的动作数。 */
  actions: number;
  /** 服务端拒绝的动作数。> 0 即验收失败。 */
  illegalActions: number;
  /** `REQUEST_TIMEOUT` 次数。> 0 即验收失败。 */
  timeouts: number;
  /** `STATE_UNCERTAIN` 自动恢复次数。 */
  stateUncertainRecoveries: number;
  /** 因为进程挂了而重连的次数。 */
  reconnects: number;
  /** 拟人延迟被预算砍掉的次数（不是错误，是节奏统计）。 */
  trimmedDelays: number;
  /** 到达过 `MATCH_RESULT`。 */
  finished: boolean;
  errors: string[];
}

interface Frame {
  type: string;
  [key: string]: unknown;
}

interface PendingRequest {
  id: string;
  frame: Record<string, unknown>;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
}

const DEFAULT_SAFETY_MARGIN_MS = 400;
const DEFAULT_SAFETY_RATIO = 0.3;
const DEFAULT_DELAY_BUDGET_RATIO = 0.5;

export class BotDriver {
  readonly persona: BotPersona;
  readonly summary: DriverSummary = {
    matches: 0,
    actions: 0,
    illegalActions: 0,
    timeouts: 0,
    stateUncertainRecoveries: 0,
    reconnects: 0,
    trimmedDelays: 0,
    finished: false,
    errors: [],
  };

  private readonly options: BotDriverOptions;
  private readonly rng: () => number;
  private jittered: BotPersona | null = null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private ready: (() => void) | null = null;
  private exited: (() => void) | null = null;
  private seq = 0;

  private readonly queue: PendingRequest[] = [];
  private inFlight: PendingRequest | null = null;

  /** 事件缓存：`event` 帧先到，等 observation 到达再按序喂给信念层。 */
  private readonly pendingEvents: Array<PublicActionEvent | PrivateRevealMessage> = [];

  private belief: Belief | null = null;
  private latest: AgentObservation | null = null;
  private latestReceivedAt = 0;
  private roomId: string | null = null;
  /** 是否在一局进行中的房间里（决定能不能主动离房）。 */
  private inMatch = false;
  private stopping = false;

  /** 决策循环的互斥与唤醒位。 */
  private acting = false;
  private wake = false;

  constructor(options: BotDriverOptions) {
    if (!options.create && !options.join) throw new Error("BotDriver 需要 create 或 join 之一。");
    this.options = options;
    this.persona = typeof options.persona === "string" ? getPersona(options.persona) : options.persona;
    this.rng = mulberry32(options.seed ?? 1);
  }

  get observation(): AgentObservation | null {
    return this.latest;
  }

  get currentBelief(): Belief | null {
    return this.belief;
  }

  /** 启动子进程并完成建房 / 加入。返回后就进入自动对局循环。 */
  async start(): Promise<void> {
    this.spawnChild();
    await this.waitForReady();
    if (this.options.create) {
      await this.request({ type: "create", ...this.options.create });
    } else if (this.options.join) {
      await this.request({ type: "join", ...this.options.join });
    }
  }

  /**
   * 停止。
   *
   * `leave` 默认为 `false`——局中主动离房会被判弃权，而我们需要的是
   * "连接断了、服务端留 60 秒宽限期"。所以默认直接 `SIGKILL` 子进程，
   * 让 socket 异常关闭。只有确认这局已经结束（或压根没进局）才优雅退出。
   */
  async stop(options: { leave?: boolean } = {}): Promise<void> {
    this.stopping = true;
    if (this.child === null) return;
    if (options.leave ?? !this.inMatch) {
      try {
        await this.request({ type: "shutdown" });
      } catch {
        // 已经断开就无所谓了。
      }
      await this.waitForExit(2000);
    }
    if (this.child && this.child.exitCode === null) {
      // 异常断开：服务端按掉线处理，保留重连宽限期。
      this.child.kill("SIGKILL");
      await this.waitForExit(2000);
    }
    this.child = null;
    const stalled: PendingRequest[] = [...this.queue.splice(0)];
    const inFlight = this.inFlight;
    this.inFlight = null;
    if (inFlight) stalled.push(inFlight);
    for (const request of stalled) request.reject(new Error("driver stopped"));
  }

  // ---------------------------------------------------------------- 子进程

  private spawnChild(): void {
    const child = spawn(this.options.command ?? "tsx", this.options.args ?? [], {
      cwd: this.options.cwd ?? process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) this.options.onChildSpawn?.(child.pid);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // stderr 只用于诊断，不是协议帧。
    child.stderr.on("data", (chunk: string) => this.options.log?.(`[stderr] ${String(chunk).trimEnd()}`));
    child.on("exit", () => {
      if (child.pid) this.options.onChildExit?.(child.pid);
      this.exited?.();
      this.exited = null;
      if (!this.stopping) void this.handleUnexpectedExit();
    });
    this.child = child;
  }

  private waitForReady(): Promise<void> {
    if (this.child === null) return Promise.reject(new Error("driver stopped"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cabo-agent 没有发出 ready 帧")), 15_000);
      this.ready = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.exited = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** 子进程意外退出：有会话文件就重连，否则记录错误。 */
  private async handleUnexpectedExit(): Promise<void> {
    if (this.stopping) return;
    if (!this.options.sessionFile || this.summary.reconnects >= (this.options.maxReconnects ?? Number.POSITIVE_INFINITY)) {
      const error = new Error("cabo-agent exited and cannot reconnect");
      this.summary.errors.push(error.message);
      this.options.onFailure?.(error);
      return;
    }
    try {
      this.spawnChild();
      await this.waitForReady();
      await this.request({ type: "reconnect" });
      await this.request({ type: "observe" });
      this.summary.reconnects += 1;
      this.options.log?.("已重连并恢复座位");
    } catch (error) {
      this.summary.errors.push(`重连失败：${messageOf(error)}`);
      this.options.onFailure?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---------------------------------------------------------------- 帧处理

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        this.summary.errors.push(`无法解析的帧：${line.slice(0, 200)}`);
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    switch (frame.type) {
      case "ready":
        this.ready?.();
        this.ready = null;
        return;
      case "result":
        this.handleResult(frame);
        return;
      case "event":
        this.handleEvent(frame);
        return;
      case "observation":
        this.handleObservation(frame as unknown as AgentObservation);
        return;
      case "fatal":
        this.summary.errors.push(`fatal：${JSON.stringify(frame)}`);
        return;
      default:
        return;
    }
  }

  private handleResult(frame: Frame): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (id === null) return;
    const current = this.inFlight;
    if (current && current.id === id) {
      this.inFlight = null;
      if (errorCode(frame) === "REQUEST_TIMEOUT") this.summary.timeouts += 1;
      current.resolve(frame);
      this.pump();
    }
  }

  private handleEvent(frame: Frame): void {
    const event = frame.event;
    if (!isRecord(event)) return;
    if (event.type === "private-reveal") {
      this.pendingEvents.push(event as unknown as PrivateRevealMessage);
      return;
    }
    if (event.type === "action") this.pendingEvents.push(event as unknown as PublicActionEvent);
  }

  private handleObservation(observation: AgentObservation): void {
    this.latest = observation;
    this.latestReceivedAt = Date.now();
    this.options.onObservation?.(observation);

    if (observation.roomId !== this.roomId) {
      // 换了房间：信念重来。
      this.roomId = observation.roomId;
      this.belief = null;
      this.pendingEvents.length = 0;
    }
    const belief = this.ensureBelief(observation);
    // 事件先于观察——与 `CaboRoom.applyGameCommand` 的发送顺序一致。
    this.flushEvents(belief);
    applyObservation(belief, observation);

    if (observation.state.phase === "MATCH_RESULT") {
      this.inMatch = false;
      this.summary.matches += 1;
      this.summary.finished = true;
    } else if (observation.state.phase !== "LOBBY") {
      this.inMatch = true;
    }

    this.kick();
  }

  private ensureBelief(observation: AgentObservation): Belief {
    if (this.belief && this.belief.selfId === observation.selfId) return this.belief;
    this.belief = createBelief(observation.selfId, observation.state.memoryMode);
    return this.belief;
  }

  private flushEvents(belief: Belief): void {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents.splice(0);
    for (const event of events) {
      if ((event as { type: string }).type === "private-reveal") {
        applyPrivateReveal(belief, event as PrivateRevealMessage);
      } else {
        applyPublicAction(belief, event as PublicActionEvent);
      }
    }
  }

  // ---------------------------------------------------------------- 决策循环

  private kick(): void {
    if (this.acting) {
      this.wake = true;
      return;
    }
    void this.runActor();
  }

  /**
   * 单线程决策循环。
   *
   * `decide` 是同步的，但拟人延迟是异步的，延迟期间可能来新帧。所以循环在
   * 延迟后复核 `this.latest`：变了就丢掉旧判断重来。`wake` 位保证延迟/提交
   * 期间到达的新帧不会被漏掉（这是最容易写出"卡住不动"的地方）。
   */
  private async runActor(): Promise<void> {
    this.acting = true;
    try {
      do {
        this.wake = false;
        const current = this.latest;
        if (!current || this.stopping || !this.shouldAct(current)) return;
        const belief = this.belief;
        if (!belief) return;

        const action = decide({
          belief,
          observation: current,
          persona: this.personaFor(),
          rng: this.rng,
          mood: moodFromHistory(current, current.selfId),
          samples: this.options.samples ?? 300,
        });
        if (!action) return;

        await this.respectBudget(current);
        if (this.latest !== current) {
          // 延迟期间局面变了：重来一轮。
          this.wake = true;
          continue;
        }
        await this.submit(action, current);
      } while (this.wake);
    } catch (error) {
      this.summary.errors.push(`决策失败：${messageOf(error)}`);
    } finally {
      this.acting = false;
      // 兜底：提交动作期间刚好来了新帧。
      if (this.wake) {
        this.wake = false;
        this.kick();
      }
    }
  }

  /** 是否该出手。LOBBY / ROUND_RESULT 不属于任何人的回合，但要响应 `start` / 就绪。 */
  private shouldAct(observation: AgentObservation): boolean {
    if (observation.legalActions.length === 0) return false;
    const phase = observation.state.phase;
    if (phase === "LOBBY" && this.options.managed) return false;
    if (phase === "LOBBY" || phase === "ROUND_RESULT") return true;
    return observation.state.currentPlayerId === observation.selfId;
  }

  private personaFor(): BotPersona {
    if (!this.options.jitter) return this.persona;
    // 整个进程生命周期抖一次，保证同一局内参数稳定（否则对手能看出抖动）。
    if (!this.jittered) this.jittered = jitterPersona(this.persona, this.rng);
    return this.jittered;
  }

  /**
   * 拟人延迟，但必须在预算内。
   *
   * 协议要求"用服务端时间差安排动作，不要自行判定回合结束"。所以这里只做
   * 一件事：把 `decisionLatencyMs` 夹进剩余预算，超了就砍掉延迟立即出手。
   * 真到了截止时间还没出手，由服务端的 `turn-timeout` 兜底代打——驱动不越权。
   */
  private async respectBudget(observation: AgentObservation): Promise<void> {
    const delay = decisionDelay(this.personaFor(), this.rng);
    if (delay <= 0) return;
    const budget = this.budgetMs(observation);
    if (!Number.isFinite(budget)) {
      await sleep(delay);
      return;
    }
    const cap = budget * (this.options.delayBudgetRatio ?? DEFAULT_DELAY_BUDGET_RATIO);
    if (delay > cap) {
      this.summary.trimmedDelays += 1;
      if (cap <= 0) return;
      await sleep(cap);
      return;
    }
    await sleep(delay);
  }

  /** 服务端视角的剩余毫秒数，再扣掉安全边际。 */
  private budgetMs(observation: AgentObservation): number {
    const { deadlineAt, serverTime } = observation.state;
    if (!deadlineAt) return Number.POSITIVE_INFINITY;
    const elapsedLocal = Date.now() - this.latestReceivedAt;
    const remaining = deadlineAt - serverTime - elapsedLocal;
    const margin = (this.options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS)
      + remaining * (this.options.safetyRatio ?? DEFAULT_SAFETY_RATIO);
    return remaining - margin;
  }

  private async submit(action: AgentAction, observation: AgentObservation): Promise<void> {
    const result = await this.request({ type: "action", action }, { tolerateFailure: true });
    if (result.ok === true) {
      this.summary.actions += 1;
      this.options.onAction?.(action, observation);
      return;
    }
    const code = errorCode(result);
    if (code === "STATE_UNCERTAIN" || code === "REQUEST_TIMEOUT") {
      // 超时之后 agent 会锁住改状态请求；成功 observe 一次即可解锁。
      //
      // 超时**不算非法动作**：它只说明"结果没在超时前提交"，动作本身可能是
      // 合法的、甚至可能已经生效了。验收门槛里的"零超时"由 `summary.timeouts`
      // 单独统计，不能和"服务端拒绝了这个动作"混在一起。
      this.summary.stateUncertainRecoveries += 1;
      this.options.log?.(`${code}：先 observe 恢复`);
      await this.request({ type: "observe" });
      this.wake = true;
      return;
    }
    this.summary.illegalActions += 1;
    this.summary.errors.push(`动作被拒（${code ?? "未知"}）：${JSON.stringify(action)}`);
  }

  // ---------------------------------------------------------------- 请求队列

  /**
   * 串行请求队列。
   *
   * 协议规定"请求按输入顺序串行执行；一个请求完成后才会处理下一行"，
   * 所以驱动也串行发，避免把 in-flight 状态搞乱。`action` 用
   * `tolerateFailure` 拿到失败帧自己判类型（超时 / 非法 / 状态不确定要分开处理）。
   */
  private request(frame: Record<string, unknown>, options: { tolerateFailure?: boolean } = {}): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      this.queue.push({
        id: "",
        frame,
        resolve: (result) => {
          if (result.ok !== true && !options.tolerateFailure) {
            reject(new Error(`${String(frame.type)} 失败：${errorCode(result) ?? JSON.stringify(result)}`));
            return;
          }
          resolve(result);
        },
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const next = this.queue.shift() as PendingRequest;
    next.id = `r${(this.seq += 1)}`;
    this.inFlight = next;
    child.stdin.write(`${JSON.stringify({ id: next.id, ...next.frame })}\n`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorCode(frame: Frame): string | null {
  const error = frame.error;
  if (!isRecord(error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可复现的伪随机源（与自对弈 harness 同款）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
