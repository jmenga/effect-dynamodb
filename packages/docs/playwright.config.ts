import { defineConfig } from "@playwright/test"

const BASE = "/effect-dynamodb"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: `http://localhost:4399${BASE}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 4399",
    url: `http://localhost:4399${BASE}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
})
