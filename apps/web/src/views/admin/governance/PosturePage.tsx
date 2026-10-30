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
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { resyncOutcomeText, resyncRefusalText, resyncUseCase } from "./useCaseResync";
import { api } from "../../../api/client";
import { fmtUsd, ago, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, InfoButton } from "../../../ui/kit";
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
  useCases: {
    proposed: number;
    underReview: number;
    approved: number;
    rejected: number;
    retired: number;
    total: number;
    /** ADR-0189 R25 item 13 follow-up: intake workflow completed, use case never approved */
    instanceCompletedNotApproved?: { count: number; sampleUseCaseIds: string[]; action: string };
  };
  note: string;
}

const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** headline figure + label — the board-shaped unit; its plain-language line is the label's (i), and the operator
 * detail link and any honesty chip stay visible */
function Headline(props: { value: React.ReactNode; label: string; line: React.ReactNode; link: React.ReactNode; chip?: React.ReactNode }) {
  return (
    <Card>
      <div className={v.stack}>
        <div>
          <div className={p.headline}>{props.value}</div>
          <div className={v.statLabel}>
            {props.label}
            <InfoButton label={props.label}>{props.line}</InfoButton>
          </div>
        </div>
        {props.chip ? <div>{props.chip}</div> : null}
        <div className={p.oneLiner}>{props.link}</div>
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
  // The window ends TODAY, like the server's query (now − 14 d .. now), not
  // on the last busy day: ending there would invent zero days from before
  // the query window and hide the quiet days since the last spend.
  const byDay = new Map(points.map((p) => [p.day, p]));
  const end = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
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
  if (pts.length === 0) return <EmptyState title="No data in the window" body="This trend fills in as governed calls are recorded. Widen the time window, or check back after the next calls." />;
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

/**
 * ADR-0189 R25 item 13 follow-up: use cases whose intake workflow completed but
 * which were never approved (no signing key when it completed). Each example
 * links to its use case and can be re-synced here; the re-sync asks for a
 * step-up, which only a signed-in browser session can give.
 */
function BehindCompletedInstance(props: { item: { count: number; sampleUseCaseIds: string[]; action: string } }) {
  const queryClient = useQueryClient();
  // names for the links: a bare UUID tells the reader nothing (X5); shares the registry's cache entry
  const useCases = useQuery({
    queryKey: ["admin", "use-cases"],
    queryFn: () => api.get<{ useCases?: Array<{ id: string; name: string }> }>("/v1/use-cases"),
    enabled: props.item.count > 0,
  });
  const nameOf = (id: string) => useCases.data?.useCases?.find((u) => u.id === id)?.name ?? `Use case ${id.slice(0, 8)}`;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const run = async (id: string) => {
    setBusyId(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await resyncUseCase(id);
      setOutcome(resyncOutcomeText(r));
      // the row this button sat in leaves the list: focus moves to the result
      requestAnimationFrame(() => outcomeRef.current?.focus());
      await queryClient.invalidateQueries({ queryKey: ["admin", "posture"] });
    } catch (e) {
      setErrors((prev) => ({ ...prev, [id]: resyncRefusalText(e) }));
    } finally {
      setBusyId(null);
    }
  };
  // stays mounted after the last one is re-synced, so the result line keeps its focus
  if (props.item.count === 0 && !outcome) return null;
  return (
    <div className={v.stack}>
      {props.item.count > 0 && (
        <div className={p.oneLiner}>
          <Badge tone="warn">needs a re-sync</Badge> {plural(props.item.count, "use case")} whose intake workflow completed {props.item.count === 1 ? "was" : "were"} never
          approved.
        </div>
      )}
      <ul className={v.stack} aria-label="Use cases to re-sync">
        {props.item.sampleUseCaseIds.map((id) => (
          <li key={id} className={v.listRow}>
            <Link className={v.grow} to={`/admin/governance/use-cases/${id}`}>
              {nameOf(id)}
            </Link>
            <span className={p.noPrint}>
              {/* aria-disabled, not disabled: a disabled button drops focus to the page,
                  so on a refusal the person would lose their place in the list */}
              <Button
                size="sm"
                onClick={() => {
                  if (busyId === null) void run(id);
                }}
                aria-disabled={busyId !== null}
                aria-busy={busyId === id}
                aria-label={`Re-sync use case ${id}`}
              >
                {busyId === id ? "Re-syncing…" : "Re-sync"}
              </Button>
            </span>
            {errors[id] ? (
              <div role="alert" className={v.faint}>
                {errors[id]}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div ref={outcomeRef} tabIndex={-1} role="status" aria-live="polite" className={v.faint}>
        {outcome ?? ""}
      </div>
      {props.item.count > 0 && <div className={v.faint}>{props.item.action}</div>}
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
                    <>No compliance pack is active, so control coverage is unmeasured here — not satisfied.</>
                  ) : (
                    <>Share of mapped controls with current ledger evidence or a live attestation — a coverage count, never a compliance verdict.</>
                  )
                }
                link={<SectionLink to="/admin/compliance-packs" />}
              />
              <Headline
                value={d.risks.open + d.risks.mitigating}
                label="open + mitigating risks"
                line={
                  <>
                    {d.risks.open} open, {d.risks.mitigating} being mitigated, {d.risks.accepted} formally accepted.
                    {d.risks.attestationOnly > 0 && (
                      <> {d.risks.attestationOnly} rest on attestation only — no ledger measures them.</>
                    )}
                  </>
                }
                chip={d.risks.attestationOnly > 0 ? <Badge>{`${d.risks.attestationOnly} attestation only`}</Badge> : null}
                link={<SectionLink to="/admin/risks" />}
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
                      {plural(d.redteam.latest.platformHeld, "induced call")}.
                    </>
                  ) : (
                    <>{d.redteam.note}. An untested surface is unmeasured, not resisted.</>
                  )
                }
                link={<SectionLink to="/admin/redteam" />}
              />
              <Headline
                value={fmtUsd(d.spend.totalCostUsd)}
                label={`AI spend — ${d.spend.period.label}`}
                line={
                  <>
                    {d.spend.events.toLocaleString()} metered calls; {plural(d.spend.overBudgetProjects, "project")} over budget;{" "}
                    {fmtUsd(d.spend.unattributedCostUsd)} unattributed. List-price estimate, stated as such.
                  </>
                }
                chip={<Badge tone="warn">Estimate</Badge>}
                link={<SectionLink to="/admin/cost" />}
              />
            </div>

            {/* ---------------- trends ---------------- */}
            <div className={v.grid2}>
              <Card
                title={<>Daily AI spend — last 14 days <Badge tone="warn">Estimate</Badge></>}
                infoLabel="Daily AI spend"
                info={<p>{d.spend.disclaimer}</p>}
              >
                <ColumnTrend
                  points={fillDailyWindow(d.spend.dailyTrend, 14, (day) => ({ day, costUsd: 0 })).map((x) => ({ label: x.day.slice(5), value: x.costUsd }))}
                  title="Daily spend, last 14 days"
                  format={fmtUsd}
                />
              </Card>
              <Card title="Attack-success rate — last runs, oldest to newest" infoLabel="Attack-success rate" info={<p>{d.redteam.note}</p>}>
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
              </Card>
            </div>

            {/* ---------------- sections ---------------- */}
            <div className={v.grid2}>
              <Card title="Governance activity" actions={<SectionLink to="/admin/audit" label="audit log →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    In the last {d.window.days} days the gateway refused {plural(d.governance.denials, "governed call")}, {d.governance.piiBlocks.toLocaleString()} of them PII blocks, and{" "}
                    {plural(d.governance.approvalsDecidedInWindow, "approval")} {d.governance.approvalsDecidedInWindow === 1 ? "was" : "were"} decided.{" "}
                    {plural(d.governance.approvalsPending, "approval")} {d.governance.approvalsPending === 1 ? "is" : "are"} pending right now.
                  </div>
                  <div className={p.oneLiner}>
                    <SectionLink to="/admin/approvals" label="approvals queue →" />
                  </div>
                </div>
              </Card>
              <Card
                title="Audit-trail anchoring"
                info={<p>{d.auditChain.disclosure}</p>}
                actions={<SectionLink to="/admin/audit" label="chain integrity →" />}
              >
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
                      {plural(d.auditChain.anchors, "anchor")}
                      {d.auditChain.latestAnchorAt ? `, latest ${ago(d.auditChain.latestAnchorAt)}` : ""}
                    </span>
                  </div>
                </div>
              </Card>
              <Card
                title="Evaluations & groundedness"
                info={d.evals.groundedness.note ? <p>{d.evals.groundedness.note}.</p> : undefined}
                actions={<SectionLink to="/admin/evals" label="evaluations →" />}
              >
                <div className={p.oneLiner}>
                  {d.evals.runsInWindow === 0 ? (
                    <>No eval run in the window — model quality is unmeasured here, not assumed.</>
                  ) : (
                    <>
                      {plural(d.evals.runsInWindow, "eval run")} in the window,{" "}
                      {d.evals.groundedness.runsInWindow.toLocaleString()} of them groundedness-scored
                      {d.evals.groundedness.latest?.passRate != null && (
                        <> — latest groundedness pass rate {pct(d.evals.groundedness.latest.passRate)}</>
                      )}
                      .
                    </>
                  )}
                </div>
              </Card>
              <Card title="Agent ownership" info={<p>{d.agentOwnership.note}</p>} actions={<SectionLink to="/admin/inventory" label="agent inventory →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.agentOwnership.total === 0 ? (
                      <>No agent is registered yet.</>
                    ) : (
                      <>
                        Of {plural(d.agentOwnership.total, "registered agent")}, {d.agentOwnership.owned} {d.agentOwnership.owned === 1 ? "has" : "have"} a recorded owner,{" "}
                        {d.agentOwnership.unowned} {d.agentOwnership.unowned === 1 ? "is" : "are"} unowned (no owner recorded), and {d.agentOwnership.orphaned}{" "}
                        {d.agentOwnership.orphaned === 1 ? "is" : "are"} orphaned (owner deactivated). Lifecycle: {d.agentOwnership.lifecycle.active} active,{" "}
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
                </div>
              </Card>
              <Card title="Grant certification" info={<p>{d.certificationCampaigns.note}</p>} actions={<SectionLink to="/admin/certification" label="campaigns →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.certificationCampaigns.total === 0 ? (
                      <>No certification campaign has ever been run — gateway grants have never been re-attested.</>
                    ) : (
                      <>
                        {plural(d.certificationCampaigns.total, "campaign")}: {d.certificationCampaigns.open} open,{" "}
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
                </div>
              </Card>
              <Card title="Separation of duties" info={<p>{d.sod.note}</p>} actions={<SectionLink to="/admin/sod" label="SoD rules →" />}>
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.sod.rules === 0 ? (
                      <>No SoD rule is defined — no capability combination is declared toxic.</>
                    ) : (
                      <>
                        {plural(d.sod.rules, "SoD rule")}, {d.sod.enabled} enabled — {d.sod.currentViolations} current{" "}
                        {d.sod.currentViolations === 1 ? "violation" : "violations"}.
                      </>
                    )}
                  </div>
                  {d.sod.currentViolations > 0 && (
                    <div>
                      <Badge tone="danger">{plural(d.sod.currentViolations, "violation")}</Badge>
                    </div>
                  )}
                </div>
              </Card>
              <Card
                title="Access recommendations"
                info={<p>{d.accessRecommendations.note}</p>}
                actions={<SectionLink to="/admin/recommendations" label="recommendations →" />}
              >
                <div className={v.stack}>
                  <div className={p.oneLiner}>
                    {d.accessRecommendations.totalFindings === 0 ? (
                      <>None — no deterministic rule currently flags any grant.</>
                    ) : (
                      <>
                        {plural(d.accessRecommendations.totalFindings, "finding")} across the v
                        {d.accessRecommendations.rulesVersion} rules:{" "}
                        {d.accessRecommendations.byRule
                          .filter((r) => r.findings > 0)
                          .map((r) => `${r.id} ${r.findings}`)
                          .join(", ")}
                        .
                      </>
                    )}{" "}
                    {d.accessRecommendations.totalNotAssessable > 0 && (
                      <>{plural(d.accessRecommendations.totalNotAssessable, "grant")} not assessable.</>
                    )}
                  </div>
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
                {d.useCases.instanceCompletedNotApproved && (
                  <BehindCompletedInstance item={d.useCases.instanceCompletedNotApproved} />
                )}
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
              <Card
                title="Compliance packs — coverage statements"
                info={<p>{d.packs.note}</p>}
                actions={<SectionLink to="/admin/compliance-packs" label="packs →" />}
              >
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
