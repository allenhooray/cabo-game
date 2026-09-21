import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App, __test } from "./App.js";

describe("Cabo home", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("renders the entry actions and empty public room state", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /keep the lowest hand/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /set player name/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /create or join a room/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/docs/rules/");
    expect(screen.getByRole("link", { name: "CLI" })).toHaveAttribute("href", "/docs/cli/");
    expect(screen.getByRole("link", { name: "Agent" })).toHaveAttribute("href", "/docs/agent/");
    await waitFor(() => expect(screen.getByText(/no public rooms are waiting/i)).toBeInTheDocument());
  });

  it("starts with a generated name and saves a player-selected name", () => {
    const { container } = render(<App />);
    const nameInput = container.querySelector<HTMLInputElement>("#player-name")!;
    expect(nameInput.value).toMatch(/^Player[A-Z0-9]{4}$/);
    fireEvent.change(nameInput, { target: { value: "  Alice  " } });
    fireEvent.click(container.querySelector<HTMLButtonElement>(".name-actions button")!);
    expect(nameInput).toHaveValue("Alice");
    expect(localStorage.getItem("cabo.name.v1")).toBe("Alice");
    expect(container.querySelector("[role=status]")).toHaveTextContent("Saved");
  });
});

describe("Cabo game table additions", () => {
  it("opens quick rules on hover and links to the full rules", () => {
    render(<__test.RulesPopover />);
    const trigger = screen.getByRole("button", { name: "Rules" });
    fireEvent.mouseEnter(trigger.parentElement as HTMLElement);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Quick rules" })).toBeVisible();
    expect(screen.getByRole("link", { name: /read the full rules/i })).toHaveAttribute("href", "/docs/rules/");
    fireEvent.keyDown(trigger.parentElement as HTMLElement, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.mouseLeave(trigger.parentElement as HTMLElement);
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("offers a route back to rooms after a match", () => {
    const onLeave = vi.fn(async () => undefined);
    render(
      <__test.Results
        result={{ type: "match-result", winners: ["alice"], totals: { alice: 8, bob: 24 } }}
        state={{ round: 3 } as any}
        playerName={(id) => id === "alice" ? "Alice" : "Bob"}
        busy={false}
        onLeave={onLeave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to rooms" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("shows the local player's running score", () => {
    const players = new Map([
      ["alice", { id: "alice", name: "Alice", seat: 0, score: 12, connected: true, forfeited: false, cardCount: 4, isHost: true }],
      ["bob", { id: "bob", name: "Bob", seat: 1, score: 7, connected: true, forfeited: false, cardCount: 4, isHost: false }],
    ]);
    render(
      <__test.GameTable
        state={{ revision: 2, phase: "TURN_START", round: 1, targetScore: 100, currentPlayerId: "bob", caboCallerId: "", discardLabel: "4H", discardRank: 4, deckCount: 40, players, winners: [] }}
        selfId="alice"
        players={[...players.values()]}
        core={{ knowledge: { slots: [null, null, null, null], held: null } } as any}
        busy={false}
        selection="idle"
        targetId={undefined}
        events={[]}
        cardMotion={undefined}
        onSelection={vi.fn()}
        onTarget={vi.fn()}
        onExecute={vi.fn()}
        onConfirm={vi.fn()}
        onLeave={vi.fn()}
        onConcealStart={vi.fn()}
        onConcealEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("Alice · 12 pts")).toBeVisible();
  });

  it("maps successful card commands to focused motion cues", () => {
    expect(__test.motionForCommand({ type: "draw-deck" }, "alice")).toEqual({ kind: "draw", playerId: "alice" });
    expect(__test.motionForCommand({ type: "replace", position: 3 }, "alice")).toEqual({ kind: "replace", playerId: "alice", position: 3 });
    expect(__test.motionForCommand({ type: "swap", targetPlayerId: "bob", position: 2 }, "alice")).toEqual({ kind: "swap", playerId: "alice", targetPlayerId: "bob", position: 2 });
    expect(__test.motionForCommand({ type: "skip" }, "alice")).toBeUndefined();
  });
});
