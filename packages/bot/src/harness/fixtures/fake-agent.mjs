/**
 * 脚本化的 `cabo-agent` 替身。
 *
 * 用途：精确测试驱动的**协议处理**——事件先于观察、`STATE_UNCERTAIN` 恢复、
 * 拟人延迟的预算夹取、以及"局中绝不主动离房"。这些路径用真实服务端很难
 * 稳定触发（超时要等真的超时、不确定态要等真的超时后），所以用一个能
 * 按剧本吐帧的替身。
 *
 * 每个收到的请求类型会写到 stderr（`REQ <type>`），驱动把它转发给
 * `options.log`，测试据此断言"没有发出过 shutdown / leave"。
 *
 * 场景由 `FAKE_SCENARIO` 选择：
 *  - `happy`      正常走一步，然后到 MATCH_RESULT。
 *  - `uncertain`  第一次 action 返回 REQUEST_TIMEOUT + uncertain，
 *                 之后改状态请求一律 STATE_UNCERTAIN，直到成功 observe。
 *  - `tight`      和 happy 一样，但 deadlineAt 只留 300ms，逼出延迟夹取。
 */
const scenario = process.env.FAKE_SCENARIO ?? "happy";

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const note = (line) => process.stderr.write(`${line}\n`);

const PLAYERS = [
  { id: "self", name: "Self", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true },
  { id: "rival", name: "Rival", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false },
];

function observation(overrides = {}) {
  const state = {
    memoryMode: "assisted",
    turnDurationSeconds: 60,
    deadlineAt: 0,
    serverTime: 0,
    phase: "TURN_START",
    round: 1,
    targetScore: 100,
    currentPlayerId: "self",
    caboCallerId: null,
    drawSource: null,
    mismatchPenaltyCardPending: false,
    discardTop: null,
    deckCount: 30,
    players: PLAYERS,
    winners: [],
    roundHistory: [],
    ...(overrides.state ?? {}),
  };
  return {
    type: "observation",
    roomId: "fake-room",
    roomName: "fake",
    selfId: "self",
    revision: overrides.revision ?? 1,
    state,
    knowledge: {
      memoryMode: "assisted",
      round: state.round,
      slots: [null, null, null, null],
      opponents: [{ playerId: "rival", slots: [null, null, null, null] }],
      held: null,
      ...(overrides.knowledge ?? {}),
    },
    legalActions: overrides.legalActions ?? [{ type: "draw-deck" }],
    caboRisk: null,
  };
}

out({
  type: "ready",
  protocolVersion: 7,
  cliVersion: "0.0.0-fake",
  server: "fake",
  name: "fake",
  sessionPersistence: false,
  requestTimeoutMs: 15_000,
  capabilities: [],
});

let revision = 1;
let actionCount = 0;
let uncertain = false;
let pending = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    handle(request);
  }
});

function ok(id, data = {}) {
  revision += 1;
  out({ type: "result", id, ok: true, data: { revision, ...data } });
}

function fail(id, code, message, extra = {}) {
  out({ type: "result", id, ok: false, error: { code, message }, ...extra });
}

function handle(request) {
  note(`REQ ${request.type}`);
  const id = request.id;

  if (request.type === "create") {
    ok(id, { roomId: "fake-room", roomName: "fake", selfId: "self" });
    // 先给一帧观察把 `round` 定下来。否则下面那条事件会被
    // `resetForRound`（round 0 → 1）整轮重置吞掉——这不是驱动的 bug，
    // 而是真实时序：每轮的第一帧观察一定早于该轮的任何动作事件。
    out(observation({ revision: ++revision, state: { currentPlayerId: "rival" }, legalActions: [] }));

    if (scenario === "stall") {
      // 局中、但还没轮到我。驱动应当完全安静地等着，stop() 也不能主动离房。
      return;
    }
    // 这一对才是"事件先于观察"。
    out({ type: "event", event: { type: "action", action: "draw-deck", playerId: "rival" } });
    out(observation({
      revision: ++revision,
      state: scenario === "tight"
        ? { deadlineAt: 1_000_000 + 300, serverTime: 1_000_000 }
        : {},
    }));
    if (scenario === "stale") {
      setTimeout(() => out(observation({
        revision: ++revision,
        state: { currentPlayerId: "rival" }, legalActions: [],
      })), 50);
    }
    return;
  }

  if (request.type === "observe") {
    uncertain = false;
    ok(id, {});
    out(observation({ revision: ++revision }));
    return;
  }

  if (request.type === "action") {
    actionCount += 1;
    if (uncertain) {
      fail(id, "STATE_UNCERTAIN", "Run observe before sending another state-changing request.", { uncertain: true });
      return;
    }
    if (scenario === "uncertain" && actionCount === 1) {
      uncertain = true;
      fail(id, "REQUEST_TIMEOUT", "Request did not complete before the timeout.", { uncertain: true });
      return;
    }
    ok(id, {});
    if (actionCount >= 2 || scenario !== "uncertain") {
      out(observation({
        revision: ++revision,
        state: { phase: "MATCH_RESULT", currentPlayerId: null, winners: ["self"] },
        legalActions: [],
      }));
    }
    return;
  }

  // leave / shutdown / reconnect / ping / rooms —— 一律成功，便于断言"没发过"。
  ok(id, {});
}
