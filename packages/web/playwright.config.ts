import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], colorScheme: "dark" } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], colorScheme: "light", reducedMotion: "reduce" } },
  ],
  webServer: [
    {
      command: "pnpm --filter @cabo/server start",
      url: "http://127.0.0.1:2567/rooms",
      reuseExistingServer: true,
      timeout: 20_000,
      env: { WEB_ORIGINS: "http://127.0.0.1:5173" },
    },
    {
      command: "pnpm --filter @cabo/web dev --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
      timeout: 20_000,
    },
  ],
});
