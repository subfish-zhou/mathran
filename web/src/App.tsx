import { useState } from "react";
import ProjectsPanel from "./components/ProjectsPanel.tsx";
import WikiPanel from "./components/WikiPanel.tsx";
import ChatPanel from "./components/ChatPanel.tsx";
import ProvidersPanel from "./components/ProvidersPanel.tsx";

type Tab = "projects" | "wiki" | "chat" | "providers";

const TABS: { id: Tab; label: string }[] = [
  { id: "projects", label: "Projects" },
  { id: "wiki", label: "Wiki" },
  { id: "chat", label: "Chat" },
  { id: "providers", label: "Providers" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("projects");
  // Selected project slug is shared between the Projects and Wiki panels.
  const [activeProject, setActiveProject] = useState<string | null>(null);

  return (
    <div className="flex h-full bg-slate-50 text-slate-900">
      <nav className="flex w-48 shrink-0 flex-col gap-1 border-r border-slate-200 bg-white p-3">
        <div className="mb-3 px-2 text-lg font-bold tracking-tight">mathran</div>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-2 text-left text-sm font-medium transition ${
              tab === t.id
                ? "bg-slate-900 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
        {activeProject && (
          <div className="mt-auto px-2 pt-3 text-xs text-slate-400">
            project: <span className="font-mono text-slate-600">{activeProject}</span>
          </div>
        )}
      </nav>

      <main className="flex-1 overflow-hidden">
        {tab === "projects" && (
          <ProjectsPanel
            activeProject={activeProject}
            onSelect={(slug) => {
              setActiveProject(slug);
            }}
            onOpenWiki={(slug) => {
              setActiveProject(slug);
              setTab("wiki");
            }}
          />
        )}
        {tab === "wiki" && (
          <WikiPanel
            activeProject={activeProject}
            onSelectProject={setActiveProject}
          />
        )}
        {tab === "chat" && <ChatPanel />}
        {tab === "providers" && <ProvidersPanel />}
      </main>
    </div>
  );
}
