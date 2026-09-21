import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

describe("Cabo home", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("renders the entry actions and empty public room state", async () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /keep the lowest hand/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create room/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/docs/rules/");
    expect(screen.getByRole("link", { name: "CLI" })).toHaveAttribute("href", "/docs/cli/");
    expect(screen.getByRole("link", { name: "Agent" })).toHaveAttribute("href", "/docs/agent/");
    await waitFor(() => expect(screen.getByText(/no public rooms are waiting/i)).toBeInTheDocument());
  });
});
