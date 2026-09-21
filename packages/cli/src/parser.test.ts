import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses room management commands", () => {
    expect(parseCommand("create private 150")).toEqual({ kind: "create", visibility: "private", targetScore: 150 });
    expect(parseCommand("join abc123 123456")).toEqual({ kind: "join", roomId: "abc123", password: "123456" });
    expect(parseCommand('create public 120 --name "Friday night"')).toEqual({ kind: "create", visibility: "public", targetScore: 120, roomName: "Friday night" });
    expect(parseCommand("create public --name 'Alice\\'s table'")).toEqual({ kind: "create", visibility: "public", targetScore: 100, roomName: "Alice's table" });
    expect(parseCommand('create private --name ""')).toEqual({ kind: "create", visibility: "private", targetScore: 100, roomName: "" });
  });

  it("parses game actions", () => {
    expect(parseCommand("draw discard")).toEqual({ kind: "game", command: { type: "draw-discard" } });
    expect(parseCommand("replace 1 3 at 3")).toEqual({ kind: "game", command: { type: "replace", positions: [1, 3], replacementPosition: 3 } });
    expect(parseCommand("resolve left right")).toEqual({ kind: "game", command: { type: "resolve-mismatch", drawnPlacement: "left", penaltyPlacement: "right" } });
    expect(parseCommand("peek Alice 2")).toEqual({
      kind: "game",
      targetName: "Alice",
      command: { type: "peek-other", targetPlayerId: "", position: 2 },
    });
    expect(parseCommand("cabo")).toEqual({ kind: "game", command: { type: "cabo" } });
  });

  it("rejects invalid positions and target scores", () => {
    expect(() => parseCommand("replace 0")).toThrow("Position");
    expect(() => parseCommand("create public 10")).toThrow("Target");
    expect(() => parseCommand("create public --name")).toThrow("requires");
    expect(() => parseCommand('create public --name "a" --name "b"')).toThrow("only");
    expect(() => parseCommand("create public --other value")).toThrow("Unknown");
    expect(() => parseCommand('create public --name "unfinished')).toThrow("unclosed");
  });
});
