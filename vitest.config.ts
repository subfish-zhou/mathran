import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
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
