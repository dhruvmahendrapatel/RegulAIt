/**
 * ADR-0175 A15 — the estimated energy and emissions panel, and the factor
 * table behind it.
 *
 * Always labelled an estimate, always with the source and version of every
 * factor it used. A model with no factor is "unknown", never zero, and the
 * totals say how many calls were estimated. RegulAIt ships no factors: every
 * value here was entered by an administrator (a mock model may carry one
 * labelled a demo value).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { RemoveButton, useAction } from "../adminKit";
import v from "../../views.module.css";
import { putOrgSettings } from "../../../stepup/stepUp";

interface FactorRef {
  sourceNote: string;
  version: string;
  demo: boolean;
}

export interface EnergyEstimate {
  label: string;
  windowDays: number;
  callsTotal: number;
  callsEstimated: number;
  callsUnknown: number;
  coverage: string;
  energyWh: number | null;
  emissionsG: number | null;
  grid: (FactorRef & { subject: string; region: string | null; gCo2ePerKwh: number }) | null;
  byModel: Array<{
    model: string;
    calls: number;
    callsEstimated: number;
    energyWh: number | null;
    factor: (FactorRef & { whPer1kInput: number; whPer1kOutput: number }) | null;
    status: "estimated" | "no_factor" | "no_tokens";
  }>;
  unknownModels: string[];
  usesDemoFactors: boolean;
}

export interface EnergyResponse {
  scope: { kind: "org" | "project" | "use_case"; id: string | null; name: string | null; projectId: string | null };
  estimate: EnergyEstimate | null;
  note: string | null;
}

interface EnergyFactor {
  id: string;
  kind: "model" | "grid";
  subject: string;
  whPer1kInput: number | null;
  whPer1kOutput: number | null;
  gCo2ePerKwh: number | null;
  sourceNote: string;
  version: string;
  demo: boolean;
  updatedAt: string;
}

const WINDOWS = [7, 30, 90];

export function fmtWh(wh: number | null): string {
  if (wh === null) return "unknown";
  if (wh >= 1000) return `${(wh / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kWh`;
  return `${wh.toLocaleString(undefined, { maximumFractionDigits: 3 })} Wh`;
}

export function fmtCo2(g: number | null): string {
  if (g === null) return "unknown";
  if (g >= 1000) return `${(g / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} kg CO2e`;
  return `${g.toLocaleString(undefined, { maximumFractionDigits: 3 })} g CO2e`;
}

/** the estimate for one project or one use case */
export function EnergyEstimatePanel(props: { projectId?: string; useCaseId?: string }) {
  const [windowDays, setWindowDays] = useState(30);
  const scope = props.useCaseId ? `useCaseId=${props.useCaseId}` : `projectId=${props.projectId ?? ""}`;
  const q = useQuery({
    queryKey: ["admin", "energy-estimate", scope, windowDays],
    queryFn: () => api.get<EnergyResponse>(`/v1/energy/estimate?${scope}&windowDays=${windowDays}`),
  });
  const e = q.data?.estimate ?? null;
  return (
    <section aria-label="Estimated energy and emissions" className={v.stack}>
      <div className={v.row}>
        <div className={v.sectionTitle}>Estimated energy and emissions</div>
        <Badge tone="info">estimate</Badge>
        {e?.usesDemoFactors ? <Badge tone="warn">demo factor</Badge> : null}
        <span className={v.grow} />
        <Select
          value={String(windowDays)}
          onChange={(ev) => setWindowDays(Number(ev.target.value))}
          aria-label="Energy estimate window"
          style={{ width: 130 }}
        >
          {WINDOWS.map((d) => (
            <option key={d} value={d}>
              last {d} days
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading && <span className={v.dim}>Loading estimate…</span>}
      {q.error ? <span className={v.errLine}>{q.error instanceof Error ? q.error.message : String(q.error)}</span> : null}
      {q.data && !e && <span className={v.dim}>{q.data.note ?? "Energy is unknown for this scope."}</span>}
      {e && (
        <>
          <div className={v.grid4}>
            <div className={v.stat}>
              <div className={v.statValue}>{fmtWh(e.energyWh)}</div>
              <div className={v.statLabel}>energy · {e.coverage}</div>
            </div>
            <div className={v.stat}>
              <div className={v.statValue}>{fmtCo2(e.emissionsG)}</div>
              <div className={v.statLabel}>
                {e.grid
                  ? `at ${e.grid.gCo2ePerKwh} gCO2e/kWh (${e.grid.region ?? "org default"}, ${e.grid.sourceNote}, v${e.grid.version})`
                  : "no grid intensity set"}
              </div>
            </div>
          </div>
          {e.callsUnknown > 0 && (
            <span className={v.faint}>
              {e.callsUnknown} {e.callsUnknown === 1 ? "call is" : "calls are"} unknown, not zero:
              {e.unknownModels.length ? ` no factor for ${e.unknownModels.join(", ")}` : " token counts were not recorded"}.
              Totals cover the estimated calls only.
            </span>
          )}
          {e.byModel.length > 0 && (
            <Table
              rows={e.byModel}
              rowKey={(m) => m.model}
              columns={[
                { key: "model", header: "Model", render: (m) => m.model },
                { key: "calls", header: "Calls", align: "right", render: (m) => `${m.callsEstimated} of ${m.calls}` },
                {
                  key: "energy",
                  header: "Energy",
                  align: "right",
                  render: (m) => (m.status === "estimated" ? fmtWh(m.energyWh) : <span className={v.faint}>unknown</span>),
                },
                {
                  key: "factor",
                  header: "Factor (source, version)",
                  render: (m) =>
                    m.factor ? (
                      <span className={v.dim}>
                        {m.factor.whPer1kInput} / {m.factor.whPer1kOutput} Wh per 1k in/out · {m.factor.sourceNote} · v{m.factor.version}
                        {m.factor.demo ? " · demo value" : ""}
                      </span>
                    ) : (
                      <span className={v.faint}>no factor</span>
                    ),
                },
              ]}
            />
          )}
          <span className={v.faint}>{e.label}</span>
        </>
      )}
      {q.data?.note && e ? <span className={v.faint}>{q.data.note}</span> : null}
    </section>
  );
}

/** the admin-entered factors (cost dashboard) */
export function EnergyFactorsCard() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "energy-factors"],
    queryFn: () =>
      api.get<{ factors: EnergyFactor[]; region: string | null; notes: { shipped: string; unknown: string } }>("/v1/energy/factors"),
  });
  const [kind, setKind] = useState<"model" | "grid">("model");
  const [subject, setSubject] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [source, setSource] = useState("");
  const [version, setVersion] = useState("");
  const [region, setRegion] = useState<string | null>(null);
  const regionValue = region ?? q.data?.region ?? "";
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const valid =
    subject.trim() !== "" &&
    source.trim() !== "" &&
    version.trim() !== "" &&
    (kind === "model" ? num(a) >= 0 && num(b) >= 0 : num(a) >= 0);
  const save = () =>
    void act
      .run(
        () =>
          api.put(
            "/v1/energy/factors",
            kind === "model"
              ? { kind, subject: subject.trim(), whPer1kInput: num(a), whPer1kOutput: num(b), sourceNote: source.trim(), version: version.trim() }
              : { kind, subject: subject.trim(), gCo2ePerKwh: num(a), sourceNote: source.trim(), version: version.trim() },
          ),
        "Energy factor saved",
      )
      .then((ok) => {
        if (ok) {
          setSubject("");
          setA("");
          setB("");
        }
      });
  const regions = (q.data?.factors ?? []).filter((f) => f.kind === "grid" && f.subject.toLowerCase() !== "default");
  return (
    <Card title="Energy factors">
      <div className={v.stack}>
        <span className={v.faint}>
          {q.data?.notes.shipped ?? "RegulAIt ships no energy factors."} {q.data?.notes.unknown ?? ""}
        </span>
        <Table
          rows={q.data?.factors ?? []}
          rowKey={(f) => f.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={<EmptyState title="No factors yet" body="Every estimate reads unknown until a factor is entered, with its source and version." />}
          columns={[
            { key: "kind", header: "Kind", render: (f) => (f.kind === "model" ? "Model" : "Grid intensity") },
            { key: "subject", header: "Model or region", render: (f) => f.subject },
            {
              key: "value",
              header: "Value",
              render: (f) =>
                f.kind === "model" ? `${f.whPer1kInput} / ${f.whPer1kOutput} Wh per 1k tokens in/out` : `${f.gCo2ePerKwh} gCO2e/kWh`,
            },
            {
              key: "source",
              header: "Source, version",
              render: (f) => (
                <span>
                  {f.sourceNote} · v{f.version} {f.demo ? <Badge tone="warn">demo value</Badge> : null}
                </span>
              ),
            },
            {
              key: "rm",
              header: "",
              render: (f) => <RemoveButton what={`the energy factor for ${f.subject}`} consequence="Its calls read unknown from the next estimate." onRemove={() => api.del(`/v1/energy/factors/${f.id}`)} />,
            },
          ]}
        />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as "model" | "grid")} aria-label="Factor kind">
              <option value="model">Model (Wh per 1k tokens)</option>
              <option value="grid">Grid intensity (gCO2e/kWh)</option>
            </Select>
          </Field>
          <Field label={kind === "model" ? "Model id" : "Region (or default)"}>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Factor model or region" />
          </Field>
          <Field label={kind === "model" ? "Wh per 1k input" : "gCO2e per kWh"}>
            <Input type="number" min={0} step="any" value={a} onChange={(e) => setA(e.target.value)} aria-label="Factor value" style={{ width: 120 }} />
          </Field>
          {kind === "model" && (
            <Field label="Wh per 1k output">
              <Input type="number" min={0} step="any" value={b} onChange={(e) => setB(e.target.value)} aria-label="Output factor value" style={{ width: 120 }} />
            </Field>
          )}
          <Field label="Source">
            <Input value={source} onChange={(e) => setSource(e.target.value)} aria-label="Factor source" />
          </Field>
          <Field label="Version">
            <Input value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Factor version" style={{ width: 110 }} />
          </Field>
          <Button variant="primary" disabled={!valid || act.busy} onClick={save}>
            Save factor
          </Button>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Deployment region" help="Its grid intensity overrides the org default.">
            <Select
              value={regionValue}
              onChange={(e) => setRegion(e.target.value)}
              aria-label="Deployment region for grid intensity"
            >
              <option value="">Org default</option>
              {regions.map((r) => (
                <option key={r.id} value={r.subject}>
                  {r.subject}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={act.busy || regionValue === (q.data?.region ?? "")}
            onClick={() =>
              void act
                .run(() => putOrgSettings({ energyRegion: regionValue || null }), "Deployment region saved")
                .then(() => setRegion(null))
            }
          >
            Save region
          </Button>
        </div>
      </div>
    </Card>
  );
}
