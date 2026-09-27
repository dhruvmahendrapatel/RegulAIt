/**
 * Access recommendations (ADR-0092, gap L24) — the deterministic half of the
 * Saviynt "access intelligence" story, told honestly:
 *
 *  - **Queries with reasons.** Every recommendation is a stated, versioned
 *    rule over the gateway's own ledgers, computed at read time. The evidence
 *    (ids, counts, dates) renders next to each finding — enough to verify by
 *    hand — and the severity badge is a CLASS, never an ordering or a score.
 *  - **Nothing executes.** The page is a read of a read-only endpoint. The
 *    one action is human: "open a certification campaign from these", which
 *    snapshots exactly the currently-flagged grants into the ADR-0090 loop
 *    (named reviewers, one approvals queue, revoke-is-real).
 *  - **Unobservable is said.** Grants the unused rule cannot judge (a role
 *    with no current assignee) render under "not assessable" with the reason
 *    — never counted as unused.
 *  - **The model-judged half (L6c) is an ANNOTATION, opt-in and default off.**
 *    When the org enables it and a judge is dispatchable, a finding MAY carry
 *    a `model-judged` badge with the judge's verdict — rendered beside the
 *    deterministic evidence and visibly separate from it, never replacing it,
 *    never reordering, never adding a row. When it is enabled and no judge is
 *    reachable, the page says `judged: unavailable` rather than showing an
 *    unannotated report that looks like agreement.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Table, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import v from "../../views.module.css";

interface JudgeAnnotation {
  method: "model-judged";
  judge: string;
  verdict: "agree" | "disagree" | "unclear";
  note: string;
  limits: string;
}
type JudgedState =
  | { enabled: false; note: string }
  | { enabled: true; status: "judged"; judge: string; annotated: number; note: string }
  | { enabled: true; status: "unavailable"; error: string; reason: string; note: string };

interface Finding {
  key: string;
  judged?: JudgeAnnotation;
  grantKind: string | null;
  grantId: string | null;
  holder: { userId: string | null; roleId: string | null; label: string };
  object: { id: string; label: string; toolName: string | null } | null;
  rationale: string;
  evidence: Record<string, unknown>;
  grants?: Array<{ grantKind: string; grantId: string; side: string; object: { label: string } }>;
}
interface NotAssessable {
  grantKind: string;
  grantId: string;
  holder: { label: string };
  object: { label: string };
  reason: string;
}
interface RuleResult {
  id: string;
  version: number;
  severity: "informational" | "review-suggested";
  title: string;
  limits: string;
  findings: Finding[];
  notAssessable: NotAssessable[];
  counts: { findings: number; notAssessable: number };
}
interface Report {
  rulesVersion: number;
  window: { days: number; start: string; end: string };
  computedAt: string;
  notes: { what: string; action: string; observed: string; window: string };
  rules: RuleResult[];
  judged: JudgedState;
}

const severityTone = (s: RuleResult["severity"]): Tone => (s === "review-suggested" ? "warn" : "info");

/** the judged verdict is ADVISORY: no tone here implies a decision, and the
 * badge always carries the `model-judged` label so it cannot be read as
 * deterministic evidence */
const verdictTone = (v: JudgeAnnotation["verdict"]): Tone =>
  v === "disagree" ? "warn" : v === "unclear" ? "neutral" : "info";

/** a compact, hand-checkable one-liner from the evidence map */
const evidenceLine = (e: Record<string, unknown>): string =>
  Object.entries(e)
    .filter(([, val]) => val !== null && typeof val !== "object")
    .map(([k, val]) => `${k}: ${String(val)}`)
    .join(" · ");

export default function RecommendationsPage() {
  const act = useAction();
  const report = useQuery({
    queryKey: ["admin", "recommendations"],
    queryFn: () => api.get<Report>("/v1/recommendations/access"),
  });
  const [openedCampaign, setOpenedCampaign] = useState<string | null>(null);

  const openCampaignFrom = (rule: RuleResult) =>
    void act.run(async () => {
      const dueAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const res = await api.post<{ id: string }>("/v1/certification-campaigns", {
        name: `recommendations: ${rule.id}`,
        scope: { kind: "from_recommendations", value: rule.id },
        dueAt,
      });
      setOpenedCampaign(res.id);
      await report.refetch();
    }, "Campaign opened over exactly the grants this rule flags right now — each item routed to its named reviewer (due in 14 days)");

  const d = report.data;
  return (
    <>
      <PageHeader
        title="Access recommendations"
        sub="The deterministic half of access intelligence."
        info={<p>The deterministic half of access intelligence: every recommendation is a stated, versioned rule over this deployment's own ledgers, computed at read time with its evidence attached. No scores, no ranking — severity is a class. Nothing executes automatically: the action path is a certification campaign over exactly the flagged grants, or an ordinary revocation. The model-judged half is credential-blocked, not approximated.</p>}
      />
      <QueryGate loading={report.isLoading} error={report.error} onRetry={() => void report.refetch()}>
        {d && (
          <div className={v.stack}>
            <div className={v.faint}>
              Rules v{d.rulesVersion} · window {d.window.days} days (a parameter, not a truth) · computed{" "}
              {new Date(d.computedAt).toLocaleString()} · {d.notes.observed}
            </div>
            <div>
              {d.judged.enabled === false ? (
                <>
                  <Badge tone="neutral">model-judged: off</Badge>{" "}
                  <span className={v.faint}>{d.judged.note}</span>
                </>
              ) : d.judged.status === "unavailable" ? (
                <>
                  <Badge tone="danger">judged: unavailable ({d.judged.error})</Badge>{" "}
                  <span className={v.faint}>
                    {d.judged.reason} — {d.judged.note}
                  </span>
                </>
              ) : (
                <>
                  <Badge tone="info">model-judged: {d.judged.annotated} annotated</Badge>{" "}
                  <span className={v.faint}>
                    judge {d.judged.judge} — {d.judged.note}
                  </span>
                </>
              )}
            </div>
            {openedCampaign && (
              <div>
                <Badge tone="ok">campaign opened</Badge>{" "}
                <span className={v.faint}>
                  review and decide it on the Certification campaigns page — recommendations only feed the loop, they
                  never decide it.
                </span>
              </div>
            )}
            {d.rules.map((rule) => (
              <Card
                key={rule.id}
                title={`${rule.id} — ${rule.title}`}
                actions={
                  rule.counts.findings > 0 ? (
                    <Button disabled={act.busy} onClick={() => openCampaignFrom(rule)}>
                      Open certification campaign from these
                    </Button>
                  ) : undefined
                }
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={severityTone(rule.severity)}>{rule.severity}</Badge>{" "}
                    <span className={v.faint}>
                      rule {rule.id} · v{rule.version} · {rule.counts.findings} finding(s)
                      {rule.counts.notAssessable > 0 ? ` · ${rule.counts.notAssessable} not assessable` : ""}
                    </span>
                  </div>
                  {rule.counts.findings === 0 && rule.counts.notAssessable === 0 ? (
                    <div className={v.faint}>none — this rule currently flags no grant (a computed fact, not a clean bill of health)</div>
                  ) : (
                    <>
                      {rule.findings.length > 0 && (
                        <Table
                          rows={rule.findings}
                          rowKey={(r) => r.key}
                          columns={[
                            { key: "holder", header: "Holder", render: (r) => r.holder.label },
                            {
                              key: "object",
                              header: "Grant",
                              render: (r) =>
                                r.object?.label ??
                                (r.grants ? r.grants.map((g) => `${g.side}: ${g.object.label}`).join(" + ") : "—"),
                            },
                            {
                              key: "why",
                              header: "Why (evidence attached)",
                              render: (r) => (
                                <>
                                  <div>{r.rationale}</div>
                                  <div className={v.faint}>{evidenceLine(r.evidence)}</div>
                                  {r.judged && (
                                    <div>
                                      <Badge tone={verdictTone(r.judged.verdict)}>
                                        {r.judged.method}: {r.judged.verdict}
                                      </Badge>{" "}
                                      <span className={v.faint}>
                                        {r.judged.note} — advisory only ({r.judged.judge}); it did not create this
                                        finding and cannot change the evidence above.
                                      </span>
                                    </div>
                                  )}
                                </>
                              ),
                            },
                          ]}
                        />
                      )}
                      {rule.notAssessable.length > 0 && (
                        <div>
                          <div>
                            <Badge tone="warn">not assessable</Badge>{" "}
                            <span className={v.faint}>said outright, never counted as unused:</span>
                          </div>
                          {rule.notAssessable.map((n) => (
                            <div key={n.grantId} className={v.faint}>
                              {n.holder.label} → {n.object.label}: {n.reason}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <div className={v.faint}>{rule.limits}</div>
                </div>
              </Card>
            ))}
            {d.rules.every((r) => r.counts.findings === 0 && r.counts.notAssessable === 0) && (
              <EmptyState
                title="No rule currently flags any grant"
                body="A computed fact over the ledgers at this moment — not a clean bill of health. The rules see only what this gateway records."
              />
            )}
            <div className={v.faint}>{d.notes.action}</div>
          </div>
        )}
      </QueryGate>
    </>
  );
}
