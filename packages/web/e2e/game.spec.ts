import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("two isolated players create, join, start, and reconnect", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await alice.goto("/");
  await alice.getByRole("textbox", { name: "Player name" }).fill("Alice");
  await alice.getByRole("button", { name: "Create room" }).click();
  await alice.getByRole("button", { name: "Create table" }).click();
  const roomId = await alice.locator(".lobby-copy .room-id").innerText();

  await bob.goto("/");
  await bob.getByRole("textbox", { name: "Player name" }).fill("Bob");
  await bob.getByRole("button", { name: "Join by code" }).click();
  await bob.getByLabel("Room code").fill(roomId);
  await bob.getByRole("button", { name: "Join table" }).click();

  await expect(alice.getByText("Bob")).toBeVisible();
  await alice.getByRole("button", { name: "Start game" }).click();
  await expect(alice.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
  await expect(bob.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
  await expect(alice.getByRole("region", { name: "Your hand and actions" })).toContainText("Alice · 0 pts");
  await alice.getByRole("button", { name: "Rules" }).hover();
  await expect(alice.getByRole("complementary", { name: "Quick rules" })).toBeVisible();
  await expect(alice.getByRole("link", { name: /Read the full rules/i })).toHaveAttribute("href", "/docs/rules/");
  await alice.getByRole("region", { name: "Your hand and actions" }).hover();
  await expect(alice).toHaveScreenshot("game-table.png", {
    animations: "disabled",
    mask: [alice.locator(".room-code, .card-memory, .playing-card:not(.card-back)")],
    maskColor: "#777777",
    maxDiffPixelRatio: 0.02,
  });

  const aliceActs = await alice.getByRole("heading", { name: "Draw with intention." }).isVisible();
  const actor = aliceActs ? alice : bob;
  const observer = aliceActs ? bob : alice;
  await actor.getByRole("button", { name: /Draw pile/ }).click();
  await expect(actor.locator(".decision-card.occupied")).toBeVisible();
  await expect(observer.locator(".opponent-decision.occupied")).toBeVisible();
  await expect(observer.getByRole("complementary", { name: "Recent activity" })).toContainText("drew a hidden card");

  await actor.getByRole("button", { name: "Replace cards" }).click();
  await actor.locator(".hand-slot").first().click();
  await actor.locator(".hand-slot").nth(1).click();
  await actor.getByRole("button", { name: "Position 1" }).click();
  await actor.getByRole("button", { name: "Confirm exchange" }).click();
  await expect(observer.getByRole("complementary", { name: "Recent activity" })).toContainText(/positions 1, 2|did not match/);
  const mismatchPlacement = actor.getByRole("button", { name: "Left end" });
  if (await mismatchPlacement.isVisible()) await mismatchPlacement.click();

  await alice.reload();
  await expect(alice.getByText("Live")).toBeVisible();
  await expect(alice.getByRole("region", { name: "Your hand and actions" })).toBeVisible();

  const accessibility = await new AxeBuilder({ page: alice }).analyze();
  expect(accessibility.violations.filter((violation) => violation.impact === "critical")).toEqual([]);

  await aliceContext.close();
  await bobContext.close();
});

test("a five-player room fills every seat and starts", async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 5 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [host, ...guests] = pages;

  await host.goto("/");
  await host.getByRole("textbox", { name: "Player name" }).fill("Player 1");
  await host.getByRole("button", { name: "Create room" }).click();
  await host.getByRole("button", { name: "Create table" }).click();
  const roomId = await host.locator(".lobby-copy .room-id").innerText();

  for (const [index, guest] of guests.entries()) {
    await guest.goto("/");
    await guest.getByRole("textbox", { name: "Player name" }).fill(`Player ${index + 2}`);
    await guest.getByRole("button", { name: "Join by code" }).click();
    await guest.getByLabel("Room code").fill(roomId);
    await guest.getByRole("button", { name: "Join table" }).click();
  }

  await expect(host.locator(".seat.seat-filled")).toHaveCount(5);
  await host.getByRole("button", { name: "Start game" }).click();
  await expect(host.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
  await Promise.all(contexts.map((context) => context.close()));
});

test("private room requires its six-digit password", async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/");
  await host.getByRole("textbox", { name: "Player name" }).fill("Host");
  await host.getByRole("button", { name: "Create room" }).click();
  await host.getByRole("button", { name: "Private" }).click();
  await host.getByLabel("Six-digit password").fill("123456");
  await host.getByRole("button", { name: "Create table" }).click();
  const roomId = await host.locator(".lobby-copy .room-id").innerText();

  await guest.goto("/");
  await guest.getByRole("textbox", { name: "Player name" }).fill("Guest");
  await guest.getByRole("button", { name: "Join by code" }).click();
  await guest.getByLabel("Room code").fill(roomId);
  await guest.getByLabel(/Password/).fill("000000");
  await guest.getByRole("button", { name: "Join table" }).click();
  await expect(guest.getByRole("alert")).toContainText(/password/i);
  await guest.getByLabel(/Password/).fill("123456");
  await guest.getByRole("button", { name: "Join table" }).click();
  await expect(guest.getByText(/The table is almost ready/)).toBeVisible();

  await hostContext.close();
  await guestContext.close();
});
