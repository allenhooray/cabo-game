import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function roomChat(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: /^Chat/ });
  if (await trigger.isVisible()) {
    await trigger.click();
    return page.getByRole("dialog", { name: "Room chat" });
  }
  return page.getByRole("complementary", { name: "Room chat" });
}

async function closeChatIfDrawer(chat: Locator): Promise<void> {
  const close = chat.getByRole("button", { name: "Close chat" });
  if (await close.isVisible()) await close.click();
}

async function waitForRevisionToSettle(page: Page): Promise<void> {
  let lastRevision = "";
  let stableSince = Date.now();
  await expect.poll(async () => {
    const revision = await page.locator(".topbar").getAttribute("data-state-revision") ?? "";
    if (revision !== lastRevision) {
      lastRevision = revision;
      stableSince = Date.now();
    }
    return Date.now() - stableSince;
  }, { timeout: 5_000, intervals: [100] }).toBeGreaterThanOrEqual(400);
}

async function finishSimpleTurn(page: Page): Promise<void> {
  await page.getByRole("region", { name: "Your hand and actions" }).hover();
  await page.getByRole("button", { name: /Draw pile/ }).click();
  await page.getByRole("button", { name: "Discard drawn card" }).click();
  const skipPower = page.getByRole("button", { name: /^(Skip power|Skip)$/ });
  if (await skipPower.waitFor({ state: "visible", timeout: 1_000 }).then(() => true, () => false)) await skipPower.click();
  await expect(page.locator(".motion-layer")).toHaveCount(0);
}

test("primary button keeps its readable colors when hovered", async ({ page }) => {
  await page.goto("/");
  const button = page.getByRole("button", { name: "Create room" });
  const colors = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, text: style.color };
  });

  await button.hover();
  await page.waitForTimeout(200);

  await expect(button).toHaveCSS("background-color", colors.background);
  await expect(button).toHaveCSS("color", colors.text);
});

test("two isolated players create, join, start, and reconnect", async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await alice.goto("/");
  const aliceName = alice.getByRole("textbox", { name: "Player name" });
  await aliceName.fill("Alice");
  await expect(aliceName).toHaveValue("Alice");
  await aliceName.press("Tab");
  await alice.getByRole("button", { name: "Create room" }).click();
  await alice.getByRole("button", { name: "Create table" }).click();
  const roomId = await alice.locator(".lobby-copy .room-id").innerText();

  await bob.goto("/");
  const bobName = bob.getByRole("textbox", { name: "Player name" });
  await bobName.fill("Bob");
  await expect(bobName).toHaveValue("Bob");
  await bobName.press("Tab");
  await bob.getByRole("button", { name: "Join by code" }).click();
  await bob.getByLabel("Room code").fill(roomId);
  await bob.getByRole("button", { name: "Join table" }).click();

  await expect(alice.getByText("Bob")).toBeVisible();

  const aliceChat = await roomChat(alice);
  await aliceChat.getByRole("textbox", { name: "Message" }).fill("Ready to play?");
  await aliceChat.getByRole("button", { name: "Send" }).click();
  await expect(aliceChat).toContainText("You");
  await closeChatIfDrawer(aliceChat);

  const bobChat = await roomChat(bob);
  await expect(bobChat).toContainText("Ready to play?");
  await bobChat.getByRole("textbox", { name: "Message" }).fill("Ready!");
  await bobChat.getByRole("button", { name: "Send" }).click();
  await expect(bobChat).toContainText("You");
  await closeChatIfDrawer(bobChat);

  const aliceReply = await roomChat(alice);
  await expect(aliceReply).toContainText("Ready!");
  await closeChatIfDrawer(aliceReply);

  await alice.getByRole("button", { name: "Start game" }).click();
  await expect(alice.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
  await expect(bob.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
  await expect(alice.getByRole("region", { name: "Your hand and actions" })).toContainText("Alice · 0 pts");
  await alice.getByRole("button", { name: "Rules" }).hover();
  await expect(alice.getByRole("complementary", { name: "Quick rules" })).toBeVisible();
  await expect(alice.getByRole("link", { name: /Read the full rules/i })).toHaveAttribute("href", "/en-US/docs/rules/");
  const mobileLayout = (alice.viewportSize()?.width ?? 0) <= 760;
  const aliceStarts = await alice.getByRole("heading", { name: "Draw with intention." }).isVisible();
  if (aliceStarts === mobileLayout) {
    await finishSimpleTurn(aliceStarts ? alice : bob);
  }
  await expect(alice.getByRole("heading", { name: mobileLayout ? "Bob's turn" : "Draw with intention." })).toBeVisible();
  await alice.getByRole("region", { name: "Your hand and actions" }).hover();
  await expect(alice).toHaveScreenshot("game-table.png", {
    animations: "disabled",
    mask: [alice.locator(".room-id, .card-memory, .playing-card:not(.card-back), .turn-timer, .next-round-timer, .chat-message time")],
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

  await actor.locator(".hand-slot").first().click();
  await actor.locator(".hand-slot").nth(1).click();
  await expect(actor.getByRole("button", { name: "Confirm exchange" })).toBeDisabled();
  await actor.getByLabel("Drawn card destination").selectOption("2");
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

for (const mode of ["classic", "assisted"] as const) {
  test(`${mode}: invite, authoritative memory, reconnect and automatic next round`, async ({ browser }) => {
    test.setTimeout(60_000);
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await host.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }));
    await host.goto("/");
    await host.getByRole("button", { name: "Create room" }).click();
    await host.getByLabel("Memory mode").selectOption(mode);
    await host.getByLabel("Step timer").selectOption("0");
    await host.getByRole("button", { name: "Create table" }).click();
    const roomId = await host.locator(".lobby-copy .room-id").innerText();
    await host.locator(".share-room-trigger").click();
    await host.getByRole("button", { name: "Copy room code" }).click();
    await expect(host.getByLabel("Copy manually")).toHaveValue(roomId);
    await host.getByRole("button", { name: "Copy invite link" }).click();
    await expect(host.getByLabel("Copy manually")).toHaveValue(/server=/);
    const link = await host.getByLabel("Copy manually").inputValue();
    await host.locator(".share-room-trigger").click();
    await guest.goto(link);
    await expect(guest.getByLabel("Room code")).toHaveValue(roomId);
    await expect(guest.getByText(/Invitation server:/)).toContainText("http://127.0.0.1:2567");
    await guest.getByRole("button", { name: "Join table" }).click();
    await expect(guest.locator(".lobby-copy .room-id")).toHaveText(roomId);
    expect(new URL(guest.url()).search).toBe("");
    await expect.poll(() => guest.evaluate(() => localStorage.getItem("cabo.server.v1"))).toBe("http://127.0.0.1:2567");
    await host.getByRole("button", { name: "Start game" }).click();
    await expect(host.locator(".hand-slot.known")).toHaveCount(2);
    if (mode === "classic") await expect(host.locator(".hand-slot.known")).toHaveCount(0, { timeout: 7000 });
    await host.reload();
    await expect(host.getByText("Live", { exact: true })).toBeVisible();
    await expect(host.locator(".hand-slot.known")).toHaveCount(mode === "classic" ? 0 : 2);
    if (mode === "classic") {
      const session = await host.evaluate(() => JSON.parse(localStorage.getItem("cabo.session.v1")!));
      expect(session.knowledge).toBeUndefined();
    }
    const caller = await host.getByRole("button", { name: "Call Cabo", exact: true }).isVisible() ? host : guest;
    const finalPlayer = caller === host ? guest : host;
    await caller.getByRole("button", { name: "Call Cabo", exact: true }).click();
    const confirmation = caller.getByRole("dialog", { name: "Call Cabo?" });
    await expect(confirmation).toContainText("strictly lowest");
    await expect(confirmation).toContainText(mode === "classic" ? "4 cards" : "Known subtotal");
    // Reconnection changes the authoritative revision and invalidates a pending declaration.
    const beforeReconnect = Number(await caller.locator(".topbar").getAttribute("data-state-revision"));
    await finalPlayer.reload();
    await expect(finalPlayer.getByText("Live", { exact: true })).toBeVisible();
    await expect.poll(async () => Number(await caller.locator(".topbar").getAttribute("data-state-revision"))).toBeGreaterThanOrEqual(beforeReconnect + 2);
    await expect(confirmation).not.toBeVisible();
    await Promise.all([waitForRevisionToSettle(caller), waitForRevisionToSettle(finalPlayer)]);
    await caller.getByRole("button", { name: "Call Cabo", exact: true }).click();
    await confirmation.getByRole("button", { name: "Call Cabo", exact: true }).click();
    await finalPlayer.getByRole("button", { name: /Draw pile/ }).click();
    await finalPlayer.locator(".hand-slot").first().click();
    await finalPlayer.getByRole("button", { name: "Confirm exchange" }).click();
    await expect(host.getByRole("button", { name: "Ready for next round" })).toBeVisible();
    await expect(host.getByRole("dialog").getByRole("timer")).toContainText(/Next round in (19|20)s/);
    await expect(host.getByRole("button", { name: "Ready for next round" })).not.toBeVisible({ timeout: 23_000 });
    await expect(guest.getByRole("button", { name: "Ready for next round" })).not.toBeVisible({ timeout: 23_000 });
    await expect(host.locator(".hand-slot.known")).toHaveCount(2);
    await Promise.all([hostContext.close(), guestContext.close()]);
  });
}

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

test("host can fill a private lobby with four Bots and replace one", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Player name" }).fill("Bot Host");
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("button", { name: "Private" }).click();
  await page.getByLabel("Six-digit password").fill("123456");
  await page.getByRole("button", { name: "Create table" }).click();
  await expect(page.locator(".lobby-panel")).toBeVisible();
  await page.getByRole("combobox", { name: "Add Bot" }).selectOption("mnemo");
  for (let count = 1; count <= 4; count++) {
    await page.getByRole("button", { name: "Add Bot" }).click();
    await expect(page.locator(".seat.seat-filled")).toHaveCount(count + 1);
  }
  await expect(page.getByRole("button", { name: "Add Bot" })).toBeDisabled();
  await page.getByRole("button", { name: "Remove" }).first().click();
  await expect(page.locator(".seat.seat-filled")).toHaveCount(4);
  await page.getByRole("button", { name: "Add Bot" }).click();
  await expect(page.locator(".seat.seat-filled")).toHaveCount(5);
  await page.getByRole("button", { name: "Start game" }).click();
  await expect(page.getByRole("region", { name: "Your hand and actions" })).toBeVisible();
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
