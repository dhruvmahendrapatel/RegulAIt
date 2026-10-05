import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Card, EmptyState, StatusDot } from "../../../ui/kit";
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
    : (alerts.data.counts.open > 0 ? "danger" : "ok");

  return (
    <>
      <PageHeader
        title="Trust & evidence"
        sub="Coverage by trust dimension, with measurement gaps left visible."
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
        <span>{d.scope.label}</span>
        <span aria-hidden>·</span>
        <span>Last {d.window.days} days</span>
        <span aria-hidden>·</span>
        <span>{d.packsEvaluated.length} active pack{d.packsEvaluated.length === 1 ? "" : "s"} evaluated</span>
        <span aria-hidden>·</span>
        <span>generated {new Date(d.generatedAt).toLocaleString()}</span>
        <span className={v.grow} />
        {props.monitor}
      </div>

      <Card>
        <div className={v.stack}>
          <div className={v.kpiStrip}>
            <div className={v.stat}>
              <span className={v.statValue}>{d.totals.risksFound.toLocaleString()}</span>
              <span className={v.statLabel}>Risks found</span>
              {d.totals.risksAccepted > 0 ? <span className={v.faint}>{d.totals.risksAccepted.toLocaleString()} accepted</span> : null}
            </div>
            <div className={v.stat}><span className={v.statValue}>{d.totals.risksMitigated.toLocaleString()}</span><span className={v.statLabel}>Mitigated</span></div>
            <div className={v.stat}><span className={v.statValue}>{d.totals.risksUnmitigated.toLocaleString()}</span><span className={v.statLabel}>Not yet mitigated</span></div>
            <div className={v.stat}><span className={v.statValue}>{formatCoverage(d.totals.evidenceCoveragePct)}</span><span className={v.statLabel}>Evidence coverage</span></div>
          </div>
          <p className={v.faint}>Evidence coverage is not a compliance or trust score; unmeasured is a gap, not zero.</p>
        </div>
      </Card>

      <div className={s.dashboardGrid}>
        <Card title="Evidence coverage by dimension">
          <Radar dimensions={d.dimensions} />
        </Card>
        <Card title="Inherent risk heatmap">
          <div className={v.stack}>
            <p className={v.faint}>Open, mitigating, and accepted risks. Closed risks are excluded.</p>
            <Heatmap cells={d.heatmap} label="Inherent risk" />
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
              <Badge tone={current.measured ? "info" : "neutral"}>{current.measured ? "measured" : "unmeasured"}</Badge>
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

      <Card title="Residual risk after controls">
        <Heatmap cells={d.residualHeatmap} label="Residual risk" />
      </Card>

    </div>
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

function Heatmap({ cells, label }: { cells: HeatCell[]; label: string }) {
  const levels: HeatCell["likelihood"][] = ["high", "medium", "low"];
  const impacts: HeatCell["impact"][] = ["low", "medium", "high"];
  const max = Math.max(1, ...cells.map((cell) => cell.count));
  const count = (likelihood: HeatCell["likelihood"], impact: HeatCell["impact"]) =>
    cells.find((cell) => cell.likelihood === likelihood && cell.impact === impact)?.count ?? 0;
  return (
    <div className={s.heatmap} role="img" aria-label={`${label} matrix by likelihood and impact`}>
      <span />
      {impacts.map((impact) => <span key={impact} className={s.heatLabel}>{impact} impact</span>)}
      {levels.map((likelihood) => (
        <Fragment key={likelihood}>
          <span key={`${likelihood}-label`} className={s.heatLabel}>{likelihood}<br />likelihood</span>
          {impacts.map((impact) => {
            const value = count(likelihood, impact);
            const heat = value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4));
            return (
              <div
                key={`${likelihood}-${impact}`}
                className={`${s.heatCell} ${heat ? s[`heat${heat}`] : ""}`}
                title={`${value} ${label.toLowerCase()} item(s): ${likelihood} likelihood, ${impact} impact`}
              >
                <strong>{value}</strong>
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

export function TrustSnapshotCard() {
  const q = useQuery(trustQuery());
  return (
    <Card title="Trust evidence" actions={<Link to="/admin/governance/trust">Open dashboard</Link>}>
      {q.isLoading ? <p className={v.faint}>Loading evidence coverage…</p> : q.isError ? (
        <p className={v.faint}>Trust evidence could not be loaded. Open the dashboard to retry.</p>
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
      ) : <EmptyState title="No trust report" body="No evidence report is available yet." />}
    </Card>
  );
}
