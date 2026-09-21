import { describe, expect, it } from "vitest";
import { createKnowledge } from "./knowledge.js";
import type { CaboStateLike } from "./model.js";
import { renderCommandPrompt, renderDashboard, renderPlainState } from "./ui.js";

const state: CaboStateLike = {
  revision: 1, phase: "TURN_START", round: 2, targetScore: 100, currentPlayerId: "a", caboCallerId: "", discardLabel: "6♥", discardRank: 6,
  deckCount: 39,
  players: new Map([
    ["a", { id: "a", name: "Alice", seat: 0, score: 12, connected: true, forfeited: false, cardCount: 4, isHost: true }],
    ["b", { id: "b", name: "Bob", seat: 1, score: 8, connected: false, forfeited: false, cardCount: 4, isHost: false }],
  ]),
  winners: [],
};

describe("terminal rendering", () => {
  it("renders the table, known cards, recent events, and contextual actions", () => {
    const knowledge = createKnowledge(2, { round: 2, slots: [{ label: "4♣", rank: 4 }, null, null, null] });
    const output = renderDashboard({ state, selfId: "a", roomId: "room", knowledge, events: ["Bob joined."], flow: { kind: "idle" } });
    expect(output).toContain("YOUR TURN");
    expect(output).toContain("[1] 4♣ (4 pts)");
    expect(output).toContain("[OFFLINE (60s grace)]");
    expect(output).toContain("[1] Draw from deck");
    expect(output).toContain("Bob joined.");
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

  it("reverses only the interactive command prompt", () => {
    expect(renderCommandPrompt(true)).toBe("\x1b[7m cabo> \x1b[0m ");
    expect(renderCommandPrompt(false)).toBe("cabo> ");
    expect(renderCommandPrompt(false)).not.toMatch(/\x1b\[/);
  });
});
