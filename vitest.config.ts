import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // 2026-06-29: pin pool=forks. vitest default is `threads` which
    // shares one Node module graph across all worker threads in a
    // file. Several mathran modules hold module-level singletons —
    // GoalDaemon registry (src/core/goal/daemon.ts), MCP registry,
    // various fs lock maps — and `threads` lets test files race on
    // those singletons across parallel files. Symptoms were flaky
    // failures (different test fails on each run) and accumulating
    // "[goal-daemon] boot-resume: N active goal(s) to resume" where
    // N grew across files. Forks give each file a fresh process so
    // module-level state stays isolated.
    pool: "forks",
    include: [
      "src/**/*.{test,spec}.{js,ts,tsx}",
      // v0.17 follow-up: include the SPA's own lib tests (`web/src/lib/*.test.ts`)
      // so KaTeX / markdown preprocess behaviour stays covered.
      "web/src/**/*.{test,spec}.{js,ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "_tasks/**",
      "web/node_modules/**",
      "dist/**",
    ],
  },
});
