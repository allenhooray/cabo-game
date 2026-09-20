export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MIN_REQUEST_TIMEOUT_MS = 100;
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

export type AgentCliOptions =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "schema" }
  | {
      mode: "run";
      serverUrl: string;
      playerName: string;
      sessionPath?: string;
      requestTimeoutMs: number;
    };

export class AgentOptionError extends Error {
  readonly code = "INVALID_ARGUMENT";

  constructor(message: string) {
    super(message);
    this.name = "AgentOptionError";
  }
}

export function parseAgentOptions(args: string[], defaultName: string): AgentCliOptions {
  const modes = [args.includes("--help"), args.includes("--version"), args.includes("--print-schema")].filter(Boolean).length;
  if (modes > 1) throw new AgentOptionError("Use only one of --help, --version, or --print-schema.");
  if (args.includes("--help")) return { mode: "help" };
  if (args.includes("--version")) return { mode: "version" };
  if (args.includes("--print-schema")) return { mode: "schema" };

  let serverUrl = "http://localhost:2567";
  let playerName = defaultName;
  let sessionPath: string | undefined;
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) throw new AgentOptionError(`Unexpected argument: ${argument ?? ""}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new AgentOptionError(`Missing value for ${argument}.`);
    index += 1;
    switch (argument) {
      case "--server": serverUrl = value.replace(/\/$/, ""); break;
      case "--name": playerName = value.trim().slice(0, 20); break;
      case "--session-file": sessionPath = value; break;
      case "--request-timeout-ms": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < MIN_REQUEST_TIMEOUT_MS || parsed > MAX_REQUEST_TIMEOUT_MS) {
          throw new AgentOptionError(`--request-timeout-ms must be an integer from ${MIN_REQUEST_TIMEOUT_MS} to ${MAX_REQUEST_TIMEOUT_MS}.`);
        }
        requestTimeoutMs = parsed;
        break;
      }
      default: throw new AgentOptionError(`Unknown option: ${argument}.`);
    }
  }
  if (!serverUrl) throw new AgentOptionError("--server must not be empty.");
  if (!playerName) throw new AgentOptionError("--name must not be empty.");
  return {
    mode: "run",
    serverUrl,
    playerName,
    ...(sessionPath ? { sessionPath } : {}),
    requestTimeoutMs,
  };
}

export function renderAgentHelp(): string {
  return [
    "Usage: cabo-agent [options]",
    "",
    "A JSONL process interface for running one Cabo player.",
    "",
    "Options:",
    "  --server URL                 Cabo server (default: http://localhost:2567)",
    "  --name NAME                  Player name (default: current OS user)",
    "  --session-file PATH          Persist this Agent's reconnect session",
    `  --request-timeout-ms N       Request timeout, ${MIN_REQUEST_TIMEOUT_MS}-${MAX_REQUEST_TIMEOUT_MS} (default: ${DEFAULT_REQUEST_TIMEOUT_MS})`,
    "  --print-schema               Print the JSON Schema for protocol v1",
    "  --version                    Print the CLI package version",
    "  --help                       Show this help",
    "",
    "stdin and stdout use one JSON object per line. stderr is diagnostics only.",
    'Example request: {"id":"1","type":"describe"}',
    'Example action:  {"id":"2","type":"action","action":{"type":"draw-deck"}}',
    "Protocol: see the installed package README or docs/agent-protocol.md in the source repository.",
  ].join("\n");
}
