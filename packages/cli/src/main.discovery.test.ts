import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const main = resolve(root, "packages/cli/src/main.ts");

function run(args: string[]) {
  return spawnSync(tsx, [main, ...args], { cwd: root, encoding: "utf8" });
}

describe("interactive CLI discovery modes", () => {
  it.each(["--help", "-h"])("prints help for %s without starting the client", (option) => {
    const output = run([option]);

    expect(output.status).toBe(0);
    expect(output.stdout).toContain("Usage: cabo");
    expect(output.stdout).toContain("cabo-agent");
    expect(output.stdout).not.toContain("CABO\n====");
    expect(output.stdout).not.toContain("cabo> ");
  });

  it.each(["--version", "-v"])("prints the package version for %s without starting the client", (option) => {
    const output = run([option]);

    expect(output.status).toBe(0);
    expect(output.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(output.stdout).not.toContain("CABO\n====");
    expect(output.stdout).not.toContain("cabo> ");
  });
});
