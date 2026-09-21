---
name: cabo
description: Play a complete Cabo match through the cabo-agent JSONL subprocess, including installation, room discovery or creation, legal-action selection, waiting, reconnect recovery, and graceful shutdown.
---

# Play Cabo

Use `cabo-agent` as a persistent, bidirectional JSONL subprocess. Keep the same process and stdin handle for the whole match; do not run it as a one-shot command.

## Prepare and start

1. Confirm Node.js 22 or newer is available. If `cabo-agent` is missing, install it with `npm install --global @cabo-game/cli`.
2. Choose a player name and a unique writable session file. Reuse the exact server, name, and session file if the process must be restarted. Never share a session file between players.
3. Start `cabo-agent --name <name> --session-file <path>`. Add `--server <url>` only when the user supplied a different server.
4. Read stdout one complete line at a time and parse each line as JSON. Send exactly one JSON request per stdin line. Treat stderr as diagnostics, never as protocol.
5. Wait for the initial `ready` frame before sending requests. Every request must have a unique, non-empty string `id`.

Use `cabo-agent --print-schema` when an exact request or frame shape is uncertain. It prints the schema and exits without joining a game.

## Enter a room

Send `{"id":"rooms-1","type":"rooms"}` and inspect `data.rooms` in the matching result.

- Join a suitable room only when `canJoin` is true, using its exact `roomId`: `{"id":"join-1","type":"join","roomId":"..."}`. Include `password` only when the user supplied the six-digit password.
- If no suitable room is joinable, create a public 100-point room: `{"id":"create-1","type":"create","visibility":"public","targetScore":100,"roomName":"Cabo Agent table"}`.
- After creating a room, report its `roomId` so another player can join. Keep the process alive and wait for observations.
- In `LOBBY`, send `start` only when it appears in `legalActions`. Otherwise wait; a host cannot start until at least two active players are present.

## Run the match

Maintain the most recent `observation` as the only authoritative decision state. Events are useful for logs, but they do not replace an observation.

For each observation:

1. If `state.phase` is `MATCH_RESULT`, record `state.winners` and the player scores, then finish the process as described below.
2. If `legalActions` is empty, wait for a pushed observation or connection event. Do not poll, guess a command, or act merely because an older observation said it was this player's turn.
3. Otherwise choose one legal action using `state`, `knowledge`, and the game rules. Never infer a hidden card that is `null`.
4. Send one action request, for example `{"id":"move-7","type":"action","action":{"type":"draw-deck"}}`. Wait for its matching `result` before sending another state-changing request. Observations and events may arrive before that result.

Most `legalActions` entries are complete action objects and can be copied unchanged into the request's `action` field. There are two descriptors that require constructing an action:

- `replace`: choose between `minSelections` and `maxSelections` distinct values from `selectablePositions`. Send `positions` and set `replacementPosition` to one of those selected positions.
- `resolve-mismatch`: choose `drawnPlacement` from `placements`. If `penaltyCardPending` is true, also choose `penaltyPlacement`; if false, omit `penaltyPlacement`.

Handle the full lifecycle:

- In `ROUND_RESULT`, inspect the latest `state.roundHistory` entry for the authoritative round outcome, each player's revealed cards, hand score, round score, and cumulative total. Use this synchronized history when reporting or comparing earlier rounds instead of reconstructing scores from events.
- Send `ready-next-round` when it appears in `legalActions`, then wait for the other active players.
- Continue across rounds until `MATCH_RESULT`; do not stop after the first round.
- If a result has `uncertain: true` or code `REQUEST_TIMEOUT`, do not retry that action. Send a unique `observe` request and resume only after its successful result supplies a fresh observation. `STATE_UNCERTAIN` has the same recovery requirement.
- For an ordinary rejected action, use the returned error and wait for or request a fresh observation rather than inventing a corrected action from stale state.

## Recover a connection

- When a live process emits `connection-dropped`, keep it alive and wait for `connection-restored` and a fresh observation; the client performs its own transient reconnect handling.
- If the Agent process itself exits unexpectedly, restart it with the same server, name, and session file, wait for `ready`, then send `{"id":"reconnect-1","type":"reconnect"}`. A disconnected seat is retained for only 60 seconds, so recover promptly.
- Never send `leave`, close stdin, or terminate the process merely to reconnect. During an active match those graceful-exit paths release the seat and count as a forfeit.

## Finish

After observing `MATCH_RESULT`, report the winner names/IDs and final scores. Include a round-by-round summary from `state.roundHistory` when the user asks for match history or scoring details. Then send a unique `shutdown` request, wait for its successful result, and wait for the process to exit with status 0.

For the complete protocol read [the Agent JSONL contract](https://github.com/allenhooray/cabo-game/blob/master/docs/agent-protocol.md). For scoring and card powers read [the Cabo rules](https://cabo.human404.link/docs/rules/).
