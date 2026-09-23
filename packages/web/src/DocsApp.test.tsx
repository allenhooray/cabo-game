import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DocsApp, isDocPage, type DocPage } from "./DocsApp.js";

describe("Cabo documentation", () => {
  afterEach(cleanup);

  it.each([
    ["rules", /keep the lowest hand/i, /strictly lower hand/i],
    ["cli", /play cabo from the cli/i, /create private \[target\]/i],
    ["agent", /drive cabo from any language/i, /state_uncertain/i],
  ] satisfies Array<[DocPage, RegExp, RegExp]>)
  ("renders the %s page with shared navigation", (page, heading, detail) => {
    render(<DocsApp page={page} />);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(navigation).toBeInTheDocument();
    expect(Array.from(navigation.querySelectorAll("a"), (link) => link.textContent)).toEqual(["Play", "Rules", "CLI", "Agent"]);
    expect(screen.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: page === "cli" ? "CLI" : page[0]!.toUpperCase() + page.slice(1) })).toHaveAttribute("aria-current", "page");
  });

  it("accepts only known documentation page identifiers", () => {
    expect(isDocPage("rules")).toBe(true);
    expect(isDocPage("unknown")).toBe(false);
    expect(isDocPage(undefined)).toBe(false);
  });
});
