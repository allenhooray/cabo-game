import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearSession, loadSession, saveSession, type SavedSession } from "./config.js";

describe("session config", () => {
  it("round-trips a private reconnection token with restricted permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cabo-cli-"));
    const path = join(directory, "nested", "session.json");
    const session: SavedSession = { server: "http://localhost:2567", name: "Alice", roomId: "room", token: "secret" };
    await saveSession(session, path);
    expect(await loadSession(path)).toEqual(session);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await clearSession(path);
    expect(await loadSession(path)).toBeUndefined();
  });
});
