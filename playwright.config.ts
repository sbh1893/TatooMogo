import { defineConfig } from "@playwright/test";

// End-to-end checks against the local dev server (local D1/R2, dev admin bypass from .dev.vars).
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  webServer: { command: "npm run dev -- --port 5173 --strictPort", url: "http://localhost:5173", reuseExistingServer: true, timeout: 120_000 },
});
