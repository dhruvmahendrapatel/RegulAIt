/**
 * Home. Admins see org readiness (the setup checklist), the approval queue
 * pulse, a spend snapshot and recent audit lines; everyone else sees their
 * own pending approvals, recent runs and spend. Every card links somewhere
 * real — nothing decorative.
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  Approval,
  AuditEntry,
  RunSummary,
  SetupStatusResponse,
  UsageEventsResponse,
} from "../../api/types";
import { ago, approvalStageLabel, fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { SUITES, SuiteGlyph, suiteHome } from "../../shell/suites";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Meter,
  SkeletonBlock,
  StatusBadge,
  StatusDot,
} from "../../ui/kit";
import v from "../views.module.css";

export default function HomePage() {
  const { auth } = useSession();
  const firstName = auth?.user?.displayName?.split(/\s+/)[0];
  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Welcome back"}
        sub="Your governed AI delivery workspace — everything below is live."
      />
      <div className={v.stack}>
        {auth?.isAdmin && <OrientationCard />}
        {auth?.isAdmin && <SuiteLauncher />}
        {auth?.isAdmin && <SetupCard />}
        <div className={v.grid2}>
          <ApprovalsCard />
          <SpendCard />
        </div>
        <div className={v.grid2}>
          <RecentRunsCard />
          {auth?.isAdmin ? <AuditCard /> : <WorkflowNudgeCard />}
        </div>
      </div>
    </>
  );
}

/**
 * First-run orientation (ADR-0093). An admin landing on the console for the
 * first time should understand the product in one screen: what the gateway is
 * enforcing right now, the headline numbers, and where to start. Dismissal is
 * a per-browser convenience stored in localStorage — it must never gate
 * anything, and a cleared browser simply shows the card again.
 */
const ORIENTATION_KEY = "rg.homeOrientationDismissed";
const readDismissed = () => {
  try {
    return localStorage.getItem(ORIENTATION_KEY) === "1";
  } catch {
    return false;
  }
};

function OrientationCard() {
  const [dismissed, setDismissed] = useState(readDismissed);
  // deduped against the cards below — same query keys, no extra fetches
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
  });
  const usage = useQuery({
    queryKey: ["usage-events"],
    queryFn: () => api.get<UsageEventsResponse>("/v1/usage-events?limit=100"),
  });
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<SetupStatusResponse>("/v1/setup/status"),
  });
  const pending = (approvals.data?.approvals ?? []).filter((a) => a.status === "pending").length;
  const totals = usage.data?.totals ?? {};
  // Dismissal hides the ORIENTATION (prose + start-here links), never the live
  // numbers — those are a dashboard, not onboarding (owner feedback, 2026-08-21).
  // "Show orientation" restores it; the choice stays a per-browser convenience.
  const setStored = (on: boolean) => {
    try {
      if (on) localStorage.setItem(ORIENTATION_KEY, "1");
      else localStorage.removeItem(ORIENTATION_KEY);
    } catch {
      /* storage unavailable — the toggle still works for this view */
    }
    setDismissed(on);
  };
  return (
    <Card
      title={dismissed ? "Governance at a glance" : "Start here — what this console governs"}
      actions={
        <Button
          size="sm"
          variant="ghost"
          aria-label={dismissed ? "Show orientation" : "Dismiss orientation"}
          onClick={() => setStored(!dismissed)}
        >
          {dismissed ? "Show orientation" : "Dismiss"}
        </Button>
      }
    >
      <div className={v.stack}>
        {!dismissed && (
          <p className={v.dim} style={{ maxWidth: "70ch" }}>
            Every agent, connector and MCP call in this workspace passes through one gateway:
            default-deny entitlements, human approvals, content guardrails, per-project cost
            attribution and a full audit trail — enforced at the call, not reported after it.
          </p>
        )}
        <div className={v.grid3}>
          <div className={v.stat}>
            <span className={v.statValue}>{pending}</span>
            <span className={v.statLabel}>decisions waiting on a human</span>
          </div>
          <div className={v.stat}>
            <span className={v.statValue}>{totals.events ?? 0}</span>
            <span className={v.statLabel}>governed calls metered</span>
          </div>
          <div className={v.stat}>
            <span className={v.statValue}>{fmtUsd(totals.costUsd)}</span>
            <span className={v.statLabel}>attributed spend</span>
          </div>
        </div>
        {!dismissed && (
        <div className={v.row} style={{ flexWrap: "wrap" }}>
          <Link to="/admin/posture">See your governance posture</Link>
          <span className={v.faint} aria-hidden>
            ·
          </span>
          <Link to="/admin/use-cases">Propose an AI use case</Link>
          <span className={v.faint} aria-hidden>
            ·
          </span>
          <Link to="/admin/inventory">Open the agent inventory</Link>
          <span className={v.faint} aria-hidden>
            ·
          </span>
          <Link to="/admin/cost">Open the cost dashboard</Link>
        </div>
        )}
      </div>
    </Card>
  );
}

/**
 * ADR-0094 — the product launcher. One tile per suite, rendered from the SAME
 * array that scopes the sidebar (suites.tsx), so the launcher can never drift
 * from the navigation. A tile shows a live number only where a query this page
 * ALREADY runs can supply one (deduped by query key — no per-tile fetches); a
 * suite without a cheap number shows none rather than inventing one.
 */
function SuiteLauncher() {
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
  });
  const usage = useQuery({
    queryKey: ["usage-events"],
    queryFn: () => api.get<UsageEventsResponse>("/v1/usage-events?limit=100"),
  });
  const setup = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<SetupStatusResponse>("/v1/setup/status"),
  });
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<{ runs: RunSummary[] }>("/v1/runs"),
  });

  const pending = (approvals.data?.approvals ?? []).filter((a) => a.status === "pending").length;
  const stat = (suiteId: string): { value: string; label: string } | null => {
    switch (suiteId) {
      case "workspace":
        return runs.data ? { value: String(runs.data.runs.length), label: "runs" } : null;
      case "approvals-audit":
        return approvals.data ? { value: String(pending), label: "waiting on a human" } : null;
      case "cost-optimization":
        return usage.data ? { value: fmtUsd(usage.data.totals?.costUsd), label: "attributed spend" } : null;
      case "settings":
        return setup.data
          ? { value: `${setup.data.doneCount}/${setup.data.totalCount}`, label: "setup steps done" }
          : null;
      default:
        return null;
    }
  };

  return (
    <div>
      <h2 className={v.sectionTitle}>Products</h2>
      <div className={v.tileGrid}>
        {SUITES.map((su) => {
          const n = stat(su.id);
          return (
            <Link
              key={su.id}
              to={su.id === "workspace" ? "/chat" : suiteHome(su)}
              className={v.tile}
              data-testid={`suite-tile-${su.id}`}
            >
              <span className={v.tileGlyph}>
                <SuiteGlyph suiteId={su.id} />
              </span>
              <span className={v.tileName}>{su.name}</span>
              <span className={v.tileDesc}>{su.purpose}</span>
              {n && (
                <span className={v.tileStat}>
                  <span className={v.tileStatValue}>{n.value}</span>
                  <span className={v.tileStatLabel}>{n.label}</span>
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function SetupCard() {
  const q = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<SetupStatusResponse>("/v1/setup/status"),
  });
  if (q.isLoading)
    return (
      <Card title="Getting started">
        <SkeletonBlock lines={4} />
      </Card>
    );
  if (q.isError)
    return (
      <Card title="Getting started">
        <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </Card>
    );
  const d = q.data!;
  if (d.complete) {
    return (
      <Card title="Getting started">
        <div className={v.row}>
          <StatusDot tone="ok" />
          <span className={v.dim}>
            All {d.totalCount} setup steps are complete — this deployment is fully wired.
          </span>
          <span className={v.grow} />
          <Link to="/admin/setup">Review the checklist</Link>
        </div>
      </Card>
    );
  }
  return (
    <Card
      title={
        <span className={v.row}>
          Getting started
          <Badge tone="primary">
            {d.doneCount}/{d.totalCount} done
          </Badge>
        </span>
      }
      actions={<Link to="/admin/setup">Open checklist</Link>}
    >
      <div>
        {d.steps.map((step) => (
          <div key={step.key} className={v.listRow}>
            <StatusDot tone={step.done ? "ok" : "neutral"} title={step.done ? "done" : "pending"} />
            <span className={v.grow} style={{ fontSize: "var(--text-sm)" }}>
              {step.title}
            </span>
            {step.done ? (
              <Badge tone="ok">done</Badge>
            ) : (
              <Link className={v.faint} to="/admin/setup" title="Complete this step in Getting started">
                complete
              </Link>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ApprovalsCard() {
  const { auth } = useSession();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ approvals: Approval[] }>("/v1/approvals"),
  });
  if (q.isLoading)
    return (
      <Card title="Approvals">
        <SkeletonBlock lines={3} />
      </Card>
    );
  if (q.isError)
    return (
      <Card title="Approvals">
        <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </Card>
    );
  const pending = (q.data?.approvals ?? []).filter((a) => a.status === "pending");
  return (
    <Card
      title={auth?.isAdmin ? "Pending approvals — org-wide" : "Waiting on you"}
      actions={<Link to="/inbox">Open inbox</Link>}
    >
      {pending.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          body="Sign-offs, escalations and budget overages appear here the moment they pause."
        />
      ) : (
        <>
          <div className={v.stat} style={{ marginBottom: "var(--s1)" }}>
            <span className={v.statValue}>{pending.length}</span>
            <span className={v.statLabel}>pending decision{pending.length === 1 ? "" : "s"}</span>
          </div>
          {pending.slice(0, 4).map((a) => (
            <div key={a.id} className={v.listRow} style={{ cursor: "pointer" }} onClick={() => navigate("/inbox")}>
              <span className={v.grow} style={{ fontSize: "var(--text-sm)" }}>
                {approvalStageLabel(a) ?? a.objectLabel ?? a.objectType}
                <span className={v.faint}> · requested by {a.requestedByName ?? "unknown"}</span>
              </span>
              <span className={v.faint}>{ago(a.requestedAt)}</span>
            </div>
          ))}
        </>
      )}
    </Card>
  );
}

function SpendCard() {
  const { auth } = useSession();
  const q = useQuery({
    queryKey: ["usage-events"],
    queryFn: () => api.get<UsageEventsResponse>("/v1/usage-events?limit=100"),
  });
  if (q.isLoading)
    return (
      <Card title="Spend">
        <SkeletonBlock lines={3} />
      </Card>
    );
  if (q.isError)
    return (
      <Card title="Spend">
        <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </Card>
    );
  const t = q.data?.totals ?? {};
  return (
    <Card
      title={auth?.isAdmin ? "Spend snapshot" : "My spend"}
      actions={
        auth?.isAdmin ? (
          <Link to="/admin/cost">Cost dashboard</Link>
        ) : (
          <Link to="/spend">Spend &amp; savings</Link>
        )
      }
    >
      {(t.events ?? 0) === 0 ? (
        <EmptyState
          title="No metered calls yet"
          body="Send a message in Chat — every dispatch is governed, metered and attributed."
          action={
            <Button size="sm" onClick={() => (window.location.href = "/ui/chat")}>
              Open Chat
            </Button>
          }
        />
      ) : (
        <div className={v.grid3}>
          <div className={v.stat}>
            <span className={v.statValue}>{fmtUsd(t.costUsd)}</span>
            <span className={v.statLabel}>measured · {t.events} calls</span>
          </div>
          <div className={v.stat}>
            <span className={v.statValue}>
              {t.inputTokens ?? 0}→{t.outputTokens ?? 0}
            </span>
            <span className={v.statLabel}>tokens in → out</span>
          </div>
          <div className={v.stat}>
            <span className={v.statValue}>{fmtUsd(t.measuredCostSavedUsd)}</span>
            <span className={v.statLabel}>measured savings</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function RecentRunsCard() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.get<{ runs: RunSummary[] }>("/v1/runs"),
  });
  if (q.isLoading)
    return (
      <Card title="Recent runs">
        <SkeletonBlock lines={3} />
      </Card>
    );
  if (q.isError)
    return (
      <Card title="Recent runs">
        <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </Card>
    );
  const runs = (q.data?.runs ?? []).slice(0, 5);
  return (
    <Card title="Recent runs" actions={<Link to="/runs">All runs</Link>}>
      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Plan a multi-agent task graph and watch independent branches execute in parallel."
          action={
            <Button size="sm" onClick={() => navigate("/runs")}>
              Plan a run
            </Button>
          }
        />
      ) : (
        runs.map((r) => {
          const st = r.state?.nodeStatuses ?? {};
          const total = Object.keys(st).length;
          const done = Object.values(st).filter((x) => x === "done").length;
          return (
            <div
              key={r.id}
              className={v.listRow}
              style={{ cursor: "pointer", alignItems: "center" }}
              onClick={() => navigate(`/runs/${r.id}`)}
            >
              <span className={v.grow} style={{ fontSize: "var(--text-sm)", fontWeight: 550 }}>
                {r.name}
              </span>
              <span className={v.faint}>
                {done}/{total} nodes
              </span>
              <StatusBadge status={r.status} />
            </div>
          );
        })
      )}
    </Card>
  );
}

function AuditCard() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.get<{ entries: AuditEntry[] }>("/v1/audit"),
  });
  if (q.isLoading)
    return (
      <Card title="Recent audit trail">
        <SkeletonBlock lines={3} />
      </Card>
    );
  if (q.isError)
    return (
      <Card title="Recent audit trail">
        <ErrorState message={(q.error as Error).message} onRetry={() => void q.refetch()} />
      </Card>
    );
  const entries = (q.data?.entries ?? []).slice(0, 6);
  return (
    <Card title="Recent audit trail" actions={<Link to="/admin/audit">Full log</Link>}>
      {entries.length === 0 ? (
        <EmptyState title="No audit entries yet" body="Every governed decision lands here as it happens." />
      ) : (
        entries.map((e, i) => (
          <div key={e.id ?? i} className={v.listRow} style={{ alignItems: "center" }}>
            <StatusDot tone={e.effect === "allow" ? "ok" : "danger"} title={e.effect} />
            <span className={v.grow} style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>
              {e.reason ?? e.ruleId}
            </span>
            <span className={v.faint}>{ago(e.at)}</span>
          </div>
        ))
      )}
    </Card>
  );
}

function WorkflowNudgeCard() {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.get<{ instances: Array<{ id: string; status: string; change?: { description?: string } }> }>("/v1/workflows/instances"),
  });
  const open = (q.data?.instances ?? []).filter(
    (i) => !["completed", "denied", "aborted"].includes(i.status),
  );
  return (
    <Card title="Open workflows" actions={<Link to="/workflows">All workflows</Link>}>
      {q.isLoading ? (
        <SkeletonBlock lines={3} />
      ) : open.length === 0 ? (
        <EmptyState
          title="No open change requests"
          body="Start a governed change — intake, plan, sign-off, build, checks, PR and merge."
          action={
            <Button size="sm" onClick={() => navigate("/workflows")}>
              Start a workflow
            </Button>
          }
        />
      ) : (
        open.slice(0, 5).map((i) => (
          <div
            key={i.id}
            className={v.listRow}
            style={{ cursor: "pointer", alignItems: "center" }}
            onClick={() => navigate(`/workflows/${i.id}`)}
          >
            <span className={v.grow} style={{ fontSize: "var(--text-sm)" }}>
              {i.change?.description ?? "untitled change"}
            </span>
            <StatusBadge status={i.status} />
          </div>
        ))
      )}
    </Card>
  );
}

/** shared small budget row used by projects list/detail */
export function BudgetRow(props: {
  spent: number;
  cap: number | null | undefined;
  overageApproved?: boolean;
}) {
  if (props.cap == null) return <span className={v.faint}>no budget set</span>;
  const over = props.spent > props.cap;
  return (
    <div className={v.stack} style={{ gap: "var(--s0)" }}>
      <div className={v.row}>
        <span className={v.num} style={{ fontWeight: 650 }}>
          {fmtUsd(props.spent)}
        </span>
        <span className={v.faint}>of {fmtUsd(props.cap)}</span>
        {over && (
          <Badge tone={props.overageApproved ? "warn" : "danger"}>
            {props.overageApproved ? "overage approved" : "over budget"}
          </Badge>
        )}
      </div>
      <Meter value={props.spent} max={props.cap} over={over} label="budget vs actual" />
    </div>
  );
}
