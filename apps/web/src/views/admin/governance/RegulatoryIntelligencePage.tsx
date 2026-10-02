import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Card, EmptyState, Field, Select } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import s from "./demoGovernance.module.css";

type UpdateStatus = "in_force" | "upcoming" | "proposed";
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
  effectiveDate: string;
  status: UpdateStatus;
  daysUntilEffective: number;
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
    withControlGaps: number;
    nextEffective: string | null;
  };
  updates: RegulatoryUpdate[];
  filter: { status: UpdateStatus | null; framework: string | null };
  notes: { source: string; evidence: string; scope: string; feed: string };
}

const STATUS_OPTIONS: Array<{ value: "" | UpdateStatus; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "in_force", label: "In force" },
  { value: "upcoming", label: "Upcoming" },
  { value: "proposed", label: "Proposed" },
];

export default function RegulatoryIntelligencePage() {
  const [status, setStatus] = useState<"" | UpdateStatus>("");
  const [framework, setFramework] = useState("");
  const query = useQuery({
    queryKey: ["regulatory", "updates", status, framework],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
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
              <div className={v.grid4}>
                <RegulatoryStat label="Feed entries" value={query.data.summary.total} />
                <RegulatoryStat label="In force" value={query.data.summary.inForce} tone="ok" />
                <RegulatoryStat label="Upcoming" value={query.data.summary.upcoming} tone="info" />
                <RegulatoryStat label="Proposed" value={query.data.summary.proposed} tone="warn" />
                <RegulatoryStat label="With control gaps" value={query.data.summary.withControlGaps} tone={query.data.summary.withControlGaps ? "danger" : "ok"} />
              </div>
              <p className={s.callout}>{query.data.summary.nextEffective
                ? `Next effective entry: ${query.data.updates.find((update) => update.key === query.data?.summary.nextEffective)?.title ?? query.data.summary.nextEffective}.`
                : "No upcoming effective date is present in this feed."}</p>

              <Card>
                <div className={s.libraryFilters}>
                  <Field label="Status">
                    <Select value={status} onChange={(event) => setStatus(event.target.value as "" | UpdateStatus)}>
                      {STATUS_OPTIONS.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Framework">
                    <Select value={framework} onChange={(event) => setFramework(event.target.value)}>
                      <option value="">All frameworks</option>
                      {frameworks.map((id) => <option key={id} value={id}>{formatWords(id)}</option>)}
                    </Select>
                  </Field>
                  <div className={v.faint}>Generated {formatDateTime(query.data.generatedAt)} · impact window {query.data.window.days} days</div>
                </div>
              </Card>

              {updates.length === 0 ? (
                <EmptyState title={status || framework ? "No entries match these filters" : "No regulatory entries are available"} body={query.data.notes.feed} />
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
  return (
    <li className={s.timelineEntry}>
      <span className={s.timelineDot} aria-hidden />
      <Card>
        <div className={v.stack}>
          <div className={v.row}>
            <time className={s.timelineDate} dateTime={update.effectiveDate}>{formatDate(update.effectiveDate)}</time>
            <Badge tone={statusTone(update.status)}>{formatWords(update.status)}</Badge>
            <Badge tone={update.daysUntilEffective >= 0 ? "info" : "neutral"}>{relativeEffectiveDate(update.daysUntilEffective)}</Badge>
            <span className={v.grow} />
            <Badge tone={update.impact.controlGaps || update.impact.frameworkGaps ? "danger" : "ok"}>
              {update.impact.controlGaps + update.impact.frameworkGaps} gap{update.impact.controlGaps + update.impact.frameworkGaps === 1 ? "" : "s"}
            </Badge>
          </div>
          <div>
            <strong>{update.title}</strong>
            <p className={v.faint}>{update.jurisdiction} · {update.instrument}</p>
          </div>
          <p className={v.dim}>{update.summary}</p>
          <div className={v.row}>
            {update.frameworks.map((item) => (
              <Badge key={item.framework} tone={item.packActive ? "primary" : "danger"} title={item.packActive ? `Active pack version ${item.activeVersion ?? "unknown"}` : "No active pack: framework gap"}>
                {formatWords(item.framework)}{item.packActive ? ` v${item.activeVersion ?? "?"}` : " · inactive pack gap"}
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
                        <span className={v.faint}>{useCase.status} · EU AI Act tier {useCase.euAiActTier ?? "not screened"}</span>
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

function RegulatoryStat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "ok" | "warn" | "danger" | "info" }) {
  return <Card><div className={v.stat}><span className={v.statValue}>{value}</span><span className={v.statLabel}><Badge tone={tone}>{label}</Badge></span></div></Card>;
}

function statusTone(status: UpdateStatus): "ok" | "info" | "warn" {
  return status === "in_force" ? "ok" : status === "upcoming" ? "info" : "warn";
}

function controlTone(status: ControlStatus): "ok" | "warn" | "danger" | "neutral" {
  if (status === "satisfied" || status === "attested") return "ok";
  if (status === "attestation_required") return "warn";
  if (status === "unsatisfied" || status === "unaddressed" || status === "not_in_active_pack") return "danger";
  return "neutral";
}

function relativeEffectiveDate(days: number): string {
  if (days === 0) return "effective today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  const elapsed = Math.abs(days);
  return `${elapsed} day${elapsed === 1 ? "" : "s"} ago`;
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
