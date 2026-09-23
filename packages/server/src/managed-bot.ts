import { parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotDriver } from "@cabo-game/bot/driver";
import type { BotPersonaId } from "@cabo-game/shared";

const data = workerData as { roomId: string; persona: BotPersonaId; token: string; name: string; server: string; seed: number; development: boolean };
const directory = await mkdtemp(join(tmpdir(), "cabo-bot-"));
let stopping = false;
async function cleanup(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try { await driver.stop({ leave: code === 0 }); } finally { await rm(directory, { recursive: true, force: true }); process.exit(code); }
}
const driver = new BotDriver({
  command: process.execPath,
  args: [...(data.development ? ["--import", "tsx"] : []), fileURLToPath(new URL(data.development ? "../../cli/src/agent-main.ts" : "../../cli/dist/agent-main.js", import.meta.url)), "--server", data.server, "--name", data.name, "--session-file", join(directory, "session.json")],
  persona: data.persona,
  join: { roomId: data.roomId, botToken: data.token },
  managed: true,
  seed: data.seed,
  sessionFile: join(directory, "session.json"),
  maxReconnects: 3,
  onFailure: () => { void cleanup(1); },
  onChildSpawn: (pid) => parentPort?.postMessage({ type: "child", pid }),
  onChildExit: (pid) => parentPort?.postMessage({ type: "child-exit", pid }),
  log: (line) => console.error(`[bot ${data.roomId}] ${line}`),
});
parentPort?.on("message", (message: { type: string }) => {
  if (message.type === "stop") void cleanup(0);
});
try { await driver.start(); } catch { await cleanup(1); }
