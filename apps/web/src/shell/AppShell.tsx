/**
 * The application shell: grouped left nav (with the "/" quick filter), topbar
 * (user menu, theme toggle), and — for admins — the full native admin surface
 * (phase 2): every group is a set of real /ui routes inside this shell. The
 * ADR-0026 amendment removed the legacy consoles entirely, so this shell is
 * the whole product surface — there are no outbound bridges left.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Approval } from "../api/types";
import { useSession } from "../session/SessionContext";
import { useTheme } from "../ui/useTheme";
import s from "./shell.module.css";

interface NavEntry {
  label: string;
  to: string;
}
const WORKSPACE: NavEntry[] = [
  { label: "Home", to: "/" },
  { label: "Chat", to: "/chat" },
  { label: "Runs", to: "/runs" },
  { label: "Workflows", to: "/workflows" },
  { label: "Inbox", to: "/inbox" },
  { label: "Projects", to: "/projects" },
];

/** the native admin surface (phase 2): grouped real routes inside this shell */
const ADMIN_GROUPS: Array<{ group: string; items: NavEntry[] }> = [
  {
    group: "Identity & Access",
    items: [
      { label: "Users", to: "/admin/users" },
      { label: "Roles", to: "/admin/roles" },
      { label: "Teams", to: "/admin/teams" },
      { label: "Client access", to: "/admin/client-access" },
      { label: "SSO & sessions", to: "/admin/sso" },
    ],
  },
  {
    group: "Governance",
    items: [
      { label: "Rules engine", to: "/admin/rules" },
      { label: "Simulation", to: "/admin/simulation" },
      { label: "Approvals queue", to: "/admin/approvals" },
      { label: "Audit log", to: "/admin/audit" },
      { label: "Workflow templates", to: "/admin/workflow-templates" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { label: "Agents", to: "/admin/agents" },
      { label: "Model credentials", to: "/admin/model-credentials" },
      { label: "Connectors", to: "/admin/connectors" },
      { label: "MCP servers", to: "/admin/mcp-servers" },
      { label: "Git connections", to: "/admin/git-connections" },
      { label: "PM connections", to: "/admin/pm-connections" },
      { label: "Deploy targets", to: "/admin/deploy-targets" },
    ],
  },
  {
    group: "Cost & Optimization",
    items: [
      { label: "Cost dashboard", to: "/admin/cost" },
      { label: "Optimization", to: "/admin/optimization" },
    ],
  },
  {
    group: "Compliance & Infra",
    items: [
      { label: "Compliance profiles", to: "/admin/compliance" },
      { label: "Infrastructure", to: "/admin/infrastructure" },
    ],
  },
  {
    group: "Settings",
    items: [
      { label: "Organization", to: "/admin/organization" },
      { label: "Getting started", to: "/admin/setup" },
    ],
  },
];

export default function AppShell(props: { children: ReactNode }) {
  const { auth, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // pending-inbox count for the nav badge (soft-refreshing, never blocking)
  const inbox = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
    refetchInterval: 30_000,
  });
  const pendingCount = (inbox.data?.approvals ?? []).filter((a) => a.status === "pending").length;

  // "/" focuses the nav filter from anywhere outside a form control
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setSideOpen(true);
      filterRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // click-away closes the user menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const q = filter.trim().toLowerCase();
  const workspaceItems = useMemo(
    () => WORKSPACE.filter((n) => !q || n.label.toLowerCase().includes(q)),
    [q],
  );
  const adminGroups = useMemo(() => {
    if (!auth?.isAdmin) return [];
    return ADMIN_GROUPS.map((g) => ({
      group: g.group,
      items: g.items.filter(
        (n) => !q || n.label.toLowerCase().includes(q) || g.group.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [auth?.isAdmin, q]);

  const displayName = auth?.user?.displayName ?? "Operator";
  const initials = displayName
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={s.shell}>
      <aside className={[s.side, sideOpen ? s.sideOpen : ""].join(" ")} aria-label="Primary navigation">
        <div className={s.brand}>
          <span className={s.brandWord}>
            regul<em>ai</em>t
          </span>
          <span className={s.brandTag}>governed</span>
        </div>
        <input
          ref={filterRef}
          className={s.navFilter}
          placeholder="Filter nav — press /"
          aria-label="Filter navigation"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className={s.section}>Workspace</div>
        {workspaceItems.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) => (isActive ? s.navItemActive! : s.navItem!)}
            onClick={() => setSideOpen(false)}
          >
            {n.label}
            {n.to === "/inbox" && pendingCount > 0 && (
              <span className={s.navCount} aria-label={`${pendingCount} pending approvals`}>
                {pendingCount}
              </span>
            )}
          </NavLink>
        ))}
        {adminGroups.map((g) => (
          <div key={g.group}>
            <div className={s.section}>{g.group}</div>
            {g.items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => (isActive ? s.navItemActive! : s.navItem!)}
                onClick={() => setSideOpen(false)}
              >
                {n.label}
              </NavLink>
            ))}
          </div>
        ))}
        {/* The two "legacy ↗" bridges are gone: the ADR-0026 amendment deleted
            the single-file shells they pointed at, so a link here would be a
            dead end — the exact failure phase 1 refused to ship. */}
        <div className={s.sideFoot}>Governed AI delivery platform</div>
      </aside>

      <div className={s.mainCol}>
        <header className={s.topbar}>
          <button
            className={`${s.iconBtn} ${s.hamburger}`}
            aria-label="Toggle navigation"
            aria-expanded={sideOpen}
            onClick={() => setSideOpen((o) => !o)}
          >
            ☰
          </button>
          <span className={s.topbarSpacer} />
          <span className={s.orgName}>RegulAIt workspace</span>
          <button
            className={s.iconBtn}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggle}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <div style={{ position: "relative" }} ref={menuRef}>
            <button
              className={s.userBtn}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className={s.avatar} aria-hidden>
                {initials}
              </span>
              {displayName}
            </button>
            {menuOpen && (
              <div className={s.menu} role="menu">
                <div className={s.menuHead}>
                  <div className={s.menuName}>{displayName}</div>
                  <div className={s.menuEmail}>{auth?.user?.email ?? "bootstrap operator"}</div>
                </div>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account");
                  }}
                >
                  Account security
                </button>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=password");
                  }}
                >
                  Change password
                </button>
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=mfa");
                  }}
                >
                  Two-factor authentication
                </button>
                <button className={s.menuDanger} role="menuitem" onClick={() => void signOut()}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <main className={s.content}>{props.children}</main>
      </div>
    </div>
  );
}

/** consistent page header — every view uses it */
export function PageHeader(props: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--s2)" }}>
        <h1 className={s.pageTitle} tabIndex={-1} style={{ flex: 1 }}>
          {props.title}
        </h1>
        {props.actions}
      </div>
      {props.sub != null ? <p className={s.pageSub}>{props.sub}</p> : <div style={{ height: "var(--s3)" }} />}
    </>
  );
}
