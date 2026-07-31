/**
 * The application shell: grouped left nav (with the "/" quick filter), topbar
 * (user menu, theme toggle), and — for admins — the honest bridge into the
 * classic console: placeholder group headers that open the legacy /admin tab
 * until phase 2 migrates those surfaces into this shell.
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

/** admin bridge: each group opens the closest legacy /admin tab (phase 2
 * replaces these with native views inside this shell) */
const ADMIN_BRIDGE: Array<{ label: string; hash: string }> = [
  { label: "Identity & Access", hash: "users" },
  { label: "Governance", hash: "rules-engine" },
  { label: "Integrations", hash: "mcp-servers" },
  { label: "Cost & Optimization", hash: "cost-projects" },
  { label: "Compliance & Infra", hash: "infrastructure" },
  { label: "Settings", hash: "organization" },
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
  const adminItems = useMemo(
    () => (auth?.isAdmin ? ADMIN_BRIDGE.filter((n) => !q || n.label.toLowerCase().includes(q)) : []),
    [auth?.isAdmin, q],
  );

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
        {adminItems.length > 0 && (
          <>
            <div className={s.section}>Administration</div>
            {adminItems.map((n) => (
              <a
                key={n.hash}
                className={s.navItem}
                href={`/admin#${n.hash}`}
                title="Opens the classic admin console (migrates into this shell in phase 2)"
              >
                {n.label}
                <span className={s.navExt} aria-hidden>
                  classic ↗
                </span>
              </a>
            ))}
          </>
        )}
        <div className={s.sideFoot}>
          Governed AI delivery platform
          <br />
          <a href="/app" title="The previous end-user UI, still served at /app">
            classic app ↗
          </a>
        </div>
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
