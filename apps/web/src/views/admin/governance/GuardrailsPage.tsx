import { DetectionContentPanel } from "./DetectionContentPanel";
/**
 * Guardrails (ADR-0042).
 *
 * The screen where the content-safety layers are tuned. Three things it exists
 * to keep honest, rendered rather than merely documented:
 *
 *  - **Every detector states what it CANNOT do, next to its switch.** The
 *    `limits` string comes straight from the detector's own definition, so an
 *    admin reads the false-positive/false-negative reality at the moment they
 *    decide to move a layer to `block` — not in an ADR they will never open.
 *  - **The compliance cascade is a ceiling, and the page shows it.** The
 *    effective-policy panel resolves a hypothetical call and prints the
 *    provenance of every mode: org default, override, compliance floor, and
 *    which one won. A local setting that a framework overrode is visible as
 *    overridden rather than silently ignored.
 *  - **Violations are the audit log, not a second ledger.** The list below is a
 *    query over the same table every other governed decision lands in, and it
 *    carries counts only — never the matched content.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useAgents, useConnectors, useProjects } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

type Mode = "off" | "log" | "warn" | "block";
const MODES: Mode[] = ["off", "log", "warn", "block"];

interface Detector {
  id: string;
  tier: string;
  phases: string[];
  summary: string;
  limits: string;
  ruleCount: number;
  configurable: boolean;
}
interface DetectorInfo {
  detectors: Detector[];
  shippedDefaults: Record<string, Mode>;
  note: string;
}
interface ConfigRow {
  id: string;
  scope: string;
  scopeId: string | null;
  modes: Record<string, Mode>;
  targetName: string | null;
  customTerms: Record<string, string[]>;
  updatedAt: string;
}
interface ConfigView {
  org: (ConfigRow & { customTerms: Record<string, string[]> }) | null;
  orgModes: Record<string, Mode>;
  shippedDefaults: Record<string, Mode>;
  overrides: ConfigRow[];
}
interface Provenance {
  detector: string;
  orgDefault: Mode;
  override: Mode | null;
  complianceFloor: Mode | null;
  effective: Mode;
}
interface EffectiveView {
  modes: Record<string, Mode>;
  provenance: Provenance[];
  active: boolean;
  blocksInput: boolean;
  blocksOutput: boolean;
  streamingNote: string;
}
interface ViolationRow {
  id: string;
  at: string;
  userId: string;
  objectType: string;
  ruleId: string;
  effect: string;
  reason: string;
  detail: {
    guardrail?: {
      phase: string;
      outcome: string;
      findings: Array<{ detector: string; category: string; count: number; mode: Mode }>;
    };
  };
}

const modeTone = (m: Mode) =>
  m === "block" ? "danger" : m === "warn" ? "warn" : m === "log" ? "info" : "neutral";

export default function GuardrailsPage() {
  const agents = useAgents();
  const connectors = useConnectors();
  const projects = useProjects();
  const act = useAction();

  const info = useQuery({
    queryKey: ["admin", "guardrail-detectors"],
    queryFn: () => api.get<DetectorInfo>("/v1/guardrails/detectors"),
  });
  const config = useQuery({
    queryKey: ["admin", "guardrail-config"],
    queryFn: () => api.get<ConfigView>("/v1/guardrails/config"),
  });

  const [orgDraft, setOrgDraft] = useState<Record<string, Mode> | null>(null);
  const [termsDraft, setTermsDraft] = useState<string | null>(null);
  const [ovScope, setOvScope] = useState<"agent" | "connector">("agent");
  const [ovTarget, setOvTarget] = useState("");
  const [ovModes, setOvModes] = useState<Record<string, Mode>>({});
  const [effProject, setEffProject] = useState("");
  const [effAgent, setEffAgent] = useState("");
  const [sample, setSample] = useState("");
  const [sampleOut, setSampleOut] = useState<{
    clean: boolean;
    findings: Array<{ detector: string; category: string; count: number }>;
  } | null>(null);
  const [outcome, setOutcome] = useState("");

  const effective = useQuery({
    queryKey: ["admin", "guardrail-effective", effProject, effAgent],
    queryFn: () => {
      const q = new URLSearchParams();
      if (effProject) q.set("projectId", effProject);
      if (effAgent) q.set("agentId", effAgent);
      return api.get<EffectiveView>(`/v1/guardrails/effective?${q.toString()}`);
    },
  });
  const violations = useQuery({
    queryKey: ["admin", "guardrail-violations", outcome],
    queryFn: () =>
      api.get<{ violations: ViolationRow[]; totals: Record<string, number>; note: string }>(
        `/v1/guardrails/violations?limit=100${outcome ? `&outcome=${outcome}` : ""}`,
      ),
  });

  const configurable = (info.data?.detectors ?? []).filter((d) => d.configurable);
  const orgModes = orgDraft ?? config.data?.orgModes ?? {};

  return (
    <>
      <PageHeader
        title="Guardrails"
        sub="Content-safety detectors, in and out. Every detector shipped today is a deterministic rule set, not a model."
        info={<p>Content-safety detectors evaluated at the same interception point, and with the same block / warn / log verbs, as PII enforcement — on the way in AND on the way out. Every detector shipped today is a deterministic local rule set, not a model: it catches literal phrasings, misses novel ones, and will occasionally fire on benign text. That is why the shipped posture is 'log', and why this page shows each detector's limits next to its switch.</p>}
      />
      <div className={v.stack}>
        <DetectionContentPanel />
        <QueryGate
          loading={info.isLoading || config.isLoading}
          error={info.error ?? config.error}
          onRetry={() => {
            void info.refetch();
            void config.refetch();
          }}
        >
          {/* ---------------- org defaults ---------------- */}
          <Card title="Deployment defaults">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {config.data?.org
                ? "These apply to every governed call unless an override or a compliance profile says otherwise."
                : "No deployment default has been set, so the shipped posture applies: every added layer observes in 'log' mode and refuses nothing. Turning a layer up is a deliberate act."}
            </div>
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  let customTerms: Record<string, string[]> | undefined;
                  if (termsDraft !== null) {
                    customTerms = JSON.parse(termsDraft) as Record<string, string[]>;
                  }
                  await withStepUp((h) => stepUpApi.put("/v1/guardrails/config", {
                    modes: orgModes,
                    ...(customTerms ? { customTerms } : {}),
                  }, h));
                  setOrgDraft(null);
                  setTermsDraft(null);
                  await config.refetch();
                  await effective.refetch();
                }, "Deployment guardrail defaults saved");
              }}
            >
              {configurable.map((d) => (
                <div key={d.id} className={a.formRow} style={{ alignItems: "flex-start" }}>
                  <Field label={d.id.replace(/_/g, " ")}>
                    <Select
                      value={orgModes[d.id] ?? "log"}
                      onChange={(e) =>
                        setOrgDraft({ ...orgModes, [d.id]: e.target.value as Mode })
                      }
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className={v.stack} style={{ flex: 1, gap: "var(--s1)" }}>
                    <div>
                      {d.summary}{" "}
                      <Badge tone="neutral" title="detection tier">
                        {d.tier}
                      </Badge>{" "}
                      <Badge tone="neutral">{d.phases.join(" + ")}</Badge>{" "}
                      <Badge tone="neutral">{d.ruleCount} rules</Badge>
                    </div>
                    <div className={v.faint}>
                      <strong>Limits:</strong> {d.limits}
                    </div>
                  </div>
                </div>
              ))}
              <Field label="Custom terms (JSON, per detector — your own vocabulary, added to the rules)" grow>
                <Textarea
                  rows={4}
                  spellCheck={false}
                  value={
                    termsDraft ??
                    JSON.stringify(config.data?.org?.customTerms ?? {}, null, 2)
                  }
                  onChange={(e) => setTermsDraft(e.target.value)}
                  style={{ fontFamily: "var(--font-mono, monospace)" }}
                />
              </Field>
              <div className={v.row}>
                <Button type="submit" variant="primary" disabled={act.busy}>
                  Save defaults
                </Button>
                <span className={v.faint}>
                  A compliance profile can still RAISE any of these for a classified project.
                  Nothing set here can lower a framework's floor.
                </span>
              </div>
              {act.error && (
                <div className={v.errLine} role="alert">
                  {act.error}
                </div>
              )}
            </form>
          </Card>

          {/* ---------------- per-object overrides ---------------- */}
          <Card title="Per-agent / per-connector overrides">
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await withStepUp((h) => stepUpApi.put(`/v1/guardrails/config/${ovScope}/${ovTarget}`, { modes: ovModes }, h));
                  setOvTarget("");
                  setOvModes({});
                  await config.refetch();
                }, "Override saved");
              }}
            >
              <div className={a.formRow}>
                <Field label="Scope">
                  <Select
                    value={ovScope}
                    onChange={(e) => {
                      setOvScope(e.target.value as "agent" | "connector");
                      setOvTarget("");
                    }}
                  >
                    <option value="agent">Agent</option>
                    <option value="connector">Connector</option>
                  </Select>
                </Field>
                <Field label="Target" grow>
                  <Select required value={ovTarget} onChange={(e) => setOvTarget(e.target.value)}>
                    {optionEls(
                      ovScope === "agent"
                        ? (agents.data?.agents ?? []).map((x) => ({ v: x.id, l: x.name }))
                        : (connectors.data?.connectors ?? []).map((x) => ({ v: x.id, l: x.name })),
                      "— pick one —",
                    )}
                  </Select>
                </Field>
                {configurable.map((d) => (
                  <Field key={d.id} label={d.id.replace(/_/g, " ")}>
                    <Select
                      value={ovModes[d.id] ?? config.data?.orgModes?.[d.id] ?? "log"}
                      onChange={(e) => setOvModes({ ...ovModes, [d.id]: e.target.value as Mode })}
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              <div className={v.row}>
                <Button type="submit" variant="primary" disabled={act.busy || !ovTarget}>
                  Save override
                </Button>
              </div>
            </form>
            {(config.data?.overrides ?? []).length === 0 ? (
              <EmptyState
                title="No overrides"
                body="Every agent and connector uses the deployment default."
              />
            ) : (
              <Table
                rows={config.data?.overrides ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "scope", header: "Scope", render: (r) => r.scope },
                  { key: "target", header: "Target", render: (r) => r.targetName ?? r.scopeId },
                  ...configurable.map((d) => ({
                    key: d.id,
                    header: d.id.replace(/_/g, " "),
                    render: (r: ConfigRow) => (
                      <Badge tone={modeTone(r.modes[d.id] ?? "off")}>{r.modes[d.id] ?? "off"}</Badge>
                    ),
                  })),
                  {
                    key: "actions",
                    header: "",
                    render: (r) => (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={act.busy}
                        onClick={() =>
                          void act.run(async () => {
                            // removing an override stricter than the org default lowers it: settings_relax (ADR-0186)
                            await withStepUp((h) => api.delWithHeaders(`/v1/guardrails/config/${r.scope}/${r.scopeId}`, h));
                            await config.refetch();
                          }, "Override removed — the deployment default applies again")
                        }
                      >
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          {/* ---------------- effective policy ---------------- */}
          <Card title="What actually applies (and why)">
            <div className={a.formRow}>
              <Field label="Project (supplies the compliance floor)">
                <Select value={effProject} onChange={(e) => setEffProject(e.target.value)}>
                  {optionEls(
                    (projects.data?.projects ?? []).map((p) => ({ v: p.id, l: p.name })),
                    "— unattributed —",
                  )}
                </Select>
              </Field>
              <Field label="Agent (supplies any override)">
                <Select value={effAgent} onChange={(e) => setEffAgent(e.target.value)}>
                  {optionEls(
                    (agents.data?.agents ?? []).map((x) => ({ v: x.id, l: x.name })),
                    "— none —",
                  )}
                </Select>
              </Field>
            </div>
            <Table
              rows={effective.data?.provenance ?? []}
              rowKey={(r) => r.detector}
              columns={[
                { key: "d", header: "Detector", render: (r) => r.detector.replace(/_/g, " ") },
                { key: "o", header: "Deployment default", render: (r) => r.orgDefault },
                {
                  key: "v",
                  header: "Override",
                  render: (r) => (r.override ? r.override : <span className={v.faint}>—</span>),
                },
                {
                  key: "c",
                  header: "Compliance floor",
                  render: (r) =>
                    r.complianceFloor ? (
                      <Badge tone="warn">{r.complianceFloor}</Badge>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                },
                {
                  key: "e",
                  header: "In force",
                  render: (r) => <Badge tone={modeTone(r.effective)}>{r.effective}</Badge>,
                },
              ]}
            />
            {effective.data && (
              <div className={v.faint} style={{ marginTop: "var(--s2)" }}>
                {effective.data.streamingNote}
              </div>
            )}
          </Card>

          {/* ---------------- tuning sandbox ---------------- */}
          <Card title="Try a sample">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              Runs every detector over the text and reports what WOULD fire. Nothing is enforced,
              dispatched or recorded as a violation — this is how you measure a layer's
              false-positive rate on your own text before moving it off &lsquo;log&rsquo;.
            </div>
            <div className={v.stack}>
              <Textarea
                rows={4}
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                placeholder="Paste a representative prompt or completion…"
              />
              <div className={v.row}>
                <Button
                  disabled={act.busy || !sample.trim()}
                  onClick={() =>
                    void act.run(async () => {
                      setSampleOut(
                        await api.post<{
                          clean: boolean;
                          findings: Array<{ detector: string; category: string; count: number }>;
                        }>("/v1/guardrails/sample", { text: sample }),
                      );
                    }, null)
                  }
                >
                  Detect
                </Button>
                {sampleOut &&
                  (sampleOut.clean ? (
                    <Badge tone="ok">No detector fired</Badge>
                  ) : (
                    sampleOut.findings.map((f, i) => (
                      <Badge key={i} tone="warn">
                        {f.detector}:{f.category} ×{f.count}
                      </Badge>
                    ))
                  ))}
              </div>
            </div>
          </Card>

          {/* ---------------- violations ---------------- */}
          <Card title="Recent guardrail decisions">
            <div className={v.row} style={{ marginBottom: "var(--s2)" }}>
              <Field label="Outcome">
                <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  <option value="">All</option>
                  <option value="blocked">Blocked</option>
                  <option value="warned">Warned</option>
                  <option value="logged">Logged (observe-only)</option>
                </Select>
              </Field>
              <span className={v.faint}>
                blocked {violations.data?.totals?.blocked ?? 0} · warned{" "}
                {violations.data?.totals?.warned ?? 0} · logged{" "}
                {violations.data?.totals?.logged ?? 0}. Sourced from the single audit log; counts
                only, never the matched content.
              </span>
            </div>
            {(violations.data?.violations ?? []).length === 0 ? (
              <EmptyState
                title="No guardrail events yet"
                body="Nothing has tripped a detector on this deployment."
              />
            ) : (
              <Table
                rows={violations.data?.violations ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "at", header: "When", render: (r) => ago(r.at) },
                  {
                    key: "outcome",
                    header: "Outcome",
                    render: (r) => (
                      <Badge tone={r.effect === "deny" ? "danger" : "warn"}>
                        {r.detail.guardrail?.outcome ?? r.ruleId}
                      </Badge>
                    ),
                  },
                  { key: "phase", header: "Phase", render: (r) => r.detail.guardrail?.phase ?? "—" },
                  { key: "obj", header: "Surface", render: (r) => r.objectType },
                  {
                    key: "f",
                    header: "Findings (counts only)",
                    render: (r) => (
                      <span className={v.row}>
                        {(r.detail.guardrail?.findings ?? []).map((f, i) => (
                          <Badge key={i} tone={modeTone(f.mode)}>
                            {f.detector}:{f.category} ×{f.count} ({f.mode})
                          </Badge>
                        ))}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
