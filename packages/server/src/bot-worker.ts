import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { BotPersonaId } from "@cabo-game/shared";

interface Handle { worker: Worker; roomId: string; playerId?: string; stop(): Promise<void> }
const handles = new Set<Handle>();
const development = import.meta.url.endsWith(".ts");
const limit = Math.max(0, Number.parseInt(process.env.BOT_MAX_TOTAL ?? "20", 10) || 0);
export const botsEnabled = process.env.BOTS_ENABLED !== "false";

export function activeBotCount(): number { return handles.size; }

export function startBot(roomId: string, persona: BotPersonaId, token: string, name: string, onFailure: (error: string) => void): Handle {
  if (!botsEnabled) throw new Error("BOT_DISABLED");
  if (handles.size >= limit) throw new Error("BOT_CAPACITY");
  const worker = new Worker(fileURLToPath(new URL(development ? "./managed-bot.ts" : "./managed-bot.js", import.meta.url)), {
    ...(development ? { execArgv: ["--import", "tsx"] } : {}),
    workerData: { roomId, persona, token, name, server: process.env.BOT_SERVER_URL ?? `http://127.0.0.1:${process.env.PORT ?? "2567"}`, seed: randomBytes(4).readUInt32BE(0), development },
  });
  let stopping = false;
  let childPid: number | undefined;
  const killChild = () => { if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } } };
  const handle: Handle = {
    worker, roomId,
    async stop() {
      if (stopping) return;
      stopping = true;
      handles.delete(handle);
      worker.postMessage({ type: "stop" });
      await Promise.race([new Promise<void>((resolve) => worker.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      await worker.terminate();
      killChild();
    },
  };
  handles.add(handle);
  worker.on("message", (message: { type?: string; pid?: number }) => {
    if (message.type === "child" && Number.isInteger(message.pid)) childPid = message.pid;
    if (message.type === "child-exit" && childPid === message.pid) childPid = undefined;
  });
  console.info(`[bot] starting room=${roomId} persona=${persona} active=${handles.size}`);
  worker.on("error", (error) => { if (!stopping) { console.error(`[bot] worker error room=${roomId}: ${error.message}`); onFailure(error.message); } });
  worker.on("exit", (code) => { handles.delete(handle); if (!stopping) { killChild(); console.error(`[bot] worker exited room=${roomId} code=${code}`); onFailure(`Bot worker exited (${code}).`); } });
  return handle;
}

export type BotHandle = Handle;
