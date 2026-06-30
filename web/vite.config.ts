import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPA for the mathran local workstation. Build output lands in ../dist/web so
// the Hono `serveStatic` mount in src/server/serve.ts can host it directly.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
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
