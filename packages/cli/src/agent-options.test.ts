import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_URL } from "@cabo-game/client-core";
import { AgentOptionError, DEFAULT_REQUEST_TIMEOUT_MS, parseAgentOptions, renderAgentHelp } from "./agent-options.js";

describe("agent CLI options", () => {
  it("parses run options and defaults", () => {
    expect(DEFAULT_SERVER_URL).toBe("https://cabo-api.human404.link");
    expect(parseAgentOptions([], "Bot")).toEqual({
      mode: "run",
      serverUrl: DEFAULT_SERVER_URL,
      playerName: "Bot",
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
    expect(parseAgentOptions(["--server", "http://host:1234/", "--name", "Alice", "--session-file", "/tmp/a.json", "--request-timeout-ms", "500"], "Bot"))
      .toEqual({ mode: "run", serverUrl: "http://host:1234", playerName: "Alice", sessionPath: "/tmp/a.json", requestTimeoutMs: 500 });
  });

  it("supports discovery modes without runtime options", () => {
    expect(parseAgentOptions(["--help"], "Bot")).toEqual({ mode: "help" });
    expect(parseAgentOptions(["--version"], "Bot")).toEqual({ mode: "version" });
    expect(parseAgentOptions(["--print-schema"], "Bot")).toEqual({ mode: "schema" });
    expect(renderAgentHelp()).toContain("--request-timeout-ms");
    expect(renderAgentHelp()).toContain(`default: ${DEFAULT_SERVER_URL}`);
  });

  it("rejects unknown, missing and out-of-range options", () => {
    for (const args of [["--wat"], ["--server"], ["--request-timeout-ms", "99"], ["value"]]) {
      expect(() => parseAgentOptions(args, "Bot")).toThrow(AgentOptionError);
    }
  });
});
