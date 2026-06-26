import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { RootErrorBoundary } from "./components/RootErrorBoundary.tsx";
import "./index.css";
// v0.17 follow-up: register marked + KaTeX + LLM math delimiter preprocess
// at app boot so EVERY component that calls marked.parse benefits, not just
// ChatPanel-after-it-has-mounted.
import "./lib/markdown";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
