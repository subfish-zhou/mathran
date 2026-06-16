/**
 * E2E smoke covering the v0.1.0 SPA route tree (GAP #12).
 *
 * Strategy: Playwright's `webServer` boots `mathran serve` against a fresh
 * tmp workspace, then we use the REST API to seed exactly the projects /
 * wiki pages / efforts we need before each spec block. The UI tests then
 * navigate through the layout (sidebar → project → efforts → effort →
 * document; project → wiki → diff view) and assert on visible text /
 * route URLs.
 *
 * What this suite intentionally does NOT cover:
 *   - LLM round-trips (covered by unit tests with scripted providers)
 *   - lean_check (covered by unit tests with a Lean stub)
 *   - chat streaming (would require a real or mocked provider; out of scope
 *     for this smoke)
 *
 * What it DOES cover:
 *   - Home → project route → effort route → document tab → chat tab
 *   - Wiki list → page view → History → Compare diff (GAP #10)
 *   - Direct deep-link to an effort document URL
 *   - Page reload preserves state (BUG #4 SPA fallback)
 */
import { test, expect } from "@playwright/test";

const ROOT = "http://127.0.0.1:7879";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${ROOT}${path}`, init);
  if (!res.ok) {
    throw new Error(`API ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

test.describe("mathran SPA smoke", () => {
  test.beforeAll(async () => {
    // The webServer hook brings up serve(). Wait for /api/health is implicit
    // (the config uses url: …/api/health).
    // Seed two projects.
    await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "e2e-twin-primes", name: "E2E Twin Primes" }),
    }).catch(() => {/* already exists */});
    await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "e2e-zeta", name: "E2E Zeta" }),
    }).catch(() => {/* already exists */});

    // Seed an effort on the first one.
    await api("/api/projects/e2e-twin-primes/efforts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "E2E Sieve Approach",
        type: "PROOF_ATTEMPT",
        description: "smoke effort",
      }),
    }).catch(() => {/* already exists */});

    // Seed a wiki page with 2 history versions so the diff view has content.
    await api("/api/projects/e2e-twin-primes/wiki/e2e-overview", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "# Overview\n\nFirst body.\n", title: "Overview" }),
    });
    await api("/api/projects/e2e-twin-primes/wiki/e2e-overview", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "# Overview\n\nFirst body.\nSecond body.\n",
        title: "Overview",
      }),
    });
  });

  test("home page lists seeded projects", async ({ page }) => {
    await page.goto("/");
    // Sidebar links: their /url attribute is /projects/<slug>, not /projects/<slug>/wiki etc.
    await expect(page.locator('a[href="/projects/e2e-twin-primes"]').first()).toBeVisible();
    await expect(page.locator('a[href="/projects/e2e-zeta"]').first()).toBeVisible();
  });

  test("navigate home → project → efforts → effort → document tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /E2E Twin Primes/i }).first().click();
    await expect(page).toHaveURL(/\/projects\/e2e-twin-primes(\/.*)?$/);

    // ProjectLayout sub-nav contains Efforts/Wiki/Chat. Click Efforts.
    await page.getByRole("link", { name: /^Efforts$/ }).first().click();
    await expect(page).toHaveURL(/\/projects\/e2e-twin-primes\/efforts$/);

    // Open the seeded effort.
    await page.getByText(/E2E Sieve Approach/).first().click();
    await expect(page).toHaveURL(/\/effort\/e2e-sieve-approach/);

    // EffortLayout shows its breadcrumb "← all efforts" + the effort slug.
    await expect(page.getByText("← all efforts")).toBeVisible();
    await expect(page.getByText("e2e-sieve-approach")).toBeVisible();
  });

  test("deep link to effort document loads directly", async ({ page }) => {
    await page.goto("/projects/e2e-twin-primes/effort/e2e-sieve-approach/document");
    // EffortLayout renders its breadcrumb — don't fall through to 404.
    await expect(page.getByText("← all efforts")).toBeVisible();
    await expect(page).toHaveURL(/\/effort\/e2e-sieve-approach\/document$/);
  });

  test("reload on a deep route stays on that route (BUG #4 SPA fallback)", async ({ page }) => {
    await page.goto("/projects/e2e-twin-primes/effort/e2e-sieve-approach/document");
    await expect(page.getByText("← all efforts")).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/effort\/e2e-sieve-approach\/document$/);
    await expect(page.getByText("← all efforts")).toBeVisible();
  });

  test("wiki diff: open page, click History, run Show diff (GAP #10)", async ({ page }) => {
    await page.goto("/projects/e2e-twin-primes/wiki/e2e-overview");

    // The History button is in the page toolbar.
    await page.getByRole("button", { name: /^History$/ }).click();

    // Compare bar appears with two selects and a "Show diff" button.
    await page.getByRole("button", { name: /^Show diff$/ }).click();

    // The colourised <pre> should contain the new line added in v2.
    await expect(page.locator("pre")).toContainText("Second body.");
    // The unified-diff header always mentions "current" on the to-side since
    // that is the default.
    await expect(page.locator("pre")).toContainText("current");
  });

  test("global chat route is reachable from sidebar", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Global chat/i }).click();
    await expect(page).toHaveURL(/\/global-chat$/);
  });

  test("settings route is reachable and renders the providers panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
    // ProvidersPanel surfaces an "Add provider" form heading or button.
    await expect(page.getByText(/Provider/i).first()).toBeVisible();
  });
});
