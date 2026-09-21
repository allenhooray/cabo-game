import { describe, expect, it } from "vitest";
import { ROOM_PAGE_SIZE, advanceFlow, escapeTerminalText, menuFor, moveRoomPage, moveSelection, selectionOptionsFor, selectMenu, stateGuard, type InteractionContext } from "./interaction.js";
import type { ListedRoom } from "./model.js";
import type { CaboStateLike, StatePlayer } from "./model.js";

const alice: StatePlayer = { id: "a", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: true };
const bob: StatePlayer = { id: "b", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, cardCount: 4, isHost: false };

function context(phase: string, currentPlayerId = "a", discardRank = 5): InteractionContext {
  const state: CaboStateLike = {
    revision: 1,
    roomName: "Alice's room",
    phase, round: 1, targetScore: 100, currentPlayerId, caboCallerId: "", drawSource: phase === "DRAWN" ? "deck" : "", mismatchPenaltyCardPending: false, discardLabel: "5♣", discardRank,
    deckCount: 43, players: new Map([["a", alice], ["b", bob]]), winners: [],
  };
  return { state, selfId: "a" };
}

describe("context actions", () => {
  it("shows only legal actions for the current phase", () => {
    expect(menuFor(context("TURN_START")).map((item) => item.action)).toEqual(["draw-deck", "draw-discard", "cabo"]);
    expect(menuFor(context("DRAWN")).map((item) => item.action)).toEqual(["replace", "discard"]);
    expect(menuFor(context("TURN_START", "b"))).toEqual([]);
    expect(menuFor(context("POWER_PENDING", "a", 10)).map((item) => item.action)).toEqual(["peek-other", "skip"]);
  });

  it("turns numeric choices into guided position commands", () => {
    const ctx = context("TURN_START");
    const selected = selectMenu("2", ctx);
    expect(selected).toEqual({ kind: "game", command: { type: "draw-discard" } });
  });

  it("guides target then position and supports cancellation", () => {
    const ctx = context("POWER_PENDING", "a", 11);
    const selected = selectMenu("1", ctx);
    if (selected?.kind !== "flow") throw new Error("missing target flow");
    const target = advanceFlow("1", selected.flow, ctx);
    if (target.kind !== "flow") throw new Error("missing position flow");
    expect(advanceFlow("4", target.flow, ctx)).toEqual({ kind: "game", command: { type: "swap", targetPlayerId: "b", position: 4 } });
    expect(advanceFlow("cancel", target.flow, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
  });

  it("requires an explicit yes before CABO", () => {
    const ctx = context("TURN_START");
    const result = selectMenu("3", ctx);
    if (result?.kind !== "flow") throw new Error("missing confirmation");
    expect(advanceFlow("n", result.flow, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
    expect(advanceFlow("yes", result.flow, ctx)).toEqual({ kind: "game", command: { type: "cabo" } });
    expect(result.flow).toMatchObject({ guard: stateGuard(ctx) });
  });

  it("exposes keyboard options for every guided selection step", () => {
    const ctx = context("POWER_PENDING", "a", 11);
    const guard = stateGuard(ctx);

    expect(selectionOptionsFor({ kind: "idle" }, ctx).map((option) => option.value)).toEqual(["1", "2"]);
    expect(selectionOptionsFor({ kind: "position", action: "peek-self", guard }, ctx).map((option) => option.value)).toEqual(["1", "2", "3", "4"]);
    expect(selectionOptionsFor({ kind: "replacement-position", positions: [1, 3], guard }, ctx).map((option) => option.value)).toEqual(["1", "3"]);
    expect(selectionOptionsFor({ kind: "target", action: "swap", guard }, ctx)).toEqual([{ value: "1", label: "Bob" }]);
    expect(selectionOptionsFor({ kind: "target-position", action: "swap", target: bob, guard }, ctx).map((option) => option.value)).toEqual(["1", "2", "3", "4"]);
    expect(selectionOptionsFor({ kind: "confirm-cabo", guard }, ctx)).toEqual([
      { value: "n", label: "No, keep playing" },
      { value: "y", label: "Yes, call CABO" },
    ]);
    expect(selectionOptionsFor({ kind: "join-room" }, ctx)).toEqual([]);
    expect(selectionOptionsFor({ kind: "create-target", visibility: "public" }, ctx)).toEqual([]);
  });

  it("wraps keyboard selection in both directions", () => {
    expect(moveSelection(0, -1, 4)).toBe(3);
    expect(moveSelection(3, 1, 4)).toBe(0);
    expect(moveSelection(1, 1, 4)).toBe(2);
    expect(moveSelection(5, -1, 0)).toBe(0);
  });

  it("keeps typed shortcuts, cancellation, and the safe CABO default compatible", () => {
    const ctx = context("TURN_START");
    const guard = stateGuard(ctx);
    const confirm = { kind: "confirm-cabo", guard } as const;

    expect(selectionOptionsFor(confirm, ctx)[0]?.value).toBe("n");
    expect(advanceFlow(selectionOptionsFor(confirm, ctx)[0]?.value ?? "", confirm, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
    expect(selectMenu("2", ctx)?.kind).toBe("game");
    expect(advanceFlow("cancel", { kind: "replace-positions", guard }, ctx)).toMatchObject({ kind: "flow", flow: { kind: "idle" } });
  });

  it("collects the room name before target score without reparsing a command string", () => {
    const started = selectMenu("2", { playerName: "Alice" });
    if (started?.kind !== "flow") throw new Error("missing room name flow");
    expect(started.flow).toEqual({ kind: "create-name", visibility: "public", defaultRoomName: "Alice's room" });
    const named = advanceFlow("Friday night", started.flow, {});
    if (named.kind !== "flow") throw new Error("missing target flow");
    expect(advanceFlow("150", named.flow, {})).toEqual({ kind: "create", visibility: "public", targetScore: 150, roomName: "Friday night" });
  });

  it("paginates room browsing in groups of ten and stops at page boundaries", () => {
    const rooms: ListedRoom[] = Array.from({ length: 21 }, (_, index) => ({
      roomId: `id-${index + 1}`, roomName: `Room ${index + 1}`, targetScore: 100, playerCount: 1, maxClients: 5,
      phase: "LOBBY", isFull: false, isStarted: false, canJoin: true,
    }));
    const first = { kind: "room-browser", rooms, page: 0 } as const;
    expect(selectionOptionsFor(first, {})).toHaveLength(ROOM_PAGE_SIZE + 1);
    expect(moveRoomPage(first, -1)).toMatchObject({ page: 0 });
    const second = moveRoomPage(first, 1);
    expect(selectionOptionsFor(second, {})).toHaveLength(11);
    const third = moveRoomPage(second as Extract<typeof second, { kind: "room-browser" }>, 1);
    expect(selectionOptionsFor(third, {})).toHaveLength(2);
    expect(moveRoomPage(third as Extract<typeof third, { kind: "room-browser" }>, 1)).toMatchObject({ page: 2 });
  });

  it("always provides a way back from the room browser", () => {
    const empty = { kind: "room-browser", rooms: [], page: 0 } as const;
    expect(selectionOptionsFor(empty, {})).toEqual([{ value: "cancel", label: "Back to main menu" }]);
    expect(advanceFlow("cancel", empty, {})).toEqual({
      kind: "flow",
      flow: { kind: "idle" },
      message: "Selection cancelled.",
    });
  });

  it("escapes terminal control characters in room labels", () => {
    expect(escapeTerminalText("safe\u001b[2J")).toBe("safe\\u001b[2J");
  });
});
