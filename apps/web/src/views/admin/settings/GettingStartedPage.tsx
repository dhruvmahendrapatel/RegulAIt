/**
 * Getting started — the guided "connect your first real provider" journey.
 * Status-driven, never a static tutorial: every row is computed server-side
 * from the real tables by /v1/setup/status, and each pending step deep-links
 * to the exact SPA view that completes it. Honest by design: mock objects are
 * always labeled mock.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { SetupStatusResponse, SetupStep } from "../../../api/types";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, Meter } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const META: Record<string, { why: string; to?: string; cta: string; app?: boolean }> = {
  model_provider: {
    why: "Until a real key is configured every dispatch runs on the MOCK provider — answers are simulated and spend is $0. This is the step that makes RegulAIt real.",
    to: "/admin/model-credentials",
    cta: "Add a credential",
  },
  git_connection: {
    why: "Workflow build/PR stages need a real git provider. A mock connection exercises the flow but touches no repository.",
    to: "/admin/git-connections",
    cta: "Connect git",
  },
  pm_connection: {
    why: "Pillar 8: work items stay the source of truth — decisions and sign-offs mirror into your own PM tool instead of a shadow copy.",
    to: "/admin/pm-connections",
    cta: "Connect a PM tool",
  },
  mcp_server: {
    why: "Registering an MCP server gives the governance layer tools to allow-list — default-deny has nothing to govern until a server exists.",
    to: "/admin/mcp-servers",
    cta: "Register a server",
  },
  non_admin_user: {
    why: "Governance is per-user. Create the first developer account and hand them an API key — admin-only orgs govern no one.",
    to: "/admin/users",
    cta: "Create a user",
  },
  project: {
    why: "Budgets and cost attribution hang off projects; calls without one land in the Unattributed bucket.",
    to: "/admin/cost",
    cta: "Create a project",
  },
  compliance_profile: {
    why: "A classification tag cascades required workflows, PII mode and retention onto everything the project governs.",
    to: "/admin/compliance",
    cta: "Classify a project",
  },
  interception_surface: {
    why: "The provider-shaped compat surfaces let existing IDE/agent traffic arrive governed — both are OFF by default; the MCP proxy counts once it is actually used.",
    to: "/admin/client-access",
    cta: "Open Client access",
  },
  first_real_dispatch: {
    why: "The end-to-end proof: one governed call served by a real provider, metered, attributed and audited.",
    to: "/chat",
    cta: "Open Chat",
  },
};

function evidenceLine(s: SetupStep): string {
  const e = (s.evidence ?? {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(e[k]) ? (e[k] as Array<Record<string, unknown>>) : []);
  switch (s.key) {
    case "model_provider":
      if (arr("providers").length)
        return (
          "Configured: " +
          arr("providers")
            .map((p) => `${p.provider} (${p.source === "env" ? "env var" : "platform credential"})`)
            .join(", ")
        );
      return typeof e.note === "string" ? e.note : "No real provider configured — only mock is live.";
    case "git_connection":
    case "pm_connection":
      if (arr("real").length)
        return "Connected: " + arr("real").map((c) => `${c.name} (${c.provider})`).join(", ");
      return Number(e.mockCount ?? 0) > 0
        ? `${e.mockCount} mock connection(s) only — labeled mock; they exercise the flow but touch nothing real.`
        : "None yet.";
    case "mcp_server":
      return arr("servers").length
        ? "Registered: " + arr("servers").map((x) => String(x.name)).join(", ")
        : "None registered.";
    case "non_admin_user":
      return Number(e.activeNonAdminUsers ?? 0) > 0
        ? `${e.activeNonAdminUsers} active non-admin user(s).`
        : "Only admin accounts exist so far.";
    case "project":
      return Array.isArray(e.projects) && e.projects.length
        ? "Projects: " + (e.projects as string[]).join(", ")
        : "No project yet.";
    case "compliance_profile":
      if (arr("classifiedProjects").length)
        return (
          "Classified: " +
          arr("classifiedProjects")
            .map((p) => `${p.name} [${(p.tags as string[]).join(", ")}]`)
            .join("; ")
        );
      return Number(e.profilesDefined ?? 0) > 0
        ? `${e.profilesDefined} profile(s) defined but not assigned to any project.`
        : "No compliance profile defined yet.";
    case "interception_surface": {
      const on: string[] = [];
      if (e.anthropicCompatEnabled) on.push("Anthropic compat on");
      if (e.openaiCompatEnabled) on.push("OpenAI compat on");
      if (e.scopeRulesExist) on.push("scope rules set");
      if (Number(e.mcpProxyCalls ?? 0) > 0) on.push(`${e.mcpProxyCalls} MCP proxy call(s)`);
      return on.length ? on.join(" · ") : "Both compat surfaces off, MCP proxy unused.";
    }
    case "first_real_dispatch":
      if (Number(e.realDispatches ?? 0) > 0)
        return `${e.realDispatches} real dispatch(es) served (${e.mockDispatches} mock).`;
      return Number(e.mockDispatches ?? 0) > 0
        ? `${e.mockDispatches} MOCK dispatch(es) so far — the flow works, but no real model has answered yet.`
        : "No dispatch yet.";
    default:
      return "";
  }
}

export default function GettingStartedPage() {
  const q = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.get<SetupStatusResponse>("/v1/setup/status"),
  });
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Getting started"
        sub="A live checklist, recomputed from the real objects on every load — never a tutorial that can drift. Each pending step links to the exact view that completes it."
        actions={
          <Button size="sm" onClick={() => void q.refetch()}>
            Re-check
          </Button>
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && (
          <div className={v.stack}>
            {d.complete && (
              <Card>
                <div className={v.row}>
                  <Badge tone="ok">setup complete</Badge>
                  <span className={v.dim}>All {d.totalCount} getting-started steps are done.</span>
                </div>
              </Card>
            )}
            <Card>
              <div className={v.row}>
                <span className={v.statValue}>
                  {d.doneCount} / {d.totalCount}
                </span>
                <span className={v.statLabel}>steps done</span>
              </div>
              <div style={{ margin: "var(--s2) 0" }}>
                <Meter value={d.doneCount} max={d.totalCount} label="setup progress" />
              </div>
              {d.steps.map((s) => {
                const m = META[s.key] ?? { why: "", cta: "Open" };
                const blocked = (s.blockedBy ?? []).length > 0;
                return (
                  <div key={s.key} className={v.listRow} style={blocked ? { opacity: 0.6 } : undefined}>
                    <span
                      className={[
                        a.stepDot,
                        s.done ? a.stepDotDone : blocked ? a.stepDotBlocked : "",
                      ].join(" ")}
                      aria-hidden
                    />
                    <div className={v.grow}>
                      <div className={v.row}>
                        <strong style={{ fontSize: "var(--text-sm)" }}>{s.title}</strong>
                        {s.done ? (
                          <Badge tone="ok">done</Badge>
                        ) : blocked ? (
                          <Badge tone="danger">blocked</Badge>
                        ) : (
                          <Badge tone="warn">pending</Badge>
                        )}
                      </div>
                      <div className={v.dim}>{m.why}</div>
                      <div className={v.faint}>{evidenceLine(s)}</div>
                      {blocked && (
                        <div className={v.faint}>
                          Blocked by: {(s.blockedBy ?? []).map((k) => k.replaceAll("_", " ")).join(", ")}
                        </div>
                      )}
                    </div>
                    {!s.done && m.to && (
                      <Link to={m.to}>
                        <Button size="sm" disabled={blocked}>
                          {m.cta}
                        </Button>
                      </Link>
                    )}
                  </div>
                );
              })}
            </Card>
            <p className={v.faint}>
              Honest by design: mock providers/connections are labeled mock everywhere — a green flow on
              mock objects proves the plumbing, not production readiness. The dispatch step only turns done
              when a REAL (non-mock) provider serves a governed call.
            </p>
          </div>
        )}
      </QueryGate>
    </>
  );
}
