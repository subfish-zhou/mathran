/**
 * Root component — mathub-style layout (T1-E).
 *
 * Layout:
 *   ┌─────────┬─────────────────────────────────────────┐
 *   │ global  │ project chrome (sub-nav + outlet)       │
 *   │ sidebar │  (when on a /projects/:slug/* route)    │
 *   │ (always │                                          │
 *   │  here)  │  ─── or ───                              │
 *   │         │  /            → Home (projects list)    │
 *   │         │  /global-chat → Global assistant chat   │
 *   │         │  /settings    → Providers / config      │
 *   └─────────┴─────────────────────────────────────────┘
 */
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useEffect, useState } from "react";
import { api, type ProjectSummary } from "./lib/api.ts";
import { listGoals, type GoalRow } from "./lib/chat.ts";
import ProjectsPanel from "./components/ProjectsPanel.tsx";
import WikiPanel from "./components/WikiPanel.tsx";
import ChatPanel from "./components/ChatPanel.tsx";
import ProvidersPanel from "./components/ProvidersPanel.tsx";
import SettingsPanel from "./components/SettingsPanel.tsx";
import McpServersPanel from "./components/McpServersPanel.tsx";
import SettingsLayout from "./components/SettingsLayout.tsx";
import McpConfigForm from "./components/McpConfigForm.tsx";
import EffortsPanel from "./components/EffortsPanel.tsx";
import EffortDocumentPanel from "./components/EffortDocumentPanel.tsx";
import ProfilePage from "./pages/ProfilePage.tsx";
import { Splitter, useSplitterWidth } from "./components/Splitter.tsx";

/**
 * Runtime detection of the SPA's serving prefix.
 *
 * mathran was originally designed to live at "/". The 2026-06-29
 * multi-user public portal (mathran-portal) mounts the same SPA behind
 * "/mathran/" via an nginx → portal → per-user mathran-serve chain.
 * React Router needs the right `basename` or every Link goes to the
 * wrong URL.
 *
 * Detection: read the path of the <script> tag that loaded this bundle
 * (always present as `<script src="…/assets/index-*.js">`). The portion
 * before "/assets/" IS the SPA's mount path. Falls back to "/" when
 * the script src is absent or unexpected — i.e. the local single-user
 * case where the SPA lives at root.
 *
 * 2026-06-29 (mathran-portal landing): the previous fixed `<BrowserRouter>`
 * with no basename made every Link absolute-to-origin, so when
 * mathran-portal served the SPA at /mathran/, clicking "💬 Global chat"
 * navigated the browser to https://host:3000/global-chat (= Mathub's
 * Next.js root) instead of staying inside /mathran/.
 */
function detectBasename(): string {
  if (typeof document === "undefined") return "/";
  try {
    // Find a <script> tag whose src looks like our bundle. Vite emits
    // `<script type="module" src="<base>/assets/index-<hash>.js">`.
    const scripts = Array.from(document.getElementsByTagName("script"));
    for (const s of scripts) {
      const src = s.getAttribute("src") || s.src || "";
      const m = /^(.*)\/assets\/[^/]+\.js(?:$|\?)/.exec(src);
      if (m) {
        // Same-origin only — bail on cross-origin CDN setups.
        try {
          const u = new URL(src, window.location.origin);
          if (u.origin !== window.location.origin) continue;
        } catch {
          /* ignore */
        }
        return m[1] || "/";
      }
    }
  } catch {
    /* swallow — default to "/" */
  }
  return "/";
}

export default function App() {
  return (
    <BrowserRouter basename={detectBasename()}>
      <Routes>
        <Route element={<RootLayout />}>
          <Route index element={<ProjectsPanel />} />
          <Route path="/projects" element={<Navigate to="/" replace />} />
          <Route
            path="/global-chat"
            element={<ChatPanel scope={{ kind: "global" }} scopeLabel="global" />}
          />
          {/* 2026-06-26 (user-distillation Phase 1) — user-authored
              profile (own papers + active projects). Read-only to the
              model; mutations are SPA-driven. */}
          <Route path="/profile" element={<ProfilePage />} />
          {/* TODO-3 UI #4.B — Settings tabs share a layout shell so all four
              sub-routes get the same top tab bar. Deep-links still work
              because each child <Route> retains its own path. */}
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<SettingsPanel />} />
            <Route path="providers" element={<ProvidersPanel />} />
            <Route path="mcp" element={<McpServersPanel />} />
            <Route path="mcp/config" element={<McpConfigForm />} />
          </Route>

          <Route path="/projects/:slug" element={<ProjectLayout />}>
            <Route index element={<ProjectHome />} />
            <Route path="wiki" element={<WikiRoute />} />
            <Route path="wiki/:page" element={<WikiRoute />} />
            <Route path="efforts" element={<EffortsRoute />} />
            <Route path="effort/:effortSlug" element={<EffortLayout />}>
              <Route index element={<Navigate to="document" replace />} />
              <Route path="document" element={<EffortDocumentRoute />} />
              <Route path="chat" element={<EffortChatRoute />} />
            </Route>
            <Route path="chat" element={<ProjectChatRoute />} />
            <Route path="*" element={<Navigate to="" replace />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

// ─── Root layout ──────────────────────────────────────────────────────────

function RootLayout() {
  // 2026-07-01 — user-adjustable global sidebar width, persisted per-user
  // in localStorage. Default 240px (matches old `w-60`).
  const [sidebarWidth, setSidebarWidth] = useSplitterWidth("mathran.globalSidebar.width", 240);
  return (
    <div className="flex h-full bg-slate-50 text-slate-900">
      <div style={{ width: sidebarWidth }} className="shrink-0 h-full overflow-hidden">
        <GlobalSidebar />
      </div>
      <Splitter
        storageKey="mathran.globalSidebar.width"
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        minWidth={160}
        maxWidth={480}
        ariaLabel="Resize global sidebar"
      />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

function GlobalSidebar() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => {});
  }, []);
  // Refresh on focus so the sidebar reflects newly-created projects.
  useEffect(() => {
    const handler = () => void api.listProjects().then(setProjects).catch(() => {});
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, []);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-2 text-sm transition ${
      isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <nav className="flex h-full w-full flex-col overflow-y-auto border-r border-slate-200 bg-white p-3">
      <Link to="/" className="mb-4 block px-2 text-lg font-bold tracking-tight">
        mathran
      </Link>
      <NavLink to="/" end className={linkClass}>
        🏠 Home
      </NavLink>
      <NavLink to="/global-chat" className={linkClass}>
        💬 Global chat
      </NavLink>
      <NavLink to="/profile" className={linkClass}>
        👤 Profile
      </NavLink>
      <NavLink to="/settings" className={linkClass}>
        ⚙️ Settings
      </NavLink>

      <RecentGoalsRail />

      <div className="mt-6 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Projects
      </div>
      <ul className="mt-1 space-y-0.5">
        {projects.length === 0 && (
          <li className="px-3 py-2 text-xs text-slate-400">
            None yet. Create one on Home →
          </li>
        )}
        {projects.map((p) => (
          <li key={p.slug}>
            <NavLink to={`/projects/${p.slug}`} className={linkClass}>
              <span className="block truncate">{p.name ?? p.slug}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ─── Project chrome ──────────────────────────────────────────────────────

function ProjectLayout() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <Navigate to="/" replace />;
  return (
    <div className="flex h-full flex-col">
      <ProjectSubNav slug={slug} />
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

function ProjectSubNav({ slug }: { slug: string }) {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm font-medium transition ${
      isActive
        ? "bg-slate-900 text-white"
        : "text-slate-600 hover:bg-slate-100"
    }`;
  return (
    <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-3">
      <span className="mr-3 text-sm font-semibold text-slate-700">{slug}</span>
      <NavLink to={`/projects/${slug}`} end className={linkClass}>
        Overview
      </NavLink>
      <NavLink to={`/projects/${slug}/efforts`} className={linkClass}>
        Efforts
      </NavLink>
      <NavLink to={`/projects/${slug}/wiki`} className={linkClass}>
        Wiki
      </NavLink>
      <NavLink to={`/projects/${slug}/chat`} className={linkClass}>
        Chat
      </NavLink>
    </div>
  );
}

function ProjectHome() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setError(null);
    api.getProject(slug).then(setDetail).catch((e) => setError((e as Error).message));
  }, [slug]);

  if (!slug) return null;
  return (
    <div className="mx-auto max-w-3xl p-6">
      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      {detail && (
        <>
          <h1 className="text-2xl font-bold">{detail.project?.project?.name ?? slug}</h1>
          <div className="font-mono text-xs text-slate-400">{slug}</div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <button
              onClick={() => navigate(`/projects/${slug}/efforts`)}
              className="rounded-md border border-slate-200 bg-white p-4 text-left hover:border-slate-400"
            >
              <div className="text-sm font-semibold">Efforts</div>
              <div className="text-xs text-slate-500">
                Individual work units (proofs, formalizations, ...)
              </div>
            </button>
            <button
              onClick={() => navigate(`/projects/${slug}/wiki`)}
              className="rounded-md border border-slate-200 bg-white p-4 text-left hover:border-slate-400"
            >
              <div className="text-sm font-semibold">Wiki</div>
              <div className="text-xs text-slate-500">
                Long-lived notes, definitions, references
              </div>
            </button>
            <button
              onClick={() => navigate(`/projects/${slug}/chat`)}
              className="rounded-md border border-slate-200 bg-white p-4 text-left hover:border-slate-400"
            >
              <div className="text-sm font-semibold">Project chat</div>
              <div className="text-xs text-slate-500">
                Assistant conversation scoped to this project
              </div>
            </button>
          </div>

          {Array.isArray(detail.entries) && (
            <>
              <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Structure
              </h3>
              <ul className="mt-2 rounded-md border border-slate-200 bg-white">
                {detail.entries.map((entry: string) => (
                  <li
                    key={entry}
                    className="border-b border-slate-100 px-3 py-2 font-mono text-sm last:border-b-0"
                  >
                    {entry}
                  </li>
                ))}
                {detail.entries.length === 0 && (
                  <li className="px-3 py-2 text-sm text-slate-400">empty</li>
                )}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Routes that pull the param out and forward to the leaf component ────

function WikiRoute() {
  const { slug, page } = useParams<{ slug: string; page?: string }>();
  if (!slug) return <Navigate to="/" replace />;
  return <WikiPanel projectSlug={slug} currentPage={page ?? null} />;
}

function EffortsRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <Navigate to="/" replace />;
  return <EffortsPanel projectSlug={slug} />;
}

function ProjectChatRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <Navigate to="/" replace />;
  return (
    <ChatPanel
      scope={{ kind: "project", projectSlug: slug }}
      scopeLabel={`project: ${slug}`}
    />
  );
}

function EffortLayout() {
  const { slug, effortSlug } = useParams<{ slug: string; effortSlug: string }>();
  if (!slug || !effortSlug) return <Navigate to="/" replace />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-2">
        <Link
          to={`/projects/${slug}/efforts`}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          ← all efforts
        </Link>
        <span className="font-mono text-xs text-slate-400">{effortSlug}</span>
        <span className="ml-auto flex items-center gap-1">
          <NavLink
            to={`/projects/${slug}/effort/${effortSlug}/document`}
            className={({ isActive }) =>
              `rounded-md px-3 py-1 text-xs ${
                isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`
            }
          >
            Document
          </NavLink>
          <NavLink
            to={`/projects/${slug}/effort/${effortSlug}/chat`}
            className={({ isActive }) =>
              `rounded-md px-3 py-1 text-xs ${
                isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`
            }
          >
            Chat
          </NavLink>
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

function EffortDocumentRoute() {
  const { slug, effortSlug } = useParams<{ slug: string; effortSlug: string }>();
  if (!slug || !effortSlug) return <Navigate to="/" replace />;
  return <EffortDocumentPanel projectSlug={slug} effortSlug={effortSlug} />;
}

function EffortChatRoute() {
  const { slug, effortSlug } = useParams<{ slug: string; effortSlug: string }>();
  if (!slug || !effortSlug) return <Navigate to="/" replace />;
  return (
    <ChatPanel
      scope={{ kind: "effort", projectSlug: slug, effortSlug }}
      scopeLabel={`effort: ${slug}/${effortSlug}`}
    />
  );
}

// ─── TODO-3 UI #4.C — Recent goals rail ─────────────────────────────
// Lists active+paused goals across the workspace so the user can jump
// back to a long-running goal without scrolling through the Home rail.
// Polls /api/goals every 30s (cheap — daemon state changes slowly) and
// refreshes on window focus so a goal kicked from another tab shows up
// quickly. Self-hides when there's nothing to show.
function RecentGoalsRail() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await listGoals();
        if (!cancelled) {
          // Sort: active before paused, then by id desc (UUID v7 / time-sortable
          // — not perfect but stable). Cap to 5 entries.
          const sorted = [...list].sort((a, b) => {
            const rank = (s: GoalRow["status"]) => (s === "active" ? 0 : s === "paused" ? 1 : 2);
            const r = rank(a.status) - rank(b.status);
            if (r !== 0) return r;
            return b.id.localeCompare(a.id);
          });
          setGoals(sorted.slice(0, 5));
        }
      } catch {
        // ignore — silent failure keeps the rail empty
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  if (goals.length === 0) return null;
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-1.5 text-xs transition truncate ${
      isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
    }`;
  return (
    <div className="mt-6">
      <div className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        🎯 Recent goals
      </div>
      <ul className="mt-1 space-y-0.5" data-testid="recent-goals-rail">
        {goals.map((g) => {
          const convId = g.conversationIds[0];
          // Without a conversation we can't deep-link into a chat; skip.
          if (!convId) return null;
          const href =
            g.scope.kind === "global"
              ? `/global-chat?conversation=${encodeURIComponent(convId)}`
              : g.scope.kind === "project"
                ? `/projects/${g.scope.projectSlug}/chat?conversation=${encodeURIComponent(convId)}`
                : g.scope.kind === "effort"
                  ? `/projects/${g.scope.projectSlug}/effort/${g.scope.effortKey ?? ""}/chat?conversation=${encodeURIComponent(convId)}`
                  : "#";
          const icon = g.status === "active" ? "🟢" : "🟡";
          const titlePreview = g.objective.slice(0, 60);
          return (
            <li key={g.id}>
              <NavLink to={href} className={linkClass} title={g.objective}>
                <span className="mr-1" aria-hidden="true">{icon}</span>
                <span>{titlePreview}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
