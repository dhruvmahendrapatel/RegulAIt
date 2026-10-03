/**
 * Posture (ADR-0082, gap L8) — the boardroom one-pager over the operator
 * surfaces this group already renders. BOARD-SHAPED: large headline figures,
 * a plain-language line under each, and a link from every section to the
 * operator page that holds the detail. PRESENTATION ONLY: every number on
 * this page arrives from ONE `GET /v1/reports/posture` call that computes it
 * by SELECT over the real ledgers at request time — no rollup, no snapshot
 * (the ADR-0047 principle), and the page invents no figure of its own.
 *
 * Honesty rules, rendered rather than merely documented:
 *  - an empty ledger renders as UNMEASURED ("unmeasured, not resisted" for
 *    red-team history), never as a reassuring zero;
 *  - the ASR headline always carries its Wilson interval, trial denominator
 *    and measurement-quality label — never a bare rate;
 *  - tamper resistance is the OBSERVED grading from the anchor medium;
 *  - spend is labelled a list-price estimate on the face of the page.
 *
 * Print-friendly with CSS only (posture.module.css hides the app chrome
 * under @media print) — the ADR-0047 PDF dependency stays unresolved.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtUsd, ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import p from "./posture.module.css";

interface PostureDoc {
  generatedAt: string;
  window: { days: number };
  packs: {
    active: Array<{
      packId: string;
      framework: string;
      version: number;
      title: string;
      totals: { controls: number; satisfied: number; attested: number; attestationRequired: number; unaddressed: number };
      evidencedPct: number | null;
      statement: string;
    }>;
    note: string;
  };
  risks: { open: number; mitigating: number; accepted: number; closed: number; total: number; attestationOnly: number };
  redteam: {
    measured: boolean;
    runsInWindow: number;
    latest: {
      agentName: string;
      asr: number | null;
      asrLower: number | null;
      asrUpper: number | null;
      asrTrials: number;
      measurementQuality: string | null;
      platformHeld: number;
      startedAt: string;
    } | null;
    trend: Array<{ startedAt: string; asr: number | null; agentName: string }>;
    note: string;
  };
  evals: {
    runsInWindow: number;
    note?: string;
    groundedness: { runsInWindow: number; latest: { passRate: number | null; scorerKind: string } | null; note?: string };
  };
  spend: {
    period: { label: string };
    totalCostUsd: number;
    events: number;
    unattributedCostUsd: number;
    budgets: Array<{ projectId: string; projectName: string; budgetUsd: number; spentUsd: number; overBudget: boolean; budgetPeriod: string }>;
    overBudgetProjects: number;
    dailyTrend: Array<{ day: string; costUsd: number }>;
    estimate: boolean;
    disclaimer: string;
    note?: string;
  };
  governance: { denials: number; piiBlocks: number; approvalsPending: number; approvalsDecidedInWindow: number };
  auditChain: {
    anchors: number;
    latestAnchorAt: string | null;
    sink: { destination: string; tamperResistant: boolean; mode: string | null } | null;
    disclosure: string;
  };
  agentOwnership: {
    total: number;
    owned: number;
    unowned: number;
    orphaned: number;
    lifecycle: { active: number; deprecated: number; retired: number };
    note: string;
  };
  certificationCampaigns: {
    total: number;
    open: number;
    completed: number;
    expiredIncomplete: number;
    note: string;
  };
  sod: {
    rules: number;
    enabled: number;
    currentViolations: number;
    note: string;
  };
  accessRecommendations: {
    rulesVersion: number;
    windowDays: number;
    byRule: Array<{ id: string; severity: string; findings: number; notAssessable: number }>;
    totalFindings: number;
    totalNotAssessable: number;
    note: string;
  };
  useCases: { proposed: number; underReview: number; approved: number; rejected: number; retired: number; total: number };
  note: string;
}

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** headline figure + its plain-language line — the board-shaped unit */
function Headline(props: { value: React.ReactNode; label: string; line: React.ReactNode }) {
  return (
    <Card>
      <div className={v.stack}>
        <div>
          <div className={p.headline}>{props.value}</div>
          <div className={v.statLabel}>{props.label}</div>
        </div>
        <div className={p.oneLiner}>{props.line}</div>
      </div>
    </Card>
  );
}

/**
 * One column per calendar day across the whole window, zero where nothing
 * was spent. The server only lists days that had rows, so a window with one
 * busy day drew ONE bar the full width of the card (UIB-04). The window ends
 * on the latest day present (or today when nothing is) and is UTC, like the
 * server's day keys.
 */
export function fillDailyWindow<T extends { day: string }>(
  points: T[],
  days: number,
  zero: (day: string) => T,
  today: Date = new Date(),
): T[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  const last = [...byDay.keys()].sort().at(-1) ?? today.toISOString().slice(0, 10);
  const end = new Date(`${last}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return points;
  const out: T[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? zero(day));
  }
  return out;
}

/** compact inline SVG column trend — same token classes as adminKit's owned
 * BarChart, no chart library (the repo's standing rule) */
function ColumnTrend(props: {
  points: Array<{ label: string; value: number }>;
  title: string;
  format: (v: number) => string;
}) {
  const pts = props.points.slice(-14);
  if (pts.length === 0) return <EmptyState title="No data in the window" />;
  const max = Math.max(...pts.map((d) => d.value), 1e-9);
  const w = 640;
  const h = 120;
  const colW = w / pts.length;
  return (
    <div className={a.chartWrap}>
      <svg
        viewBox={`0 0 ${w} ${h + 18}`}
        role="img"
        aria-label={props.title}
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {pts.map((d, i) => {
          const bh = Math.max(2, (d.value / max) * (h - 8));
          return (
            <g key={i}>
              <title>{`${d.label} · ${props.format(d.value)}`}</title>
              <rect x={i * colW + 3} y={h - bh} width={Math.max(2, colW - 6)} height={bh} rx={2} className={a.chartBar} />
            </g>
          );
        })}
        <text x={0} y={h + 14} className={a.chartLabel}>
          {pts[0]?.label}
        </text>
        <text x={w} y={h + 14} textAnchor="end" className={a.chartLabel}>
          {pts[pts.length - 1]?.label}
        </text>
      </svg>
    </div>
  );
}

function SectionLink(props: { to: string; label?: string }) {
  return (
    <Link to={props.to} className={p.sectionLink}>
      {props.label ?? "operator detail →"}
    </Link>
  );
}

export default function PosturePage() {
  const q = useQuery({
    queryKey: ["admin", "posture"],
    queryFn: () => api.get<PostureDoc>("/v1/reports/posture"),
  });
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Posture"
        sub="The one-page executive read of what the operator pages hold."
        info={<p>The one-page executive read of everything the operator pages hold: pack coverage, open risks, red-team posture, spend vs budget, governance activity, audit anchoring and the use-case pipeline. Every number is computed from the real ledgers at the moment this page loads — nothing is a stored rollup — and where a ledger is empty the page says unmeasured, never zero-implies-good. Print this page for the meeting: the browser's print view drops the app chrome.</p>}
        actions={
          <span className={p.noPrint}>
            <Button variant="ghost" onClick={() => window.print()}>
              Print one-pager
            </Button>
          </span>
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {d && (
          <div className={v.stack}>
            {/* ---------------- headlines ---------------- */}
            <div className={v.grid4}>
              <Headline
                value={
                  d.packs.active.length === 0
                    ? "unmeasured"
                    : d.packs.active.map((pk) => `${pk.evidencedPct ?? "—"}%`).join(" · ")
                }
                label={
                  d.packs.active.length === 0
                    ? "compliance-pack coverage"
                    : `coverage — ${d.packs.active.map((pk) => pk.framework).join(", ")}`
                }
                line={
                  d.packs.active.length === 0 ? (
                    <>No compliance pack is active, so control coverage is unmeasured here — not satisfied. <SectionLink to="/admin/compliance-packs" /></>
                  ) : (
                    <>Share of mapped controls with current ledger evidence or a live attestation — a coverage count, never a compliance verdict. <SectionLink to="/admin/compliance-packs" /></>
                  )
                }
              />
              <Headline
                value={d.risks.open + d.risks.mitigating}
                label="open + mitigating risks"
                line={
                  <>
                    {d.risks.open} open, {d.risks.mitigating} being mitigated, {d.risks.accepted} formally accepted.{" "}
                    {d.risks.attestationOnly > 0 && (
                      <>{d.risks.attestationOnly} rest on attestation only — no ledger measures them.{" "}</>
                    )}
                    <SectionLink to="/admin/risks" />
                  </>
                }
              />
              <Headline
                value={d.redteam.measured && d.redteam.latest ? pct(d.redteam.latest.asr) : "unmeasured"}
                label="latest attack-success rate"
                line={
                  d.redteam.measured && d.redteam.latest ? (
                    <>
                      Against '{d.redteam.latest.agentName}' {ago(d.redteam.latest.startedAt)}: {pct(d.redteam.latest.asr)} of{" "}
                      {d.redteam.latest.asrTrials} trials succeeded (95% interval {pct(d.redteam.latest.asrLower)}–{pct(d.redteam.latest.asrUpper)},
                      quality: {d.redteam.latest.measurementQuality ?? "unlabelled"}); the platform itself stopped{" "}
                      {d.redteam.latest.platformHeld} induced call(s). <SectionLink to="/admin/redteam" />
                    </>
                  ) : (
                    <>
                      {d.redteam.note}. An untested surface is unmeasured, not resisted. <SectionLink to="/admin/redteam" />
                    </>
                  )
                }
              />
              <Headline
                value={fmtUsd(d.spend.totalCostUsd)}
                label={`AI spend — ${d.spend.period.label}`}
                line={
                  <>
                    {d.spend.events.toLocaleString()} metered calls; {d.spend.overBudgetProjects} project(s) over budget;{" "}
                    {fmtUsd(d.spend.unattributedCostUsd)} unattributed. List-price estimate, stated as such.{" "}
                    <SectionLink to="/admin/cost" />
                  </>
                }
              />
            </div>

            {/* ---------------- trends ---------------- */}
            <div className={v.grid2}>
              <Card title={`Daily AI spend — last 14 days (estimate)`}>
                <ColumnTrend
                  points={fillDailyWindow(d.spend.dailyTrend, 14, (day) => ({ day, costUsd: 0 })).map((x) => ({ label: x.day.slice(5), value: x.costUsd }))}
                  title="Daily spend, last 14 days"
                  format={fmtUsd}
                />
                <div className={v.faint}>{d.spend.disclaimer}</div>
              </Card>
              <Card title="Attack-success rate — last runs, oldest to newest">
                {d.redteam.trend.length === 0 ? (
                  <EmptyState title="Unmeasured" body="No red-team run has produced a measured rate — an untested surface, not a resisted one." />
                ) : (
                  <ColumnTrend
                    points={d.redteam.trend.map((x) => ({
                      label: x.startedAt.slice(5, 10),
                      value: x.asr ?? 0,
                    }))}
                    title="ASR trend"
                    format={(x) => pct(x)}
                  />
                )}
                <div className={v.faint}>{d.redteam.note}</div>
              </Card>
            </div>

            {/* ---------------- sections ---------------- */}
            <div className={v.grid2}>
              <Card title="Governance activity" actions={<SectionLink to="/admin/audit" label="audit log →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    In the last {d.window.days} days the gateway refused {d.governance.denials.toLocaleString()} governed
                    call(s), {d.governance.piiBlocks.toLocaleString()} of them PII blocks, and{" "}
                    {d.governance.approvalsDecidedInWindow.toLocaleString()} approval(s) were decided.{" "}
                    {d.governance.approvalsPending.toLocaleString()} approval(s) are pending right now.
                  </div>
                  <div className={p.oneLiner}>
                    <SectionLink to="/admin/approvals" label="approvals queue →" />
                  </div>
                </div>
              </Card>
              <Card title="Audit-trail anchoring" actions={<SectionLink to="/admin/audit" label="chain integrity →" />}>
                <div className={v.stack}>
                  <div>
                    {d.auditChain.sink ? (
                      <Badge tone={d.auditChain.sink.tamperResistant ? "ok" : "warn"}>
                        {d.auditChain.sink.tamperResistant ? "tamper-resistant (observed)" : "NOT tamper-resistant (observed)"}
                      </Badge>
                    ) : (
                      <Badge tone="warn">no anchor sink</Badge>
                    )}{" "}
                    <span className={v.faint}>
                      {d.auditChain.anchors} anchor(s)
                      {d.auditChain.latestAnchorAt ? `, latest ${ago(d.auditChain.latestAnchorAt)}` : ""}
                    </span>
                  </div>
                  <div className={p.oneLiner}>{d.auditChain.disclosure}</div>
                </div>
              </Card>
              <Card title="Evaluations & groundedness" actions={<SectionLink to="/admin/evals" label="evaluations →" />}>
                <div className={p.oneLiner}>
                  {d.evals.runsInWindow === 0 ? (
                    <>No eval run in the window — model quality is unmeasured here, not assumed.</>
                  ) : (
                    <>
                      {d.evals.runsInWindow.toLocaleString()} eval run(s) in the window,{" "}
                      {d.evals.groundedness.runsInWindow.toLocaleString()} of them groundedness-scored
                      {d.evals.groundedness.latest?.passRate != null && (
                        <> — latest groundedness pass rate {pct(d.evals.groundedness.latest.passRate)}</>
                      )}
                      .
                    </>
                  )}
                  {d.evals.groundedness.note && <> {d.evals.groundedness.note}.</>}
                </div>
              </Card>
              <Card title="Agent ownership" actions={<SectionLink to="/admin/inventory" label="agent inventory →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.agentOwnership.total === 0 ? (
                      <>No agent is registered yet.</>
                    ) : (
                      <>
                        Of {d.agentOwnership.total} registered agent(s), {d.agentOwnership.owned} have a recorded owner,{" "}
                        {d.agentOwnership.unowned} are unowned (no owner recorded), and {d.agentOwnership.orphaned} are
                        orphaned (owner deactivated). Lifecycle: {d.agentOwnership.lifecycle.active} active,{" "}
                        {d.agentOwnership.lifecycle.deprecated} deprecated, {d.agentOwnership.lifecycle.retired} retired.
                      </>
                    )}
                  </div>
                  {(d.agentOwnership.unowned > 0 || d.agentOwnership.orphaned > 0) && (
                    <div>
                      {d.agentOwnership.unowned > 0 && <Badge tone="warn">{d.agentOwnership.unowned} unowned</Badge>}{" "}
                      {d.agentOwnership.orphaned > 0 && <Badge tone="danger">{d.agentOwnership.orphaned} orphaned</Badge>}
                    </div>
                  )}
                  <div className={v.faint}>{d.agentOwnership.note}</div>
                </div>
              </Card>
              <Card title="Grant certification" actions={<SectionLink to="/admin/certification" label="campaigns →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.certificationCampaigns.total === 0 ? (
                      <>No certification campaign has ever been run — gateway grants have never been re-attested.</>
                    ) : (
                      <>
                        {d.certificationCampaigns.total} campaign(s): {d.certificationCampaigns.open} open,{" "}
                        {d.certificationCampaigns.completed} completed, {d.certificationCampaigns.expiredIncomplete}{" "}
                        expired-incomplete.
                      </>
                    )}
                  </div>
                  {d.certificationCampaigns.expiredIncomplete > 0 && (
                    <div>
                      <Badge tone="danger">{d.certificationCampaigns.expiredIncomplete} expired-incomplete</Badge>
                    </div>
                  )}
                  <div className={v.faint}>{d.certificationCampaigns.note}</div>
                </div>
              </Card>
              <Card title="Separation of duties" actions={<SectionLink to="/admin/sod" label="SoD rules →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.sod.rules === 0 ? (
                      <>No SoD rule is defined — no capability combination is declared toxic.</>
                    ) : (
                      <>
                        {d.sod.rules} SoD rule(s), {d.sod.enabled} enabled — {d.sod.currentViolations} current
                        violation(s).
                      </>
                    )}
                  </div>
                  {d.sod.currentViolations > 0 && (
                    <div>
                      <Badge tone="danger">{d.sod.currentViolations} violation(s)</Badge>
                    </div>
                  )}
                  <div className={v.faint}>{d.sod.note}</div>
                </div>
              </Card>
              <Card
                title="Access recommendations"
                actions={<SectionLink to="/admin/recommendations" label="recommendations →" />}
              >
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.accessRecommendations.totalFindings === 0 ? (
                      <>None — no deterministic rule currently flags any grant.</>
                    ) : (
                      <>
                        {d.accessRecommendations.totalFindings} finding(s) across the v
                        {d.accessRecommendations.rulesVersion} rules:{" "}
                        {d.accessRecommendations.byRule
                          .filter((r) => r.findings > 0)
                          .map((r) => `${r.id} ${r.findings}`)
                          .join(", ")}
                        .
                      </>
                    )}{" "}
                    {d.accessRecommendations.totalNotAssessable > 0 && (
                      <>{d.accessRecommendations.totalNotAssessable} grant(s) not assessable.</>
                    )}
                  </div>
                  <div className={v.faint}>{d.accessRecommendations.note}</div>
                </div>
              </Card>
              <Card title="AI use-case pipeline" actions={<SectionLink to="/admin/use-cases" label="use cases →" />}>
                <div className={p.oneLiner}>
                  {d.useCases.total === 0 ? (
                    <>None recorded — no AI use case has been proposed through the intake front-door yet.</>
                  ) : (
                    <>
                      {d.useCases.total} registered: {d.useCases.proposed} proposed, {d.useCases.underReview} under review,{" "}
                      {d.useCases.approved} approved, {d.useCases.rejected} rejected, {d.useCases.retired} retired.
                    </>
                  )}
                </div>
              </Card>
            </div>

            {/* ---------------- budgets ---------------- */}
            <Card title={`Budgets — ${d.spend.period.label}`} actions={<SectionLink to="/admin/cost" label="cost dashboard →" />}>
              {d.spend.budgets.length === 0 ? (
                <EmptyState title="No project carries a budget" body="Budget-vs-actual appears here once a project has a budget set." />
              ) : (
                <div className={v.stack}>
                  {d.spend.budgets.map((b) => (
                    <div key={b.projectId} className={v.listRow}>
                      <span className={v.grow}>{b.projectName}</span>
                      <span className={v.num}>
                        {fmtUsd(b.spentUsd)} / {fmtUsd(b.budgetUsd)}{" "}
                        <span className={v.faint}>({b.budgetPeriod === "monthly" ? "monthly" : "lifetime"})</span>
                      </span>
                      {b.overBudget ? <Badge tone="danger">over budget</Badge> : <Badge tone="ok">within</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* ---------------- pack detail lines ---------------- */}
            {d.packs.active.length > 0 && (
              <Card title="Compliance packs — coverage statements" actions={<SectionLink to="/admin/compliance-packs" label="packs →" />}>
                <div className={v.stack}>
                  {d.packs.active.map((pk) => (
                    <div key={pk.packId}>
                      <strong>
                        {pk.framework} v{pk.version}
                      </strong>{" "}
                      <Badge tone="info">{pk.evidencedPct ?? "—"}% evidenced/attested</Badge>
                      <div className={p.oneLiner}>{pk.statement}</div>
                    </div>
                  ))}
                  <div className={v.faint}>{d.packs.note}</div>
                </div>
              </Card>
            )}

            <div className={v.faint}>
              Generated {ago(d.generatedAt)} · {d.note}
            </div>
          </div>
        )}
      </QueryGate>
    </>
  );
}
