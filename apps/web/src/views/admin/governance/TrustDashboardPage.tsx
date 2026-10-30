import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Card, EmptyState, InfoButton, StatusDot } from "../../../ui/kit";
import { QueryGate, Stat } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type DimensionKey = "bias" | "security" | "privacy" | "reliability" | "safety" | "compliance";
type RiskStateCounts = { open: number; mitigating: number; accepted: number; closed: number };

interface TrustDimension {
  key: DimensionKey;
  label: string;
  measured: boolean;
  evidenceCoveragePct: number | null;
  controlsEvidenced: number;
  controlsApplicable: number;
  risks: RiskStateCounts;
}

interface HeatCell {
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high";
  count: number;
}

interface TrustReport {
  generatedAt: string;
  window: { start: string; end: string; days: number };
  scope: { projectId: string | null; label: string };
  packsEvaluated: Array<{ framework: string; version: number; controls: number }>;
  dimensions: TrustDimension[];
  totals: {
    risksFound: number;
    risksMitigated: number;
    risksAccepted: number;
    risksOpen: number;
    risksUnmitigated: number;
    evidenceCoveragePct: number | null;
    controlsEvidenced: number;
    controlsApplicable: number;
    useCases: Record<string, number>;
  };
  heatmap: HeatCell[];
  residualHeatmap: HeatCell[];
  definitions: Record<string, string>;
}

const trustQuery = () => ({
  queryKey: ["admin", "trust-report"],
  queryFn: () => api.get<TrustReport>("/v1/reports/trust"),
});

const formatCoverage = (value: number | null) => (value == null ? "Unmeasured" : `${value}%`);

/** plain-language reading guide; the API's `definitions` carry the same meaning for integrators (ADR-0148) */
const READING_GUIDE: Array<[string, string]> = [
  [
    "Evidence coverage",
    "For each dimension, the share of applicable controls in your active compliance packs that platform evidence or a live attestation currently satisfies. It measures coverage — not compliance, and not a trust score.",
  ],
  [
    "Unmeasured",
    "No active pack has a control for that dimension. It is drawn as a gap to close, never as zero.",
  ],
  [
    "Mitigated",
    "Closed risks, and live risks with at least one linked control and a declared residual position. Accepted risks are a recorded decision to carry the risk and are counted separately.",
  ],
  [
    "Not yet mitigated",
    "Live risks without that mitigation. Mitigated, accepted and not yet mitigated add up to the risks found.",
  ],
  [
    "Heatmap",
    "Live risks placed by declared likelihood and impact — human judgments on a three-level scale, never computed scores. The residual view uses the declared residual position where one exists.",
  ],
];

export default function TrustDashboardPage() {
  const q = useQuery(trustQuery());
  const alerts = useQuery({
    queryKey: ["governance", "alerts", "active"],
    queryFn: () => api.get<{ counts: { open: number; acknowledged: number }; lastEvaluatedAt: string | null }>("/v1/governance/alerts?status=active"),
  });
  const [active, setActive] = useState<DimensionKey>("bias");
  const activeAlerts = (alerts.data?.counts.open ?? 0) + (alerts.data?.counts.acknowledged ?? 0);
  const monitorLabel = alerts.isLoading
    ? "Loading governance monitor…"
    : alerts.isError
      ? "Governance monitor unavailable"
      : !alerts.data?.lastEvaluatedAt
        ? "Governance monitor not evaluated"
        : `${plural(activeAlerts, "active governance alert")}`;
  const monitorTone = alerts.isError || !alerts.data?.lastEvaluatedAt
    ? "neutral"
    // green only when nothing is active: acknowledged alerts still count as active, so they read as a warning
    : alerts.data.counts.open > 0 ? "danger" : alerts.data.counts.acknowledged > 0 ? "warn" : "ok";

  return (
    <>
      <PageHeader
        title="Trust & evidence"
        info={
          <>
            <p>
              Evidence coverage is the share of applicable controls with current evidence. It is not a trust score,
              certification, or compliance percentage. An unavailable measurement stays unmeasured rather than becoming zero.
            </p>
            {/* the reading guide lives here, one click away, instead of as a card at the foot of the page */}
            {READING_GUIDE.map(([term, text]) => (
              <p key={term}><strong>{term}.</strong> {text}</p>
            ))}
          </>
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data ? (
          <TrustReportView
            report={q.data}
            active={active}
            onActive={setActive}
            monitor={<Link to="/admin/governance/alerts" className={s.monitorLink}><StatusDot tone={monitorTone} /><span>{monitorLabel}</span></Link>}
          />
        ) : null}
      </QueryGate>
    </>
  );
}

function TrustReportView(props: {
  report: TrustReport;
  active: DimensionKey;
  onActive: (key: DimensionKey) => void;
  monitor: ReactNode;
}) {
  const d = props.report;
  const current = d.dimensions.find((item) => item.key === props.active) ?? d.dimensions[0];
  return (
    <div className={v.stack}>
      {/* one meta line: scope, window, packs, generated, and the monitor state */}
      <div className={`${v.row} ${s.metaLine}`}>
        {/* A6: the UI's own spelling; the gateway's scope label is "Organization" */}
        <span>{d.scope.projectId == null ? "Organisation" : "Project"}</span>
        <span aria-hidden>·</span>
        <span>Last {d.window.days} days</span>
        <span aria-hidden>·</span>
        <span>{d.packsEvaluated.length} active pack{d.packsEvaluated.length === 1 ? "" : "s"} evaluated</span>
        <span aria-hidden>·</span>
        <span>generated {fmtDateTime(d.generatedAt)}</span>
        <span className={v.grow} />
        {props.monitor}
      </div>

      {/* G4: the tile that needs attention reads first: a stripe and a next step, never a score */}
      <div className={s.trustTiles}>
        <div className={v.stat}>
          <span className={v.statValue}>{d.totals.risksFound.toLocaleString()}</span>
          <span className={v.statLabel}>Risks found</span>
          {d.totals.risksAccepted > 0 ? <span className={v.faint}>{d.totals.risksAccepted.toLocaleString()} accepted</span> : null}
        </div>
        <div className={`${v.stat} ${s.tileOk}`}>
          <span className={v.statValue}>{d.totals.risksMitigated.toLocaleString()}</span>
          <span className={v.statLabel}>
            Mitigated
            <InfoButton label="Mitigated">Closed, or a linked control and a residual rating</InfoButton>
          </span>
        </div>
        <div className={`${v.stat} ${d.totals.risksUnmitigated > 0 ? s.tileAttention : ""}`}>
          <span className={v.statValue}>{d.totals.risksUnmitigated.toLocaleString()}</span>
          <span className={v.statLabel}>Not yet mitigated</span>
          {d.totals.risksUnmitigated > 0 ? <Link to="/admin/risks">{`Review the ${plural(d.totals.risksUnmitigated, "risk")}`}</Link> : null}
        </div>
        <div className={`${v.stat} ${s.tileInfo}`}>
          <span className={v.statValue}>{formatCoverage(d.totals.evidenceCoveragePct)}</span>
          <span className={v.statLabel}>
            Evidence coverage
            <InfoButton label="Evidence coverage" align="end">
              The share of applicable controls with current evidence. It is not a compliance score. An unmeasured dimension is a gap, not zero.
            </InfoButton>
          </span>
          <span className={v.faint}>{d.totals.controlsEvidenced} of {d.totals.controlsApplicable} controls</span>
        </div>
      </div>

      <div className={s.dashboardGrid}>
        <CoverageCard dimensions={d.dimensions} />
        <Card
          title="Risk position"
          info={
            <>
              <p>Inherent is before controls, residual is after. Each cell counts open, mitigating and accepted risks. Closed risks are left out.</p>
              <p>Cell colour shows the zone of that likelihood and impact pair on the severity scale. The number is the count of risks; empty cells fade.</p>
            </>
          }
        >
          <div className={s.heatPair}>
            <div className={v.stack}>
              <strong>Inherent (before controls)</strong>
              <Heatmap cells={d.heatmap} label="Inherent risk" />
            </div>
            <div className={v.stack}>
              <strong>Residual (after controls)</strong>
              <Heatmap cells={d.residualHeatmap} label="Residual risk" />
            </div>
          </div>
        </Card>
      </div>

      <Card title="Dimension drilldown">
        <div className={s.dimensionList} aria-label="Trust dimensions">
          {d.dimensions.map((dimension) => (
            <button
              key={dimension.key}
              type="button"
              className={`${s.dimensionButton} ${dimension.key === props.active ? s.dimensionButtonActive : ""}`}
              aria-pressed={dimension.key === props.active}
              onClick={() => props.onActive(dimension.key)}
            >
              <span>{dimension.label}</span>
              <span className={s.dimensionValue}>{formatCoverage(dimension.evidenceCoveragePct)}</span>
              <span className={v.faint}>
                {dimension.measured
                  ? `${dimension.controlsEvidenced}/${dimension.controlsApplicable} controls evidenced`
                  : "No applicable measured controls in the active packs"}
              </span>
            </button>
          ))}
        </div>
        {current ? (
          <div className={v.stack} style={{ marginTop: "var(--s2)" }} aria-live="polite">
            <div className={v.row}>
              <strong>{current.label}</strong>
              <Badge tone={current.measured ? "info" : "neutral"}>{current.measured ? "Measured" : "Unmeasured"}</Badge>
            </div>
            <div className={v.grid4}>
              <Stat value={current.risks.open} label="Open" />
              <Stat value={current.risks.mitigating} label="Mitigating" />
              <Stat value={current.risks.accepted} label="Accepted" />
              <Stat value={current.risks.closed} label="Closed" />
            </div>
          </div>
        ) : null}
      </Card>

    </div>
  );
}

const VIEW_KEY = "regulait.trust.coverageView";
const readView = (): "bars" | "radar" => {
  try {
    return localStorage.getItem(VIEW_KEY) === "radar" ? "radar" : "bars";
  } catch {
    return "bars";
  }
};

/** G4 (owner change b): the same coverage as a sorted bar list (default) or the radar, remembered in this browser */
function CoverageCard({ dimensions }: { dimensions: TrustDimension[] }) {
  const [view, setView] = useState<"bars" | "radar">(readView);
  const choose = (next: "bars" | "radar") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this visit only */
    }
  };
  const sorted = [...dimensions].sort((a, b) => (b.evidenceCoveragePct ?? -1) - (a.evidenceCoveragePct ?? -1));
  return (
    <Card
      title="Evidence coverage by dimension"
      actions={
        <div className={s.segmented} role="group" aria-label="Chart view">
          <button type="button" aria-pressed={view === "bars"} onClick={() => choose("bars")}>Bars</button>
          <button type="button" aria-pressed={view === "radar"} onClick={() => choose("radar")}>Radar</button>
        </div>
      }
    >
      {view === "radar" ? (
        <Radar dimensions={dimensions} />
      ) : (
        <ul className={s.coverageBars} aria-label="Evidence coverage by dimension">
          {sorted.map((dimension) => (
            <li key={dimension.key}>
              <span>{dimension.label}</span>
              <span className={dimension.measured ? s.coverageTrack : s.coverageGap} aria-hidden="true">
                {dimension.measured ? <span style={{ inlineSize: `${Math.max(0, Math.min(100, dimension.evidenceCoveragePct ?? 0))}%` }} /> : null}
              </span>
              <span className={s.coverageValue}>
                {dimension.measured ? `${dimension.evidenceCoveragePct ?? 0}%` : (
                  <>
                    Unmeasured
                    <InfoButton label="Unmeasured" align="end">
                      No active pack has a measurable control for this dimension, so no number is shown rather than a guess.
                    </InfoButton>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Radar({ dimensions }: { dimensions: TrustDimension[] }) {
  const cx = 160;
  const cy = 145;
  const radius = 96;
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / dimensions.length;
    return { x: cx + Math.cos(angle) * radius * value, y: cy + Math.sin(angle) * radius * value };
  };
  const rings = [0.25, 0.5, 0.75, 1];
  const links = useMemo(
    () =>
      dimensions.flatMap((dimension, index) => {
        const nextIndex = (index + 1) % dimensions.length;
        const next = dimensions[nextIndex];
        if (!dimension.measured || !next?.measured) return [];
        const from = point(index, Math.max(0, Math.min(1, (dimension.evidenceCoveragePct ?? 0) / 100)));
        const to = point(nextIndex, Math.max(0, Math.min(1, (next.evidenceCoveragePct ?? 0) / 100)));
        return [{ from, to, key: `${dimension.key}-${next.key}` }];
      }),
    [dimensions],
  );
  const aria = dimensions
    .map((d) => `${d.label}: ${d.measured ? `${d.evidenceCoveragePct ?? 0} percent` : "unmeasured"}`)
    .join("; ");
  return (
    <svg className={s.radar} viewBox="0 0 320 300" role="img" aria-label={`Evidence coverage radar. ${aria}`}>
      {rings.map((ring) => (
        <polygon
          key={ring}
          className={s.radarGrid}
          points={dimensions.map((_, index) => point(index, ring)).map((p) => `${p.x},${p.y}`).join(" ")}
        />
      ))}
      {dimensions.map((dimension, index) => {
        const end = point(index, 1);
        return (
          <line
            key={dimension.key}
            className={`${s.radarAxis} ${dimension.measured ? "" : s.radarGapAxis}`}
            x1={cx}
            y1={cy}
            x2={end.x}
            y2={end.y}
          />
        );
      })}
      {links.map((link) => (
        <line key={link.key} className={s.radarLink} x1={link.from.x} y1={link.from.y} x2={link.to.x} y2={link.to.y} />
      ))}
      {dimensions.map((dimension, index) => {
        const measured = point(index, Math.max(0.08, Math.min(1, (dimension.evidenceCoveragePct ?? 0) / 100)));
        const label = point(index, 1.28);
        return (
          <g key={dimension.key}>
            <circle
              className={dimension.measured ? s.radarDot : s.radarGap}
              cx={dimension.measured ? measured.x : point(index, 0.14).x}
              cy={dimension.measured ? measured.y : point(index, 0.14).y}
              r={dimension.measured ? 5 : 7}
            />
            <text className={s.radarLabel} x={label.x} y={label.y} textAnchor="middle">
              {dimension.label}
            </text>
            {!dimension.measured ? (
              <text className={s.radarGapLabel} x={label.x} y={label.y + 14} textAnchor="middle">
                unmeasured
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const RANK = { low: 0, medium: 1, high: 2 } as const;
const ZONE = ["low", "low", "medium", "high", "high"] as const;

function Heatmap({ cells, label }: { cells: HeatCell[]; label: string }) {
  const levels: HeatCell["likelihood"][] = ["high", "medium", "low"];
  const impacts: HeatCell["impact"][] = ["low", "medium", "high"];
  const count = (likelihood: HeatCell["likelihood"], impact: HeatCell["impact"]) =>
    cells.find((cell) => cell.likelihood === likelihood && cell.impact === impact)?.count ?? 0;
  // the cells inside role="img" are presentational, so every cell's count and zone is in the image's own name
  const cellNames = levels.flatMap((likelihood) => impacts.map((impact) => {
    const zone = ZONE[RANK[likelihood] + RANK[impact]]!;
    return `${likelihood} likelihood, ${impact} impact: ${count(likelihood, impact)} (${zone} zone)`;
  }));
  return (
    <div className={s.heatmap} role="img" aria-label={`${label} matrix by likelihood and impact. ${cellNames.join("; ")}`}>
      <span />
      {impacts.map((impact) => <span key={impact} className={s.heatLabel}>{capitalise(impact)} impact</span>)}
      {levels.map((likelihood) => (
        <Fragment key={likelihood}>
          <span key={`${likelihood}-label`} className={s.heatLabel}>{capitalise(likelihood)}<br />likelihood</span>
          {impacts.map((impact) => {
            const value = count(likelihood, impact);
            // G4: the cell's colour is its ZONE (likelihood + impact on the severity scale), not a computed score;
            // the zone is written in the cell, so colour never carries the meaning alone
            const zone = ZONE[RANK[likelihood] + RANK[impact]]!;
            return (
              <div
                key={`${likelihood}-${impact}`}
                className={`${s.heatCell} ${s[`zone_${zone}`]} ${value === 0 ? s.zoneEmpty : ""}`}
              >
                <strong>{value}</strong>
                <span className={s.zoneWord}>{capitalise(zone)}</span>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

/** sentence case: only the first letter is a capital ("Low impact", never "Low Impact") */
const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export function TrustSnapshotCard() {
  const q = useQuery(trustQuery());
  return (
    <Card title="Trust evidence" actions={<Link to="/admin/governance/trust">Open dashboard</Link>}>
      {q.isLoading ? <p className={v.faint} role="status">Loading evidence coverage…</p> : q.isError ? (
        <p className={v.errLine} role="alert">Trust evidence could not be loaded. Open the dashboard to retry.</p>
      ) : q.data ? (
        <div className={v.stack}>
          <div className={v.grid3}>
            <div className={v.stat}><span className={v.statValue}>{q.data.totals.risksUnmitigated}</span><span className={v.statLabel}>not yet mitigated</span></div>
            <div className={v.stat}><span className={v.statValue}>{q.data.totals.risksMitigated}</span><span className={v.statLabel}>risks mitigated</span></div>
            <div className={v.stat}><span className={v.statValue}>{formatCoverage(q.data.totals.evidenceCoveragePct)}</span><span className={v.statLabel}>evidence coverage</span></div>
          </div>
          <div className={v.row}>
            {q.data.dimensions.map((dimension) => (
              <Badge key={dimension.key} tone={dimension.measured ? "info" : "neutral"}>
                {dimension.label}: {formatCoverage(dimension.evidenceCoveragePct)}
              </Badge>
            ))}
          </div>
        </div>
      ) : <EmptyState title="No trust report yet" body="The trust report summarises evidence coverage per dimension. It appears once an active compliance pack has controls with recorded evidence; enable a pack on Compliance packs to start." />}
    </Card>
  );
}
