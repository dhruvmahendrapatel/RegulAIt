/**
 * The application shell: grouped left nav (with the "/" quick filter), topbar
 * (user menu, theme toggle), and — for admins — the full native admin surface
 * (phase 2): every group is a set of real /ui routes inside this shell.
 * ADR-0033 removed the legacy consoles entirely, so this shell is the whole
 * product surface — there are no outbound bridges left.
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
  { label: "Shared context", to: "/context" },
  // pillars 5 + 6 for the person who generates the spend — self-scoped, and
  // the only place a non-admin can see their own cost and savings ledgers
  { label: "Spend & savings", to: "/spend" },
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
      { label: "Provisioning (SCIM)", to: "/admin/provisioning" },
      // ADR-0038: where an IdP group becomes a role — and where the ones that
      // grant nothing are visible rather than silently inert.
      { label: "Group → role mapping", to: "/admin/group-mappings" },
    ],
  },
  {
    group: "Governance",
    items: [
      { label: "Rules engine", to: "/admin/rules" },
      // ADR-0040 — sits beside the rules engine because it is the same
      // question ("what may this call do?") asked with attributes instead of
      // static grants. It can only ever subtract from what Rules allows.
      { label: "ABAC policies", to: "/admin/abac-policies" },
      // ADR-0042 — the CONTENT gate, beside the destination and attribute
      // gates. Independent controls that happen to share one interception
      // point: what is in the payload vs. where the call may go vs. who may
      // make it under which attributes.
      { label: "Guardrails", to: "/admin/guardrails" },
      // ADR-0044 — the QUALITY gate, beside the content/destination/attribute
      // gates. Same question shape ("may this proceed?") asked of the agent's
      // OUTPUT against a fixed dataset, and it blocks promotion the same way.
      { label: "Evaluations", to: "/admin/evals" },
      // ADR-0045 — the RISK-ACCEPTANCE gate, beside the quality gate. Evals ask
      // "is this agent good on our cases?"; this asks "has a human accepted the
      // risk of using it for this purpose, and is that acceptance still valid?"
      // A high score is an input to that decision, never a substitute for it.
      { label: "Model risk", to: "/admin/model-risk" },
      // ADR-0048 — the CHANGE-CONTROL layer under all of the above. The gates
      // decide whether a call may proceed; this decides which VERSION of the
      // governing artifact it proceeds under, and gives that change a canary
      // and a one-click undo.
      { label: "Prompt versions", to: "/admin/prompt-versions" },
      { label: "Simulation", to: "/admin/simulation" },
      { label: "Approvals queue", to: "/admin/approvals" },
      // ADR-0046 — the SAME approvals, scaled: routing, SLA timers, escalation,
      // workload and bulk triage. A layer on the one queue, never a second one.
      { label: "Review workbench", to: "/admin/review-workbench" },
      { label: "Audit log", to: "/admin/audit" },
      // ADR-0047 — the BOARD-facing read of the same two ledgers the Cost
      // dashboard and the Audit log render operationally. Nothing new is
      // stored: a report is a read-only projection, scoped to the caller's own
      // entitlement, and it says on its face that spend is a list-price
      // estimate and that no scheduler drives its schedules.
      { label: "Reports", to: "/admin/reports" },
      { label: "Workflow templates", to: "/admin/workflow-templates" },
    ],
  },
  {
    group: "Integrations",
    items: [
      { label: "Agents", to: "/admin/agents" },
      { label: "Model credentials", to: "/admin/model-credentials" },
      // ADR-0034 — sits next to Model credentials because it is the same
      // question ("what can our models talk to?") asked about an endpoint we
      // do not own, rather than a vendor we do.
      { label: "Custom LLM providers", to: "/admin/custom-providers" },
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
      // ADR-0049 — budget-vs-FORECAST and spend-anomaly signals over the same
      // measured ledger the Cost dashboard renders as actuals. Next to it
      // because it is the same question asked forward in time rather than
      // backward, and because a forecast that lived somewhere else would
      // inevitably drift from the actuals it extrapolates.
      { label: "Spend forecast & anomalies", to: "/admin/spend-monitor" },
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
        {/* The two "legacy ↗" bridges are gone: ADR-0033 deleted the
            single-file shells they pointed at, so a link here would be a dead
            end — the exact failure phase 1 refused to ship. */}
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
                  Account
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
                <button
                  className={s.menuItem}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/account?section=keys");
                  }}
                >
                  Your model keys
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
