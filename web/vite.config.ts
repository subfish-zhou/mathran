import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPA for the mathran local workstation. Build output lands in ../dist/web so
// the Hono `serveStatic` mount in src/server/serve.ts can host it directly.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 2026-06-30 — relative base for prefix-mounted deployment.
  //
  // Was `base: "/"` (vite default). When mathran's SPA is served behind a
  // reverse-proxy prefix (e.g. portal mounts it at `/mathran/`), absolute
  // asset URLs hit the WRONG path: the HTML attribute rewriter at the
  // portal can fix `<script src="/assets/…">`, but CSS files contain
  // hard-coded `url(/assets/KaTeX_Main-*.woff2)` font references that the
  // portal cannot rewrite without parsing CSS. Result: every KaTeX font
  // returns 404 and browsers fall back to Times New Roman — math formulas
  // render in serif body font instead of Computer Modern, looking nothing
  // like a PDF.
  //
  // `base: "./"` makes vite emit RELATIVE URLs for every generated asset:
  //   - in index.html:  `./assets/index.js` (resolves against page URL)
  //   - in CSS files:   `url(./KaTeX_Main-*.woff2)` (resolves against the
  //                     CSS file's URL — which already lives in /assets/)
  // This works correctly whether the SPA is mounted at `/`, `/mathran/`,
  // or anywhere else, with NO rewriting needed at the proxy.
  //
  // The trade-off: relative URLs break for SPAs that use client-side
  // routing because navigating to `/mathran/projects/foo` would resolve
  // `./assets/index.js` against `/mathran/projects/` and 404. Mathran
  // avoids this because (a) its routes don't add path segments under
  // PUBLIC_PREFIX, and (b) portal's SPA shim injects `<base href="…">`
  // which anchors all relative URLs to the prefix root regardless of the
  // current pathname.
  base: "./",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    // 2026-06-30 (mathran-bug-scan #5 fix) — SPA bundle 之前 > 500kB
    // 主 chunk，Vite warn 提示 split。这里按 vendor 维度做手工 manual
    // chunks：react 全家、KaTeX、marked / markdown-it 各自一坨，主代码
    // 拆出来后冷启首屏明显 faster（用户多数时间在 ChatPanel.tsx，不需
    // 一次性下完所有第三方）。Chunk 命名走 hashed 默认。
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-markdown": ["marked", "marked-katex-extension"],
          "vendor-katex": ["katex"],
          "vendor-codemirror": [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/language",
            "@codemirror/commands",
            "@codemirror/lang-markdown",
          ],
          "vendor-yaml-toml": ["yaml", "smol-toml"],
        },
      },
    },
    // 把 500 KB warn 改 800 KB 直到 manual chunk 调好（KaTeX 单独一坨
    // 就有 ~300 KB，没法压更小，调高 warn 阈是务实的）。
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7878",
        changeOrigin: true,
      },
    },
  },
});
