# Cabo Agent JSONL 协议

`cabo-agent` 是供任意语言通过子进程控制 Cabo 玩家使用的稳定机器接口。协议版本为 `1`。

## 启动

```bash
pnpm dev:agent -- --name Bot-A
```

构建后也可以直接运行 `cabo-agent`。支持的参数：

- `--server URL`：服务端地址，默认 `https://cabo-api.human404.link`。
- `--name NAME`：玩家名，最长 20 个字符。
- `--session-file PATH`：可选的独立会话文件。未提供时不写磁盘，`reconnect` 请求不可用。
- `--request-timeout-ms N`：请求超时，范围 100–300000，默认 15000 毫秒。
- `--help`：输出人类可读帮助并退出。
- `--version`：输出 CLI 包版本并退出。
- `--print-schema`：输出由运行时 Zod 定义生成的 JSON Schema 并退出。

stdout 只包含 JSONL 协议帧。stderr 只包含不属于协议的诊断信息。调用方不得依赖 stderr 文案。

进程启动后的第一帧为：

```json
{"type":"ready","protocolVersion":1,"cliVersion":"0.1.0","server":"https://cabo-api.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
```

## 请求与结果

stdin 的每个非空行必须是一个 JSON 对象，并带有用于关联结果的非空字符串 `id`。请求按输入顺序串行执行；一个请求完成后才会处理下一行。推送的 `event` 和 `observation` 可以出现在请求与其 `result` 之间。

支持以下请求：

```json
{"id":"1","type":"rooms"}
{"id":"2","type":"create","visibility":"public","targetScore":100}
{"id":"3","type":"create","visibility":"private","targetScore":100,"password":"123456"}
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
- `draw-discard`，带 `position`
- `replace`，带 `position`
- `discard`
- `peek-self`，带 `position`
- `peek-other`，带 `targetPlayerId` 和 `position`
- `swap`，带 `targetPlayerId` 和 `position`
- `skip`
- `cabo`

成功与失败结果分别为：

```json
{"type":"result","id":"7","ok":true,"data":{"revision":12}}
{"type":"result","id":"7","ok":false,"error":{"code":"NOT_YOUR_TURN","message":"It is not your turn."},"revision":11}
```

无法解析 JSON 时，结果的 `id` 为 `null`；如果能从无效请求中读取字符串 ID，则原样返回该 ID。单条错误不会结束进程。启动参数等不可恢复错误使用 `fatal` 帧并以非零状态退出。

`describe` 返回协议/CLI 版本、支持的请求、输出帧、动作类型、运行默认值和 Schema 获取命令。`ping` 不改变状态，可用于查询当前连接、房间、自身 ID、revision 和 phase。

所有请求受 `--request-timeout-ms` 限制。超时返回 `REQUEST_TIMEOUT` 和 `uncertain: true`；之后新的 `create`、`join`、`reconnect` 和 `action` 会返回 `STATE_UNCERTAIN`。调用方必须先成功执行 `observe`，或使用始终可用的 `ping`、`leave`、`shutdown`。

## Observation

连接房间后，每次公共状态或私有知识发生变化都会推送 observation。`observe` 请求也会在结果的 `data` 中返回相同结构：

```json
{
  "type": "observation",
  "roomId": "abc123",
  "selfId": "session-id",
  "revision": 12,
  "state": {
    "phase": "TURN_START",
    "round": 1,
    "targetScore": 100,
    "currentPlayerId": "session-id",
    "caboCallerId": null,
    "discardTop": {"label":"6♥","rank":6},
    "deckCount": 43,
    "players": [],
    "winners": []
  },
  "knowledge": {
    "round": 1,
    "slots": [{"label":"4♣","rank":4},null,null,null],
    "held": null
  },
  "legalActions": [
    {"type":"draw-deck"},
    {"type":"draw-discard","position":1},
    {"type":"cabo"}
  ]
}
```

`players` 始终按座位排序。没有当前玩家、Cabo 宣告者或弃牌时，对应值为 `null`。`legalActions` 是完整的具体动作枚举，包含所有合法位置及目标组合。

公共状态的 `revision` 单调递增。成功动作的 `result` 只会在客户端已经观察到回执中的 revision 后输出，因此收到成功结果后即可安全提交下一动作。私有知识可能在公共 revision 不变时产生新的 observation。

## Event

服务端游戏事件、私密揭示和连接变化使用结构化事件帧：

```json
{"type":"event","event":{"type":"turn","playerId":"...","finalTurn":false}}
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
{"type":"ready","protocolVersion":1,"cliVersion":"0.1.0","server":"https://cabo-api.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
{"id":"1","type":"create","visibility":"public","targetScore":100}
{"type":"observation","roomId":"abc123","selfId":"a","revision":1,"state":{"phase":"LOBBY"},"knowledge":{"round":0,"slots":[null,null,null,null],"held":null},"legalActions":[]}
{"type":"result","id":"1","ok":true,"data":{"roomId":"abc123","selfId":"a"}}
{"id":"2","type":"action","action":{"type":"start"}}
{"type":"observation","roomId":"abc123","selfId":"a","revision":3,"state":{"phase":"TURN_START"},"knowledge":{"round":1,"slots":[null,null,null,null],"held":null},"legalActions":[{"type":"draw-deck"}]}
{"type":"result","id":"2","ok":true,"data":{"revision":3}}
```

示例为便于阅读省略了部分 state 字段；实际 observation 始终包含完整结构。
