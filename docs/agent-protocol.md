# Cabo Agent JSONL 协议

`cabo-agent` 是供任意语言通过子进程控制 Cabo 玩家使用的稳定机器接口。协议版本 `7`，加入记忆模式、服务端截止时间、Cabo 风险和双位置交换；不兼容旧版命令。

## v7 房间与计时契约

建房必须显式传入 `memoryMode: "classic" | "assisted"` 和 `turnDurationSeconds: 0 | 30 | 60 | 90`。旧版建房和单位置 `swap` 命令均被拒绝。交换动作形如 `{"type":"swap","targetPlayerId":"other","ownPosition":1,"targetPosition":3}`。

公开房列表和 observation.state 包含上述配置以及 `deadlineAt`、`serverTime`，均为毫秒；`deadlineAt = 0` 表示无截止时间。用服务端时间差安排动作，不要自行判定回合结束。有效游戏步骤重置时限；超时通过正常动作广播完成安全收尾。局末全员就绪或 20 秒后继续。

经典模式的 knowledge 不保存任何历史牌位，只保留尚未解决的 `held`。私密 reveal 会输出一次，并携带 `memoryMode`、`round`、`ownerId`；Agent 可自行记忆这些事件。辅助模式知识由服务端恢复，不应拿本地缓存覆盖服务端快照。

可宣告 Cabo 时 observation.caboRisk 为 `{ strictLowest: true, tieFails: true, failurePenalty: 5, knownScore, unknownCount }`，否则为 `null`。经典模式 `knownScore = null`，`unknownCount` 为公开手牌张数；辅助模式给出已知小计和未知张数，未知数为零时小计即确切总分。

## 启动

```bash
pnpm dev:agent -- --name Bot-A
```

构建后也可以直接运行 `cabo-agent`。支持的参数：

- `--server URL`：服务端地址，默认 `https://cabo-api.human404.link`。
- `--name NAME`：玩家名，最长 20 个字符。
- `--session-file PATH`：可选的独立会话文件。未提供时不写磁盘，`reconnect` 请求不可用。
- `--request-timeout-ms N`：请求超时，范围 100–300000，默认 15000 毫秒。
- `-h`、`--help`：输出人类可读帮助并退出。
- `-v`、`--version`：输出 CLI 包版本并退出。
- `--print-schema`：输出由运行时 Zod 定义生成的 JSON Schema 并退出。

stdout 只包含 JSONL 协议帧。stderr 只包含不属于协议的诊断信息。调用方不得依赖 stderr 文案。

进程启动后的第一帧为：

```json
{"type":"ready","protocolVersion":7,"cliVersion":"0.1.0","server":"https://cabo-api.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
```

## 请求与结果

stdin 的每个非空行必须是一个 JSON 对象，并带有用于关联结果的非空字符串 `id`。请求按输入顺序串行执行；一个请求完成后才会处理下一行。推送的 `event` 和 `observation` 可以出现在请求与其 `result` 之间。

支持以下请求：

```json
{"id":"1","type":"rooms"}
{"id":"2","type":"create","memoryMode":"classic","turnDurationSeconds":60,"visibility":"public","targetScore":100,"roomName":"Friday night"}
{"id":"3","type":"create","memoryMode":"classic","turnDurationSeconds":60,"visibility":"private","targetScore":100,"roomName":"Friends","password":"123456"}
{"id":"4","type":"join","roomId":"ROOM_ID","password":"123456"}
{"id":"5","type":"reconnect"}
{"id":"6","type":"observe"}
{"id":"6a","type":"describe"}
{"id":"6b","type":"ping"}
{"id":"7","type":"action","action":{"type":"draw-deck"}}
{"id":"8","type":"leave"}
{"id":"9","type":"shutdown"}
```

`action` 的动作对象与服务端 `ClientCommand` 一致，包括：

- `start`
- `draw-deck`
- `draw-discard`，不带位置；拿牌后再发送 `replace`
- `replace`，带 `positions`（1–4 个位置）和 `replacementPosition`
- `resolve-mismatch`，带 `drawnPlacement`，有罚牌时还带 `penaltyPlacement`
- `discard`
- `peek-self`，带 `position`
- `peek-other`，带 `targetPlayerId` 和 `position`
- `swap`，带 `targetPlayerId`、`ownPosition` 和 `targetPosition`
- `skip`
- `cabo`
- `ready-next-round`（仅 `ROUND_RESULT`；所有未弃权玩家确认后开始下一回合）

成功与失败结果分别为：

```json
{"type":"result","id":"7","ok":true,"data":{"revision":12}}
{"type":"result","id":"7","ok":false,"error":{"code":"NOT_YOUR_TURN","message":"It is not your turn."},"revision":11}
```

无法解析 JSON 时，结果的 `id` 为 `null`；如果能从无效请求中读取字符串 ID，则原样返回该 ID。单条错误不会结束进程。启动参数等不可恢复错误使用 `fatal` 帧并以非零状态退出。

`roomName` 可省略或留空，此时服务端生成 `[玩家名]'s room`；自定义名称会去除首尾空白，最多 40 个 Unicode 字符，允许重名。`rooms` 返回房间名、房间 ID、阶段、人数上限以及 `isFull`、`isStarted`、`canJoin`。加入始终使用 `roomId`。

`describe` 返回协议/CLI 版本、支持的请求、输出帧、动作类型、运行默认值和 Schema 获取命令。`ping` 不改变状态，可用于查询当前连接、房间名、房间 ID、自身 ID、revision 和 phase。

所有请求受 `--request-timeout-ms` 限制。超时返回 `REQUEST_TIMEOUT` 和 `uncertain: true`；之后新的 `create`、`join`、`reconnect` 和 `action` 会返回 `STATE_UNCERTAIN`。调用方必须先成功执行 `observe`，或使用始终可用的 `ping`、`leave`、`shutdown`。

## Observation

连接房间后，每次公共状态或私有知识发生变化都会推送 observation。`observe` 请求也会在结果的 `data` 中返回相同结构：

```json
{
  "type": "observation",
  "roomId": "abc123",
  "roomName": "Friday night",
  "selfId": "session-id",
  "revision": 12,
  "state": {
    "memoryMode": "assisted",
    "turnDurationSeconds": 60,
    "deadlineAt": 1800000060000,
    "serverTime": 1800000000000,
    "phase": "TURN_START",
    "round": 1,
    "targetScore": 100,
    "currentPlayerId": "session-id",
    "caboCallerId": null,
    "drawSource": null,
    "mismatchPenaltyCardPending": false,
    "discardTop": {"label":"6♥","rank":6},
    "deckCount": 43,
    "players": [],
    "winners": [],
    "roundHistory": []
  },
  "knowledge": {
    "memoryMode": "assisted",
    "round": 1,
    "slots": [{"label":"4♣","rank":4},null,null,null],
    "opponents": [{"playerId":"opponent-id","slots":[null,{"label":"9♥","rank":9},null,null]}],
    "held": null
  },
  "caboRisk": {"strictLowest":true,"tieFails":true,"failurePenalty":5,"knownScore":4,"unknownCount":3},
  "legalActions": [
    {"type":"draw-deck"},
    {"type":"draw-discard"},
    {"type":"cabo"}
  ]
}
```

`players` 和 `knowledge.opponents` 始终按座位排序；每个玩家的 `nextRoundReady` 表示其是否已确认继续。`roundHistory` 按轮次包含所有已结束回合的玩家加分、累计分、手牌分与完整手牌；它属于房间权威状态，因此刷新或在座位保留期内重连后仍然可用。没有当前玩家、Cabo 宣告者、抽牌来源或弃牌时，对应值为 `null`。知识位置数组随手牌数量动态变化，只有该 Agent 合法看过并仍能追踪的牌为非空值。`replace` 的合法动作使用选择描述符（`selectablePositions`、`minSelections`、`maxSelections`），避免枚举所有组合；其余动作仍给出具体合法参数。

公共状态的 `revision` 单调递增。成功动作的 `result` 只会在客户端已经观察到回执中的 revision 后输出，因此收到成功结果后即可安全提交下一动作。私有知识可能在公共 revision 不变时产生新的 observation。

## Event

服务端游戏事件、私密揭示和连接变化使用结构化事件帧：

```json
{"type":"event","event":{"type":"turn","playerId":"...","finalTurn":false}}
{"type":"event","event":{"type":"action","action":"peek-other","playerId":"...","targetPlayerId":"...","position":2}}
{"type":"event","event":{"type":"private-reveal","reason":"draw","card":{"id":"...","rank":8,"label":"8♠"}}}
{"type":"event","event":{"type":"connection-dropped"}}
```

Agent 应以 observation 作为决策状态，以 event 作为增量通知和日志来源。

## 进程生命周期

- `leave` 主动离开房间并清理显式 session 文件，但进程继续接收请求。
- `shutdown` 等待当前请求、主动离房、返回成功 result，然后退出 0。
- stdin EOF 会在处理完已接收请求后执行相同的优雅离房。
- `SIGINT` 和 `SIGTERM` 优雅离房后分别退出 130 和 143。
- 主动离房在进行中的游戏里会被视为弃权；需要重连宽限期时不能使用上述主动退出方式。

## 完整交互片段

```jsonl
{"type":"ready","protocolVersion":7,"cliVersion":"0.1.0","server":"https://cabo-api.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
{"id":"1","type":"create","memoryMode":"classic","turnDurationSeconds":60,"visibility":"public","targetScore":100,"roomName":"Bots' room"}
{"type":"observation","roomId":"abc123","roomName":"Bots' room","selfId":"a","revision":1,"state":{"phase":"LOBBY"},"knowledge":{"round":0,"slots":[null,null,null,null],"opponents":[],"held":null},"legalActions":[]}
{"type":"result","id":"1","ok":true,"data":{"roomId":"abc123","roomName":"Bots' room","selfId":"a"}}
{"id":"2","type":"action","action":{"type":"start"}}
{"type":"observation","roomId":"abc123","roomName":"Bots' room","selfId":"a","revision":3,"state":{"phase":"TURN_START"},"knowledge":{"round":1,"slots":[null,null,null,null],"opponents":[],"held":null},"legalActions":[{"type":"draw-deck"}]}
{"type":"result","id":"2","ok":true,"data":{"revision":3}}
```

示例为便于阅读省略了部分 state 字段；实际 observation 始终包含完整结构。
