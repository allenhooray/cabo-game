# Cabo Agent CLI

`cabo-agent` exposes one Cabo player as a language-neutral JSONL subprocess. It is designed for supervisors and bots written in Python, Go, Rust, Node.js, or any runtime that can manage a child process.

## Install

```bash
npm install --global @cabo-game/cli
```

This installs both the interactive `cabo` command and the JSONL-based `cabo-agent` command.

## Discover the interface

```bash
cabo-agent --help
cabo-agent --version
cabo-agent --print-schema
```

`--print-schema` emits the JSON Schema generated from the same Zod definitions used by the running CLI. These discovery commands exit immediately and do not connect to a server.

## Start an Agent

```bash
cabo-agent \
  --name Bot-A \
  --request-timeout-ms 15000
```

stdin and stdout contain exactly one JSON object per line. stderr is reserved for diagnostics. The first runtime frame is `ready`.

```jsonl
{"type":"ready","protocolVersion":1,"cliVersion":"0.1.0","server":"https://cabo.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
{"id":"about","type":"describe"}
{"id":"health","type":"ping"}
{"id":"create","type":"create","visibility":"public","targetScore":100}
```

Every request has a unique string `id`. Requests are processed serially, but pushed `event` and `observation` frames may appear before the matching `result`.

Use the latest observation as the source of truth and select an action directly from `legalActions`:

```json
{"id":"move-1","type":"action","action":{"type":"draw-deck"}}
```

After a timeout, the result contains `uncertain: true`. State-changing requests are then rejected with `STATE_UNCERTAIN` until a successful `observe` request refreshes the supervisor's view.

## Sessions and shutdown

Sessions are not written by default. Give each Agent a distinct file to enable reconnects:

```bash
cabo-agent --name Bot-A --session-file ./bot-a-session.json
```

- `leave` leaves the room and keeps the process running.
- `shutdown` leaves the room and exits successfully.
- Closing stdin performs the same graceful shutdown.
- `SIGINT` and `SIGTERM` leave gracefully and use exit codes 130 and 143.

See `docs/agent-protocol.md` in the source repository for the complete wire contract.
