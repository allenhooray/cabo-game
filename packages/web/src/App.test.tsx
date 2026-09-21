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
    await waitFor(() => expect(screen.getByText(/no public rooms yet/i)).toBeInTheDocument());
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

  it("prefills the create form with a room name based on the current player", () => {
    const { container } = render(<App />);
    const nameInput = container.querySelector<HTMLInputElement>("#player-name")!;
    fireEvent.change(nameInput, { target: { value: "Alice" } });
    fireEvent.click(container.querySelector<HTMLButtonElement>(".entry-actions .primary")!);
    const roomName = container.querySelector<HTMLInputElement>("#create-room-name")!;
    expect(roomName).toHaveValue("Alice's room");
    fireEvent.change(roomName, { target: { value: "" } });
    expect(roomName).toHaveValue("");
  });

  it("shows room names and statuses and disables rooms that cannot be joined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      roomId: "abc123", roomName: "Friday night", targetScore: 100, playerCount: 4, maxClients: 4,
      phase: "TURN_START", isFull: true, isStarted: true, canJoin: false,
    }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<App />);
    expect(await screen.findByText("Friday night")).toBeVisible();
    expect(screen.getByText(/Full · Started · 4 \/ 4 players/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  });
});

describe("Cabo game table additions", () => {
  it("shows the room name and a separate room id in the lobby", () => {
    const { container } = render(
      <__test.Lobby
        roomId="abc123"
        roomName="Friday night"
        targetScore={100}
        players={[]}
        selfId="alice"
        canStart={false}
        busy={false}
        onStart={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    expect(container.querySelector(".room-name")).toHaveTextContent("Friday night");
    expect(container.querySelector(".room-id")).toHaveTextContent("abc123");
  });

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
    const { container } = render(
      <__test.GameTable
        state={{ revision: 2, roomName: "Alice's room", phase: "TURN_START", round: 1, targetScore: 100, currentPlayerId: "bob", caboCallerId: "", discardLabel: "4H", discardRank: 4, deckCount: 40, players, winners: [] }}
        selfId="alice"
        players={[...players.values()]}
        core={{ knowledge: { slots: [null, null, null, null], opponents: [{ playerId: "bob", slots: [{ label: "9H", rank: 9 }, null, null, null] }], held: null } } as any}
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
    expect(screen.getByText("9♥")).toBeVisible();
    expect(container.querySelector('[data-card-anchor="decision-alice"]')).toBeInTheDocument();
    expect(__test.buildFlights({
      id: 1,
      type: "action",
      action: "draw-discard",
      playerId: "alice",
      position: 2,
      takenCard: { label: "4H", rank: 4 },
      discardedCard: { label: "KC", rank: 13 },
    }).map((flight) => flight.key)).toEqual(["take-discard", "replace-discard"]);
  });

});
