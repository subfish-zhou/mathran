/**
 * Playwright config — single Chromium project, one worker, baseURL points
 * at a `mathran serve` instance spun up automatically by `webServer`.
 *
 * The spawned server uses a *fresh* MATHRAN_WORKSPACE so the e2e suite is
 * deterministic and never touches the dev workspace.
 *
 * Run locally:
 *   npm run e2e
 *
 * Or against a server you started yourself:
 *   MATHRAN_BASE_URL=http://127.0.0.1:7878 npx playwright test e2e
 */
import { defineConfig, devices } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";

const BASE_URL = process.env.MATHRAN_BASE_URL ?? "http://127.0.0.1:7879";
const E2E_WORKSPACE = path.join(os.tmpdir(), "mathran-e2e-workspace");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Only spin up the local server when MATHRAN_BASE_URL is unset.
  webServer: process.env.MATHRAN_BASE_URL
    ? undefined
    : {
        command: "node dist/cli/index.js serve --host 127.0.0.1 --port 7879",
        url: `${BASE_URL}/api/health`,
        timeout: 30_000,
        reuseExistingServer: !process.env.CI,
        env: {
          MATHRAN_WORKSPACE: E2E_WORKSPACE,
          NODE_ENV: "test",
        },
      },
});
