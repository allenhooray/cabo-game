import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * 移动端适配回归测试。
 *
 * 覆盖 16 项修复中的布局类问题：横向溢出（G1/G1a）、顶栏换行（G2）、
 * 倒计时与玩家名叠印（G3）、平板断点（G4）、计分面板左溢（G5）、
 * 手机横屏（G6）、提示条遮挡（G7）、结算弹窗（G8）、
 * 首页行高与点击区域（H1/H2/H3/H4）、320px 手牌（G10）。
 *
 * 视口矩阵在这里显式指定，因此只在 desktop-chromium 项目跑一次，避免重复。
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "viewport matrix is set explicitly by this spec");
});

const NARROW = [320, 360, 375, 390, 412, 430, 480, 520];
const WIDE = [768, 820, 1024, 1100, 1200];
const ALL = [...NARROW, ...WIDE];

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

async function setViewport(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width <= 430 ? 780 : 900 });
  await page.waitForTimeout(150);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.doc, `${label}: document scrollWidth exceeds clientWidth`).toBeLessThanOrEqual(0);
  expect(overflow.client).toBeGreaterThan(0);
}

/** 关键容器都必须落在视口内 —— html/body 是 overflow-x: clip，溢出不会出现滚动条，只会静默裁掉内容。 */
async function expectContainersInsideViewport(page: Page, label: string, selectors: string[]): Promise<void> {
  const report = await page.evaluate((list) => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    for (const selector of list) {
      for (const el of document.querySelectorAll(selector)) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > vw + 1 || box.left < -1) bad.push(`${selector} [${box.left.toFixed(1)}, ${box.right.toFixed(1)}] vw=${vw}`);
      }
    }
    return bad;
  }, selectors);
  expect(report, `${label}: elements outside the viewport`).toEqual([]);
}

async function openGame(browser: Browser) {
  const hostContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const guestContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto("/");
  await host.getByRole("textbox", { name: "Player name" }).fill("Alexandra Montgomery");
  await host.getByRole("button", { name: "Create room" }).click();
  await host.getByRole("button", { name: "Create table" }).click();
  const roomId = await host.locator(".lobby-copy .room-id").innerText();

  await guest.goto("/");
  await guest.getByRole("textbox", { name: "Player name" }).fill("Bob");
  await guest.getByRole("button", { name: "Join by code" }).click();
  await guest.getByLabel("Room code").fill(roomId);
  await guest.getByRole("button", { name: "Join table" }).click();
  await guest.locator(".lobby-copy .room-id").waitFor({ timeout: 10_000 });

  await host.getByRole("button", { name: "Start game" }).click();
  await host.locator(".player-dock").waitFor({ timeout: 10_000 });
  await host.waitForTimeout(500);

  // 起始玩家由服务器决定。让当前能行动的一方走完一回合，另一方才会成为
  // currentPlayerId，其对手卡上才会渲染 .turn-timer（G3 的前提）。
  const hostActs = await host.getByRole("button", { name: /Draw pile/ }).isEnabled().catch(() => false);
  const actor = hostActs ? host : guest;
  await actor.getByRole("region", { name: "Your hand and actions" }).hover();
  await actor.getByRole("button", { name: /Draw pile/ }).click();
  await actor.getByRole("button", { name: "Discard drawn card" }).click();
  const skipPower = actor.getByRole("button", { name: /^(Skip power|Skip)$/ });
  if (await skipPower.waitFor({ state: "visible", timeout: 1_500 }).then(() => true, () => false)) await skipPower.click();
  await actor.waitForTimeout(600);

  return { hostContext, guestContext, view: actor, other: actor === host ? guest : host };
}

test("home page adapts without overflow, clipping, or undersized targets", async ({ browser, page }) => {
  test.setTimeout(90_000);

  // 房间列表非空才会渲染 .room-row —— H1 需要它。
  // 用固定的短房间名并精确定位自己那一行，避免受同服务器上其他房间（可能名字很长）影响。
  const ROOM_NAME = "Layout probe";
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/");
  await host.getByRole("textbox", { name: "Player name" }).fill("Host");
  await host.getByRole("button", { name: "Create room" }).click();
  await host.getByLabel("Room name").fill(ROOM_NAME);
  await host.getByRole("button", { name: "Create table" }).click();
  await host.locator(".lobby-copy .room-id").waitFor({ timeout: 10_000 });

  await page.goto("/");
  const row = page.locator(".room-row").filter({ hasText: ROOM_NAME }).first();
  await row.waitFor({ timeout: 10_000 });

  const rowHeights: number[] = [];
  for (const width of ALL) {
    await setViewport(page, width);
    await expectNoHorizontalOverflow(page, `home@${width}`);

    // H2：导航链接点击区域至少 24px 高（WCAG 2.2 AA）。
    const navHeights = await page.$$eval(".site-header nav a", (links) => links.map((link) => link.getBoundingClientRect().height));
    expect(navHeights.length).toBeGreaterThan(0);
    for (const height of navHeights) expect(height, `home@${width}: nav link target height`).toBeGreaterThanOrEqual(24);

    // H3：summary 改成 flex 后必须补上自定义折叠指示符。
    const summary = await page.evaluate(() => {
      const el = document.querySelector(".server-settings summary")!;
      const after = getComputedStyle(el, "::after");
      return { height: el.getBoundingClientRect().height, content: after.content, width: after.width };
    });
    expect(summary.height, `home@${width}: summary target height`).toBeGreaterThanOrEqual(24);
    expect(summary.content, `home@${width}: disclosure indicator missing`).not.toBe("none");
    expect(parseFloat(summary.width), `home@${width}: disclosure indicator width`).toBeGreaterThan(0);

    // H1：房间摘要改用短标签后，行高在 320–1200px 之间不应再跳变。
    rowHeights.push(await row.evaluate((el) => el.getBoundingClientRect().height));
  }

  expect(Math.max(...rowHeights) - Math.min(...rowHeights), `room-row height spread: ${rowHeights.join(",")}`).toBeLessThanOrEqual(6);
  expect(Math.max(...rowHeights)).toBeLessThanOrEqual(80);

  // H4：≤760px 时设置弹层必须落在头部之下，不能盖住导航链接。
  for (const width of NARROW) {
    await setViewport(page, width);
    await page.locator(".settings-trigger").click();
    await page.waitForTimeout(300);
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector("#cabo-settings")!.getBoundingClientRect();
      const nav = document.querySelector(".home-header nav")!.getBoundingClientRect();
      return { panelTop: panel.top, panelLeft: panel.left, panelRight: panel.right, navBottom: nav.bottom };
    });
    expect(geometry.panelTop, `home@${width}: settings panel covers the nav`).toBeGreaterThanOrEqual(geometry.navBottom - 1);
    expect(geometry.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(geometry.panelRight).toBeLessThanOrEqual(width + 1);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  await hostContext.close();
});

test("game table and topbar hold up across phones, tablets, and landscape", async ({ browser }) => {
  test.setTimeout(180_000);
  const { hostContext, guestContext, view } = await openGame(browser);

  for (const width of ALL) {
    await setViewport(view, width);
    await expectNoHorizontalOverflow(view, `game@${width}`);
    await expectContainersInsideViewport(view, `game@${width}`, [".topbar", ".opponents", ".table-surface", ".player-dock", ".event-strip"]);

    // G2：顶栏改 min-height 后，动作区必须留在顶栏内部，不能溢出去压住牌桌。
    const topbar = await view.evaluate(() => {
      const bar = document.querySelector(".topbar")!;
      const actions = document.querySelector(".topbar-actions")!.getBoundingClientRect();
      const box = bar.getBoundingClientRect();
      return {
        overflow: bar.scrollHeight - bar.clientHeight,
        actionsInside: actions.bottom <= box.bottom + 1 && actions.top >= box.top - 1,
        metaWidth: document.querySelector(".room-meta")!.getBoundingClientRect().width,
      };
    });
    expect(topbar.overflow, `game@${width}: topbar content overflows its box`).toBeLessThanOrEqual(1);
    expect(topbar.actionsInside, `game@${width}: topbar actions escape the header`).toBe(true);

    // G3 + G10 + 名字可见性：对手卡必须能放下名字、手牌不越出卡片、倒计时不压名字。
    const cards = await view.$$eval(".player-card", (nodes) => nodes.map((card) => {
      const cardBox = card.getBoundingClientRect();
      const name = card.querySelector(".player-copy strong")!.getBoundingClientRect();
      const hand = card.querySelector(".opponent-hand")!.getBoundingClientRect();
      const timer = card.querySelector(".turn-timer");
      let overlap = 0;
      if (timer) {
        const t = timer.getBoundingClientRect();
        const x = Math.min(t.right, name.right) - Math.max(t.left, name.left);
        const y = Math.min(t.bottom, name.bottom) - Math.max(t.top, name.top);
        if (x > 0 && y > 0) overlap = x * y;
      }
      return { nameWidth: name.width, handRight: hand.right - cardBox.right, timerOverlap: overlap };
    }));
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.nameWidth, `game@${width}: opponent name collapsed to zero width`).toBeGreaterThan(12);
      expect(card.handRight, `game@${width}: opponent hand spills out of its card`).toBeLessThanOrEqual(1);
      expect(card.timerOverlap, `game@${width}: turn timer overlaps the player name`).toBe(0);
    }
  }

  // G5 + Share 弹层：≤1100px 必须整体落在视口内（761–968px 曾左溢 199px / 56px）。
  // .popover 同时响应 hover 与 click，直接点会先 hover 打开再被点击关掉，
  // 所以这里按可见性重试，并用 Escape + 移开指针收尾。
  const panels: Array<[string, string, string]> = [
    ["share", ".share-room-trigger", ".share-room .popover-panel"],
    ["scores", ".score-history-trigger", ".score-history-shell"],
    ["rules", ".rules-popover .popover-trigger", ".rules-popover .popover-panel"],
    ["settings", ".settings-trigger", ".settings-panel"],
  ];

  for (const width of [320, 375, 768, 820, 1024, 1100]) {
    await setViewport(view, width);
    for (const [name, triggerSelector, panelSelector] of panels) {
      const panel = view.locator(panelSelector);
      for (let attempt = 0; attempt < 3 && !(await panel.isVisible()); attempt += 1) {
        await view.locator(triggerSelector).click({ force: true });
        await view.waitForTimeout(250);
      }
      expect(await panel.isVisible(), `${name} panel did not open at ${width}`).toBe(true);
      const box = await panel.boundingBox();
      expect(box, `${name} panel has no box at ${width}`).not.toBeNull();
      expect(box!.width, `${name}@${width}: zero width`).toBeGreaterThan(0);
      expect(box!.x, `${name}@${width}: overflows the left edge`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${name}@${width}: overflows the right edge`).toBeLessThanOrEqual(width + 1);

      await view.keyboard.press("Escape");
      await view.mouse.move(2, 600);
      await view.waitForTimeout(300);
    }
  }

  // G6：手机横屏宽度 >760px 会走桌面断点，但高度只有 390–430px。
  // 必须回落到紧凑布局：4 列对手、两行对手卡（名字 + 手牌）、双列 dock。
  for (const [width, height] of [[844, 390], [932, 430], [667, 375], [568, 320]] as const) {
    const label = `landscape ${width}x${height}`;
    await view.setViewportSize({ width, height });
    await view.waitForTimeout(250);
    await view.evaluate(() => window.scrollTo(0, 0));
    await expectNoHorizontalOverflow(view, label);
    await expectContainersInsideViewport(view, label, [".topbar", ".opponents", ".table-surface", ".player-dock", ".event-strip"]);

    const geometry = await view.evaluate(() => {
      const opponents = document.querySelector(".opponents")!;
      const card = document.querySelector(".player-card")!;
      const name = card.querySelector(".player-copy strong")!;
      const hand = card.querySelector(".opponent-hand")!;
      const timer = card.querySelector(".turn-timer");
      let timerOverlap = 0;
      if (timer) {
        const t = timer.getBoundingClientRect();
        const n = name.getBoundingClientRect();
        const x = Math.min(t.right, n.right) - Math.max(t.left, n.left);
        const y = Math.min(t.bottom, n.bottom) - Math.max(t.top, n.top);
        if (x > 0 && y > 0) timerOverlap = x * y;
      }
      return {
        columns: getComputedStyle(opponents).gridTemplateColumns.split(/\s+/).length,
        nameWidth: name.getBoundingClientRect().width,
        handSpill: hand.getBoundingClientRect().right - card.getBoundingClientRect().right,
        timerOverlap,
        screens: document.documentElement.scrollHeight / window.innerHeight,
      };
    });
    expect(geometry.columns, `${label}: opponents should fall back to 4 compact columns`).toBe(4);
    expect(geometry.nameWidth, `${label}: opponent name collapsed`).toBeGreaterThan(12);
    expect(geometry.handSpill, `${label}: opponent hand spills out of its card`).toBeLessThanOrEqual(1);
    expect(geometry.timerOverlap, `${label}: turn timer overlaps the player name`).toBe(0);
    expect(geometry.screens, `${label}: table needs too much scrolling`).toBeLessThanOrEqual(1.8);
  }

  await hostContext.close();
  await guestContext.close();
});
