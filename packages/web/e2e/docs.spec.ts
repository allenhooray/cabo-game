import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages = [
  { path: "/", title: /online memory card game/i, canonical: "https://cabo.human404.link/" },
  { path: "/docs/rules/", title: /how to play cabo/i, canonical: "https://cabo.human404.link/docs/rules/" },
  { path: "/docs/cli/", title: /cabo cli guide/i, canonical: "https://cabo.human404.link/docs/cli/" },
  { path: "/docs/agent/", title: /cabo agent guide/i, canonical: "https://cabo.human404.link/docs/agent/" },
];

test("public pages expose canonical and sharing metadata", async ({ page }) => {
  for (const entry of pages) {
    await page.goto(entry.path);
    await expect(page).toHaveTitle(entry.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", entry.canonical);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", entry.canonical);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://cabo.human404.link/cabo-social.png");
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  }
});

test("documentation pages are navigable, responsive, and accessible", async ({ page }) => {
  for (const entry of pages.slice(1)) {
    await page.goto(entry.path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "critical")).toEqual([]);
  }

  await page.goto("/docs/agent/");
  await expect(page.getByRole("heading", { name: "Install the Cabo Skill" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cabo Skill" })).toHaveAttribute("href", "https://github.com/allenhooray/cabo-game/blob/master/skills/cabo/SKILL.md");
});

test("crawler resources and the social image are public", async ({ page, request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  await expect(robots.text()).resolves.toContain("Sitemap: https://cabo.human404.link/sitemap.xml");

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.ok()).toBe(true);
  const sitemapText = await sitemap.text();
  for (const entry of pages) expect(sitemapText).toContain(`<loc>${entry.canonical}</loc>`);

  const llms = await request.get("/llms.txt");
  expect(llms.ok()).toBe(true);
  const llmsText = await llms.text();
  expect(llmsText).toContain("# Cabo");
  expect(llmsText).toContain("https://cabo.human404.link/docs/agent/");
  expect(llmsText).toContain("npx skills add allenhooray/cabo-game --skill cabo -g");
  expect(llmsText).toContain("npm install --global @cabo-game/cli");
  expect(llmsText).toContain("https://github.com/allenhooray/cabo-game/blob/master/skills/cabo/SKILL.md");
  expect(llmsText).toContain("## Copyable match prompt");
  for (const term of ["legalActions", "reconnect", "MATCH_RESULT", "shutdown"]) expect(llmsText).toContain(term);
  expect(llmsText).not.toContain("llms-full.txt");

  await page.goto("/");
  const dimensions = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/cabo-social.png";
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(dimensions).toEqual({ width: 1200, height: 630 });
});
