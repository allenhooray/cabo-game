import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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
      roomId: "abc123", roomName: "Friday night", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 5, maxClients: 5,
      phase: "TURN_START", isFull: true, isStarted: true, canJoin: false,
    }]), { status: 200, headers: { "content-type": "application/json" } })));
    render(<App />);
    expect(await screen.findByText("Friday night")).toBeVisible();
    expect(screen.getByText(/Full · Started · 5 \/ 5 players/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  });

  it("renders legacy room listings with a fallback name and an enabled Join action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      roomId: "legacy123", memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, targetScore: 100, playerCount: 1, maxClients: 4, phase: "LOBBY",
    }]), { status: 200, headers: { "content-type": "application/json" } })));

    const { container } = render(<App />);

    expect(await screen.findByText("Unnamed room")).toBeVisible();
    expect(screen.getByText(/Open · Waiting · 1 \/ 4 players/)).toBeVisible();
    expect(within(container).getByRole("button", { name: "Join" })).toBeEnabled();
  });
});

describe("Cabo game table additions", () => {
  it("confirms J/Q using independent own and opponent positions", () => {
    const players = [
      { id: "alice", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true },
      { id: "bob", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 5, isHost: false },
    ];
    const onConfirm = vi.fn(); const onExecute = vi.fn();
    function Harness() {
      const [targetId, onTarget] = useState<string>();
      return <__test.GameTable
        state={{ memoryMode: "classic", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, revision: 12, roomName: "Room", phase: "POWER_PENDING", round: 1, targetScore: 100, currentPlayerId: "alice", caboCallerId: "", drawSource: "", mismatchPenaltyCardPending: false, discardLabel: "JS", discardRank: 11, deckCount: 40, players: new Map(players.map((p) => [p.id, p])), winners: [] }}
        selfId="alice" players={players} core={{ knowledge: { slots: [null, null, null, null], opponents: [], held: null } } as any}
        busy={false} selection="swap" targetId={targetId} events={[]} cardMotion={undefined}
        onSelection={vi.fn()} onTarget={onTarget} onExecute={onExecute} onConfirm={onConfirm}
        onLeave={vi.fn()}
      />;
    }
    const { container } = render(<Harness />);
    expect(screen.getByRole("button", { name: /Bob.*0 pts/ })).toBeDisabled();
    fireEvent.click(container.querySelectorAll(".hand-slot")[1]!);
    fireEvent.click(screen.getByRole("button", { name: /Bob.*0 pts/ }));
    fireEvent.click(screen.getByRole("button", { name: "05" }));
    expect(onExecute).not.toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ revision: 12, body: expect.stringContaining("Your card 2") }));
    onConfirm.mock.calls[0]![0].action();
    expect(onExecute).toHaveBeenCalledWith({ type: "swap", targetPlayerId: "bob", ownPosition: 2, targetPosition: 5 });
  });
  it("sends plain room chat only on submit and validates Unicode code points", () => {
    const onSend = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState("");
      return <__test.RoomChat messages={[]} selfId="alice" enabled status="" draft={draft} onDraft={setDraft} onSend={onSend} />;
    }
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "hello room" } });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.submit(input.closest("form")!);
    expect(onSend).toHaveBeenCalledWith("hello room");
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "😀".repeat(201) } });
    expect(screen.getByText(/at most 200/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("labels the current player as You, renders text literally, and closes on Escape", () => {
    const onClose = vi.fn();
    const messages = [
      { sequence: 1, playerId: "alice", playerName: "Alice", text: "<b>safe</b>", sentAt: 0 },
      { sequence: 2, playerId: "bob", playerName: "Bob", text: "hello", sentAt: 1 },
    ];
    const { container } = render(<__test.RoomChat messages={messages} selfId="alice" enabled status="" draft="" onDraft={vi.fn()} autoFocus onClose={onClose} onSend={vi.fn()} />);
    expect(screen.getByText("You")).toBeVisible();
    expect(screen.getByText("Bob")).toBeVisible();
    expect(screen.getByText("<b>safe</b>")).toBeVisible();
    expect(container.querySelector("b")).not.toBeInTheDocument();
    expect(within(container).getByRole("textbox", { name: "Message" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

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
    expect(container.querySelectorAll(".seat")).toHaveLength(5);
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
    const { container } = render(
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

  it("shows readiness progress and lets the local player confirm the next round", () => {
    const onReady = vi.fn();
    const players = new Map([
      ["alice", { id: "alice", name: "Alice", seat: 0, score: 4, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true }],
      ["bob", { id: "bob", name: "Bob", seat: 1, score: 8, connected: false, forfeited: false, nextRoundReady: true, cardCount: 4, isHost: false }],
    ]);
    render(
      <__test.Results
        result={{ type: "round-result", hands: [], roundScores: {}, totals: {}, outcome: { type: "cabo", callerId: "alice", succeeded: true } }}
        state={{ round: 1, players } as any}
        selfId="alice"
        playerName={(id) => id}
        busy={false}
        onReady={onReady}
        onLeave={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText("1 of 2 active players ready")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ready for next round" }));
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("shows the local player's running score", () => {
    const players = new Map([
      ["alice", { id: "alice", name: "Alice", seat: 0, score: 12, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true }],
      ["bob", { id: "bob", name: "Bob", seat: 1, score: 7, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false }],
    ]);
    const { container } = render(
      <__test.GameTable
        state={{ memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, revision: 2, roomName: "Alice's room", phase: "TURN_START", round: 1, targetScore: 100, currentPlayerId: "bob", caboCallerId: "", drawSource: "", mismatchPenaltyCardPending: false, discardLabel: "4H", discardRank: 4, deckCount: 40, players, winners: [] }}
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
      takenCard: { label: "4H", rank: 4 },
    }).map((flight) => flight.key)).toEqual(["take-discard"]);
  });

  it("expands the synchronized score matrix and exposes every round hand", () => {
    const players = new Map([
      ["alice", { id: "alice", name: "Alice", seat: 0, score: 4, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true }],
      ["bob", { id: "bob", name: "Bob", seat: 1, score: 12, connected: true, forfeited: true, nextRoundReady: false, cardCount: 0, isHost: false }],
    ]);
    render(<__test.ScoreHistoryPanel state={{
      players,
      round: 2,
      roundHistory: [{
        round: 1,
        outcomeType: "cabo",
        outcomePlayerId: "alice",
        caboSucceeded: true,
        players: [
          { playerId: "alice", roundScore: 4, totalScore: 4, handScore: 4, cards: [{ label: "4H", rank: 4 }] },
          { playerId: "bob", roundScore: 12, totalScore: 12, handScore: 12, cards: [{ label: "QH", rank: 12 }] },
        ],
      }, {
        round: 2,
        outcomeType: "shooting-the-moon",
        outcomePlayerId: "alice",
        caboSucceeded: false,
        players: [{ playerId: "alice", roundScore: 0, totalScore: 4, handScore: 50, cards: [{ label: "QH", rank: 12 }, { label: "QS", rank: 12 }, { label: "KH", rank: 13 }, { label: "KS", rank: 13 }] }],
      }],
    } as any} />);

    const trigger = screen.getByRole("button", { name: /scores/i });
    fireEvent.mouseEnter(trigger.parentElement?.parentElement as HTMLElement);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("columnheader", { name: /round 2 alice · moon/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /alice, round 1: plus 4, 4 total/i })).toBeVisible();
    expect(screen.getAllByText("DNF")).toHaveLength(2);
    fireEvent.click(trigger);
    fireEvent.mouseLeave(trigger.parentElement?.parentElement as HTMLElement);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("allows direct hand selection and confirms the exchange above the hand", () => {
    const players = new Map([
      ["alice", { id: "alice", name: "Alice", seat: 0, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: true }],
      ["bob", { id: "bob", name: "Bob", seat: 1, score: 0, connected: true, forfeited: false, nextRoundReady: false, cardCount: 4, isHost: false }],
    ]);
    const onExecute = vi.fn();
    const { container } = render(
      <__test.GameTable
        state={{ memoryMode: "assisted", turnDurationSeconds: 60, deadlineAt: 0, serverTime: 0, revision: 2, roomName: "Room", phase: "DRAWN", round: 1, targetScore: 100, currentPlayerId: "alice", caboCallerId: "", drawSource: "deck", mismatchPenaltyCardPending: false, discardLabel: "4H", discardRank: 4, deckCount: 40, players, winners: [] }}
        selfId="alice"
        players={[...players.values()]}
        core={{ knowledge: { slots: [null, null, null, null], opponents: [], held: { label: "2S", rank: 2 } } } as any}
        busy={false}
        selection="idle"
        targetId={undefined}
        events={[]}
        cardMotion={undefined}
        onSelection={vi.fn()}
        onTarget={vi.fn()}
        onExecute={onExecute}
        onConfirm={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const slots = container.querySelectorAll<HTMLButtonElement>(".hand-slot");
    const handHeading = container.querySelector(".hand-heading")!;
    const exchangeControls = container.querySelector(".exchange-controls")!;
    expect(handHeading.compareDocumentPosition(exchangeControls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(exchangeControls).toHaveClass("is-empty");
    fireEvent.click(slots[2]!);
    fireEvent.click(slots[0]!);
    expect(within(container).queryByRole("button", { name: /Position/ })).not.toBeInTheDocument();
    expect(container.querySelector(".exchange-controls")).toContainElement(within(container).getByRole("button", { name: "Confirm exchange" }));
    expect(exchangeControls).not.toHaveClass("is-empty");
    expect(within(container).getByRole("button", { name: "Confirm exchange" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Drawn card destination"), { target: { value: "1" } });
    fireEvent.click(within(container).getByRole("button", { name: "Confirm exchange" }));
    expect(onExecute).toHaveBeenCalledWith({ type: "replace", positions: [3, 1], replacementPosition: 1 });
  });

});
