/**
 * SettingsLayout — TODO-3 UI #4.B.
 *
 * Shared shell for all /settings* routes. Renders a tab bar at the top
 * so the user can jump between Layered Settings, LLM Providers, MCP
 * Servers, and MCP Config without rediscovering the footer "See also"
 * links every time. The active tab is computed from the current
 * pathname so deep-links still highlight the right tab.
 *
 * The child route renders into <Outlet /> below the tab bar.
 */

import { NavLink, Outlet } from "react-router-dom";

interface TabSpec {
  to: string;
  label: string;
  /** Exact-match for /settings (otherwise it would match all /settings/*). */
  end?: boolean;
}

const TABS: readonly TabSpec[] = [
  { to: "/settings", label: "⚙️ Layered", end: true },
  { to: "/settings/providers", label: "🤖 LLM Providers" },
  { to: "/settings/mcp", label: "🔌 MCP Servers" },
  { to: "/settings/mcp/config", label: "🛠 MCP Config" },
];

export default function SettingsLayout() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${
      isActive
        ? "border-slate-900 text-slate-900"
        : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
    }`;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-4"
        aria-label="Settings sections"
      >
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={linkClass}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
