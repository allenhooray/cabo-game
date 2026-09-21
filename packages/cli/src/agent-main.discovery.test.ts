import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const main = resolve(root, "packages/cli/src/agent-main.ts");

function run(args: string[], input?: string) {
  return spawnSync(tsx, [main, ...args], { cwd: root, encoding: "utf8", ...(input === undefined ? {} : { input }) });
}

describe("agent CLI discovery modes", () => {
  it("prints help and version without starting a protocol session", () => {
    for (const option of ["--help", "-h"]) {
      const help = run([option]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: cabo-agent");
      expect(help.stdout).not.toContain('"type":"ready"');
    }

    for (const option of ["--version", "-v"]) {
      const version = run([option]);
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(version.stdout).not.toContain('"type":"ready"');
    }
  });

  it("prints parseable JSON Schema without a ready frame", () => {
    const output = run(["--print-schema"]);
    expect(output.status).toBe(0);
    const schema = JSON.parse(output.stdout);
    expect(schema.$id).toBe("urn:cabo:agent-protocol:v6");
    expect(output.stdout).not.toContain('"type":"ready"');
  });

  it("reports invalid options as one fatal JSON frame", () => {
    const output = run(["--request-timeout-ms", "99"]);
    expect(output.status).toBe(2);
    const lines = output.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ type: "fatal", error: { code: "INVALID_ARGUMENT" } });
  });

  it("treats stdin EOF as a graceful shutdown", () => {
    const output = run(["--name", "EOF-Bot"], "");
    expect(output.status).toBe(0);
    const lines = output.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "ready", protocolVersion: 6, name: "EOF-Bot" });
  });
});
