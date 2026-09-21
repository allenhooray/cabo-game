import { describe, expect, it } from "vitest";
import { createKnowledge } from "./knowledge.js";
import type { CaboStateLike } from "./model.js";
import { formatCardText, renderCommandPrompt, renderDashboard, renderPlainState } from "./ui.js";

const state: CaboStateLike = {
  revision: 1, roomName: "Friends' room", phase: "TURN_START", round: 2, targetScore: 100, currentPlayerId: "a", caboCallerId: "", discardLabel: "6♥", discardRank: 6,
  deckCount: 39,
  players: new Map([
    ["a", { id: "a", name: "Alice", seat: 0, score: 12, connected: true, forfeited: false, cardCount: 4, isHost: true }],
    ["b", { id: "b", name: "Bob", seat: 1, score: 8, connected: false, forfeited: false, cardCount: 4, isHost: false }],
  ]),
  winners: [],
};

describe("terminal rendering", () => {
  it("renders the table, known cards, recent events, and contextual actions", () => {
    const knowledge = createKnowledge(2, {
      round: 2,
      slots: [{ label: "4♣", rank: 4 }, null, null, null],
      opponents: [{ playerId: "b", slots: [null, { label: "9H", rank: 9 }, null, null] }],
    });
    const output = renderDashboard({ state, selfId: "a", roomId: "room", knowledge, events: ["Bob joined."], flow: { kind: "idle" } });
    expect(output).toContain("YOUR TURN");
    expect(output).toContain("[1] 4♣ (4 pts)");
    expect(output).toContain("Known opponent cards");
    expect(output).toContain("Bob: [1] ?   [2] 9♡ (9 pts)");
    expect(output).toContain("[OFFLINE (60s grace)]");
    expect(output).toContain("[1] Draw from deck");
    expect(output).toContain("Bob joined.");
  });

  it("formats letter suits with the requested glyphs without changing existing glyphs", () => {
    expect(formatCardText("AS 2D 3H 4C")).toBe("A♠ 2♢ 3♡ 4♣");
    expect(formatCardText("A♠ 2♢ 3♡ 4♣ Black Joker K-A")).toBe("A♠ 2♢ 3♡ 4♣ Black Joker K-A");

    const letterState = { ...state, discardLabel: "6H" };
    const knowledge = createKnowledge(2, { round: 2, slots: [
      { label: "AS", rank: 1 },
      { label: "2D", rank: 2 },
      { label: "3H", rank: 3 },
      { label: "4C", rank: 4 },
    ] });
    const output = renderDashboard({ state: letterState, selfId: "a", roomId: "room", knowledge, events: ["Bob discarded 10D."], flow: { kind: "idle" } });

    expect(output).toContain("Discard 6♡");
    expect(output).toContain("[1] A♠ (1 pts)");
    expect(output).toContain("[2] 2♢ (2 pts)");
    expect(output).toContain("[3] 3♡ (3 pts)");
    expect(output).toContain("[4] 4♣ (4 pts)");
    expect(output).toContain("Bob discarded 10♢.");
  });

  it("places events above cards and renders a bordered action selector", () => {
    const output = renderDashboard({
      state,
      selfId: "a",
      roomId: "room",
      knowledge: createKnowledge(2),
      events: ["Bob joined."],
      flow: { kind: "idle" },
      selectionIndex: 1,
    });

    const events = output.indexOf("Recent events");
    const divider = output.indexOf("────────────────");
    const cards = output.indexOf("Your cards");
    const actions = output.indexOf("┌─ Actions");
    expect(events).toBeGreaterThan(-1);
    expect(events).toBeLessThan(divider);
    expect(divider).toBeLessThan(cards);
    expect(cards).toBeLessThan(actions);
    expect(output).toContain("│> [2] Take discard 6♥");
    expect(output).toContain("└────────────────");
  });

  it("keeps the event divider and action border in lobby and disconnected views", () => {
    const lobby = renderDashboard({ state: { ...state, phase: "LOBBY" }, selfId: "a", knowledge: createKnowledge(), events: [], flow: { kind: "idle" } });
    const disconnected = renderDashboard({ knowledge: createKnowledge(), events: [], flow: { kind: "idle" } });

    for (const output of [lobby, disconnected]) {
      expect(output.indexOf("Recent events")).toBeLessThan(output.indexOf("────────────────"));
      expect(output).toContain("┌─ Actions");
    }
  });

  it("keeps plain rendering free of terminal control codes", () => {
    const output = renderPlainState(state, "a", createKnowledge(2), "room");
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("shows the cabo-agent hint only after joining a lobby", () => {
    const lobby = renderDashboard({
      state: { ...state, phase: "LOBBY" },
      selfId: "a",
      roomId: "room",
      knowledge: createKnowledge(),
      events: [],
      flow: { kind: "idle" },
    });
    const disconnected = renderDashboard({ knowledge: createKnowledge(), events: [], flow: { kind: "idle" } });
    const playing = renderDashboard({ state, selfId: "a", roomId: "room", knowledge: createKnowledge(2), events: [], flow: { kind: "idle" } });

    expect(lobby).toContain("cabo-agent");
    expect(disconnected).not.toContain("cabo-agent");
    expect(playing).not.toContain("cabo-agent");
  });

  it("renders room names literally in the room browser", () => {
    const output = renderDashboard({
      knowledge: createKnowledge(),
      events: [],
      flow: {
        kind: "room-browser",
        page: 0,
        rooms: [{ roomId: "room", roomName: "AS room", targetScore: 100, playerCount: 1, maxClients: 5, phase: "LOBBY", isFull: false, isStarted: false, canJoin: true }],
      },
    });
    expect(output).toContain("AS room");
    expect(output).not.toContain("♠ room");
  });

  it("reverses only the interactive command prompt", () => {
    expect(renderCommandPrompt(true)).toBe("\x1b[7m cabo> \x1b[0m ");
    expect(renderCommandPrompt(false)).toBe("cabo> ");
    expect(renderCommandPrompt(false)).not.toMatch(/\x1b\[/);
  });
});
