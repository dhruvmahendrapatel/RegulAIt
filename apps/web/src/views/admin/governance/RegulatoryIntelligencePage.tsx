import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { frameworkLabel } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Card, EmptyState, Field, Select } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type UpdateStatus = "in_force" | "upcoming" | "proposed" | "published" | "withdrawn";
type InstrumentKind = "law" | "guidance" | "voluntary_standard";
type ControlStatus =
  | "satisfied"
  | "unsatisfied"
  | "attestation_required"
  | "attested"
  | "unaddressed"
  | "not_in_active_pack";

interface RegulatoryUpdate {
  key: string;
  jurisdiction: string;
  instrument: string;
  title: string;
  summary: string;
  /** absent from a pre-ADR-0179 gateway; read as unknown, never as law */
  instrumentKind?: InstrumentKind;
  effectiveDate: string;
  enforcementDate?: string | null;
  withdrawnOn?: string | null;
  status: UpdateStatus;
  daysUntilEffective: number;
  daysUntilEnforcement?: number | null;
  sourceUrl: string;
  verifiedOn: string;
  frameworks: Array<{ framework: string; packActive: boolean; activeVersion: number | null }>;
  controls: Array<{ controlRef: string; title: string | null; framework: string | null; status: ControlStatus }>;
  impact: {
    scopeBasis: string;
    useCases: Array<{ id: string; name: string; status: string; euAiActTier: string | null }>;
    controlsMapped: number;
    controlsEvidenced: number;
    controlGaps: number;
    frameworkGaps: number;
  };
}

interface RegulatoryResponse {
  generatedAt: string;
  window: { days: number };
  summary: {
    total: number;
    inForce: number;
    upcoming: number;
    proposed: number;
    published?: number;
    withdrawn?: number;
    withControlGaps: number;
    nextEffective: string | null;
  };
  updates: RegulatoryUpdate[];
  filter: { status: UpdateStatus | null; kind?: InstrumentKind | null; framework: string | null };
  notes: { source: string; evidence: string; scope: string; feed: string; status?: string; applicability?: string };
}

const STATUS_OPTIONS: Array<{ value: "" | UpdateStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "in_force", label: "In force" },
  { value: "upcoming", label: "Upcoming" },
  { value: "proposed", label: "Proposed" },
  { value: "published", label: "Published (voluntary standard)" },
  { value: "withdrawn", label: "Withdrawn" },
];

const KIND_LABELS: Record<InstrumentKind, string> = {
  law: "Law",
  guidance: "Guidance",
  voluntary_standard: "Voluntary standard",
};
const KIND_OPTIONS: Array<{ value: "" | InstrumentKind; label: string }> = [
  { value: "", label: "All instrument kinds" },
  { value: "law", label: KIND_LABELS.law },
  { value: "guidance", label: KIND_LABELS.guidance },
  { value: "voluntary_standard", label: KIND_LABELS.voluntary_standard },
];
const STATUS_LABELS: Record<UpdateStatus, string> = {
  in_force: "In force",
  upcoming: "Upcoming",
  proposed: "Proposed",
  published: "Published",
  withdrawn: "Withdrawn",
};

export default function RegulatoryIntelligencePage() {
  const [status, setStatus] = useState<"" | UpdateStatus>("");
  const [kind, setKind] = useState<"" | InstrumentKind>("");
  const [framework, setFramework] = useState("");
  const query = useQuery({
    queryKey: ["regulatory", "updates", status, kind, framework],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (kind) params.set("kind", kind);
      if (framework) params.set("framework", framework);
      const suffix = params.size ? `?${params.toString()}` : "";
      return api.get<RegulatoryResponse>(`/v1/regulatory/updates${suffix}`);
    },
  });

  const frameworks = useMemo(() => {
    const ids = new Set<string>();
    if (framework) ids.add(framework);
    for (const update of query.data?.updates ?? []) for (const item of update.frameworks) ids.add(item.framework);
    return [...ids].sort();
  }, [framework, query.data?.updates]);
  const updates = useMemo(
    () => [...(query.data?.updates ?? [])].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    [query.data?.updates],
  );

  return (
    <>
      <PageHeader
        title="Regulatory & policy intelligence"
        sub="A curated, source-linked timeline of obligations and proposals, joined to active packs, controls, evidence, and in-scope AI use cases."
        info={<p>This feed is decision support, not legal advice. Status and dates come from the linked primary sources; control and use-case impact is computed against this deployment.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()}>
          {query.data ? (
            <>
              {/* one strip of plain figures; only a non-zero gap count takes a colour */}
              <Card>
                <div className={v.stack}>
                  <div className={v.kpiStrip}>
                    <RegulatoryStat label="Feed entries" value={query.data.summary.total} />
                    <RegulatoryStat label="In force" value={query.data.summary.inForce} />
                    <RegulatoryStat label="Upcoming" value={query.data.summary.upcoming} />
                    {/* six tiles fit one row; proposed shows only when the feed has any (the status filter still offers it) */}
                    {query.data.summary.proposed > 0 ? <RegulatoryStat label="Proposed" value={query.data.summary.proposed} /> : null}
                    <RegulatoryStat label="Voluntary standards" value={query.data.summary.published ?? 0} />
                    <RegulatoryStat label="Withdrawn" value={query.data.summary.withdrawn ?? 0} />
                    <RegulatoryStat label="With control gaps" value={query.data.summary.withControlGaps} exception={query.data.summary.withControlGaps > 0} />
                  </div>
                  <p className={v.dim}>{query.data.summary.nextEffective
                    ? `Next effective entry: ${query.data.updates.find((update) => update.key === query.data?.summary.nextEffective)?.title ?? query.data.summary.nextEffective}.`
                    : "No upcoming effective date is present in this feed."}</p>
                </div>
              </Card>

              {/* filters sit on the canvas, directly above the list they filter */}
              <div className={s.libraryFilters}>
                  <Field label="Status">
                    <Select value={status} onChange={(event) => setStatus(event.target.value as "" | UpdateStatus)}>
                      {STATUS_OPTIONS.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Instrument kind">
                    <Select value={kind} onChange={(event) => setKind(event.target.value as "" | InstrumentKind)}>
                      {KIND_OPTIONS.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Framework">
                    <Select value={framework} onChange={(event) => setFramework(event.target.value)}>
                      <option value="">All frameworks</option>
                      {frameworks.map((id) => <option key={id} value={id}>{frameworkLabel(id)}</option>)}
                    </Select>
                  </Field>
                <div className={v.faint}>Generated {formatDateTime(query.data.generatedAt)} · impact window {query.data.window.days} days</div>
              </div>

              {updates.length === 0 ? (
                <EmptyState title={status || kind || framework ? "No entries match these filters" : "No regulatory entries are available"} body={query.data.notes.feed} />
              ) : (
                <ol className={s.timeline} aria-label="Regulatory effective-date timeline">
                  {updates.map((update) => <RegulatoryTimelineEntry key={update.key} update={update} />)}
                </ol>
              )}

              <Card title="How to read this feed">
                <div className={v.stackTight}>
                  <p className={v.dim}>{query.data.notes.source}</p>
                  <p className={v.dim}>{query.data.notes.evidence}</p>
                  <p className={v.dim}>{query.data.notes.scope}</p>
                  {query.data.notes.status ? <p className={v.dim}>{query.data.notes.status}</p> : null}
                  <p className={v.dim}>{query.data.notes.applicability ?? "Applicability to this organisation is pending legal review."}</p>
                  <p className={v.faint}>{query.data.notes.feed}</p>
                </div>
              </Card>
            </>
          ) : null}
        </QueryGate>
      </div>
    </>
  );
}

function RegulatoryTimelineEntry({ update }: { update: RegulatoryUpdate }) {
  const withdrawn = update.status === "withdrawn";
  const voluntary = update.instrumentKind === "voluntary_standard";
  return (
    <li className={s.timelineEntry}>
      <span className={s.timelineDot} aria-hidden />
      <Card>
        <div className={v.stack}>
          <div className={v.row}>
            <time className={s.timelineDate} dateTime={update.effectiveDate}>{formatDate(update.effectiveDate)}</time>
            {/* status is a lifecycle state, not a rating: neutral; withdrawn is the one a reader must not miss */}
            <Badge tone={withdrawn ? "warn" : "neutral"}>{STATUS_LABELS[update.status] ?? formatWords(update.status)}</Badge>
            <Badge tone="neutral">{update.instrumentKind ? KIND_LABELS[update.instrumentKind] : "Instrument kind not stated"}</Badge>
            <span className={v.faint}>{dateCaption(update)}</span>
            <span className={v.grow} />
            {withdrawn ? (
              <span className={v.faint}>Not counted: withdrawn</span>
            ) : update.impact.controlGaps || update.impact.frameworkGaps ? (
              <Badge tone="danger">
                {update.impact.controlGaps + update.impact.frameworkGaps} gap{update.impact.controlGaps + update.impact.frameworkGaps === 1 ? "" : "s"}
              </Badge>
            ) : (
              <span className={v.faint}>0 gaps</span>
            )}
          </div>
          <div>
            <strong>{update.title}</strong>
            <p className={v.faint}>{update.jurisdiction} · {update.instrument}</p>
          </div>
          {withdrawn && update.withdrawnOn ? (
            <p className={v.dim}><strong>Withdrawn on {formatDate(update.withdrawnOn)}.</strong> It no longer applies as issued; it is listed so earlier reliance on it can be reviewed.</p>
          ) : null}
          {voluntary ? <p className={v.dim}>Voluntary standard: published, not law in force.</p> : null}
          {update.enforcementDate ? (
            <p className={v.dim}>Effective {formatDate(update.effectiveDate)} · enforced from <time dateTime={update.enforcementDate}>{formatDate(update.enforcementDate)}</time></p>
          ) : null}
          <p className={v.dim}>{update.summary}</p>
          <div className={v.row}>
            {update.frameworks.map((item) => (
              <Badge key={item.framework} tone={item.packActive ? "neutral" : "danger"} title={item.packActive ? `Active pack version ${item.activeVersion ?? "unknown"}` : "No active pack: framework gap"}>
                {frameworkLabel(item.framework)}{item.packActive ? ` v${item.activeVersion ?? "?"}` : " · pack not active (gap)"}
              </Badge>
            ))}
          </div>
          <details>
            <summary>Mapped controls and impacted use cases</summary>
            <div className={v.stack}>
              <p className={v.faint}>Scope basis: {formatWords(update.impact.scopeBasis)} · {update.impact.controlsEvidenced}/{update.impact.controlsMapped} mapped controls evidenced</p>
              {update.controls.length ? (
                <div className={v.stackTight}>
                  {update.controls.map((control) => (
                    <div className={s.controlRow} key={`${control.controlRef}:${control.status}`}>
                      <code>{control.controlRef}</code>
                      <span className={v.dim}>{control.title ?? "Not present in the active pack"}</span>
                      <Badge tone={controlTone(control.status)}>{formatWords(control.status)}</Badge>
                    </div>
                  ))}
                </div>
              ) : <p className={v.faint}>No controls are mapped to this entry.</p>}
              <div>
                <strong>In-scope use cases</strong>
                {update.impact.useCases.length ? (
                  <ul className={s.useCaseLinks}>
                    {update.impact.useCases.map((useCase) => (
                      <li key={useCase.id}>
                        <Link to={`/admin/governance/use-cases/${useCase.id}`}>{useCase.name}</Link>
                        <span className={v.faint}>{formatWords(useCase.status)} · EU AI Act tier {useCase.euAiActTier ?? "not screened"}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className={v.faint}>No current use case matches the declared scope.</p>}
              </div>
            </div>
          </details>
          <div className={v.row}>
            <a href={update.sourceUrl} target="_blank" rel="noreferrer">Primary source</a>
            <span className={v.faint}>Verified on {formatDate(update.verifiedOn)}</span>
          </div>
        </div>
      </Card>
    </li>
  );
}

function RegulatoryStat({ label, value, exception = false }: { label: string; value: number; exception?: boolean }) {
  return (
    <div className={v.stat}>
      <span className={`${v.statValue} ${exception ? s.gapCount : ""}`}>{value}</span>
      <span className={v.statLabel}>{label}</span>
    </div>
  );
}

function controlTone(status: ControlStatus): "ok" | "warn" | "danger" | "neutral" {
  if (status === "satisfied" || status === "attested") return "neutral";
  if (status === "attestation_required") return "warn";
  if (status === "unsatisfied" || status === "unaddressed" || status === "not_in_active_pack") return "danger";
  return "neutral";
}

/** the date caption names what the date is: issued, published, or effective */
function dateCaption(update: RegulatoryUpdate): string {
  const when = relativeEffectiveDate(update.daysUntilEffective);
  if (update.status === "withdrawn") return `issued ${when}`;
  if (update.instrumentKind === "voluntary_standard") return `published ${when}`;
  if (update.instrumentKind === "guidance") return `issued ${when}`;
  return `effective ${when}`;
}

function relativeEffectiveDate(days: number): string {
  if (days === 0) return "today";
  const n = Math.abs(days);
  // days for the near term, then months, then whole years — "1590 days ago" is not a date a reader can place
  const span =
    n < 60 ? `${n} day${n === 1 ? "" : "s"}`
    : n < 730 ? `${Math.round(n / 30.44)} months`
    : `${Math.floor(n / 365.25)} years`;
  return days > 0 ? `in ${span}` : `${span} ago`;
}

function formatWords(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function formatDate(value: string): string {
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}
