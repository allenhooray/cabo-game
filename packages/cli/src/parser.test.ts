import { describe, expect, it } from "vitest";
import { parseCommand } from "./parser.js";

describe("parseCommand", () => {
  it("parses room management commands", () => {
    expect(parseCommand("create private 150")).toEqual({ kind: "create", visibility: "private", targetScore: 150 });
    expect(parseCommand("join abc123 123456")).toEqual({ kind: "join", roomId: "abc123", password: "123456" });
  });

  it("parses game actions", () => {
    expect(parseCommand("draw discard 3")).toEqual({ kind: "game", command: { type: "draw-discard", position: 3 } });
    expect(parseCommand("peek Alice 2")).toEqual({
      kind: "game",
      targetName: "Alice",
      command: { type: "peek-other", targetPlayerId: "", position: 2 },
    });
    expect(parseCommand("cabo")).toEqual({ kind: "game", command: { type: "cabo" } });
  });

  it("rejects invalid positions and target scores", () => {
    expect(() => parseCommand("replace 5")).toThrow("Position");
    expect(() => parseCommand("create public 10")).toThrow("Target");
  });
});
