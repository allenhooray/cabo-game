import { beforeEach, describe, expect, it } from "vitest";
import { BrowserSessionStore, defaultServerUrl, resetServerUrl, savePlayerName, saveServerUrl, savedServerUrl, validateServerUrl } from "./browser-session.js";

describe("browser settings and reconnect session", () => {
  beforeEach(() => localStorage.clear());

  it("stores and resets a player-selected server", () => {
    expect(savedServerUrl()).toBe(defaultServerUrl());
    expect(saveServerUrl("https://cabo.example.test/")).toBe("https://cabo.example.test");
    expect(savedServerUrl()).toBe("https://cabo.example.test");
    expect(resetServerUrl()).toBe(defaultServerUrl());
  });

  it("validates protocols and persists reconnect knowledge", async () => {
    expect(() => validateServerUrl("ws://example.test")).toThrow(/http/);
    const store = new BrowserSessionStore();
    await store.save({ server: "https://game.test", name: "Alice", roomId: "room", token: "room:token", knowledge: { round: 2, slots: [{ label: "4♣", rank: 4 }, null, null, null] } });
    expect(await store.load()).toMatchObject({ name: "Alice", knowledge: { round: 2 } });
    await store.clear();
    expect(await store.load()).toBeUndefined();
    expect(savePlayerName("  Alice  ")).toBe("Alice");
  });
});
