import { DetectionContentPanel } from "./DetectionContentPanel";
import { TrainedDetectorsPanel } from "./TrainedDetectorsPanel";
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
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Table,
  Tabs,
  Textarea,
  tabIds,
} from "../../../ui/kit";
import { tabLabel, type Unresolved } from "../settings/postureTabs";
import { QueryGate, optionEls, useAction, useAgents, useConnectors, useProjects } from "../adminKit";
import { DataList } from "../../../ui/DataList";
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

/** I-2 (#453, pattern 5): one matrix row per configurable detector, joined to its resolved provenance */
type Source = "floor" | "override" | "default" | "shipped";
interface MatrixRow {
  detector: Detector;
  prov: Provenance | undefined;
  source: Source;
}
const SOURCE_WORDS: Record<Source, string> = {
  floor: "Compliance floor of the project",
  override: "Override for the agent",
  default: "Deployment default",
  shipped: "Shipped default (no deployment default set)",
};
const PHASE_WORDS: Record<string, string> = { input: "a prompt on the way in", output: "a completion on the way out" };
/** what moving this detector to block starts refusing */
const refusesAtBlock = (d: Detector) =>
  `${d.phases.map((p) => PHASE_WORDS[p] ?? p).join(", or ")} that it matches. Below block, it warns or records only.`
    .replace(/^./, (c) => c.toUpperCase());

/** the vendored-content card's own unresolved facts: not reported, not installed, disabled or contributing nothing */
function detectionContentUnresolved(q: { data?: { packs?: unknown; outboundAudienceEnforced?: boolean }; isError: boolean }): Unresolved | null {
  if (q.isError) return { unknown: 1, warnings: 0 };
  if (!q.data) return null;
  if (!Array.isArray(q.data.packs)) return { unknown: 1, warnings: 0 };
  const packs = q.data.packs as Array<{ enabled: boolean; rules: number }>;
  const u: Unresolved = { unknown: q.data.outboundAudienceEnforced === undefined ? 1 : 0, warnings: q.data.outboundAudienceEnforced === false ? 1 : 0 };
  for (const pack of packs) if (!pack.enabled || pack.rules === 0) u.warnings += 1;
  return u;
}

function GuardrailsPanel(props: { id: string; tab: string; children: ReactNode }) {
  const ids = tabIds("guardrails", props.id);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={props.tab !== props.id}>
      {props.children}
    </div>
  );
}

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
  // ADR-0226: the decisions page on the server; the totals come with each page, across every decision
  const [totals, setTotals] = useState<Record<string, number> | null>(null);
  const violationFilters = useMemo(() => ({ outcome: outcome || undefined }), [outcome]);

  const configurable = (info.data?.detectors ?? []).filter((d) => d.configurable);
  const orgModes = orgDraft ?? config.data?.orgModes ?? {};

  // I-2: the tabs, and the facts the posture line and the tab labels read (the same cache entries the cards render from)
  const [tab, setTab] = useState("defaults");
  const gateOpen = !info.isLoading && !config.isLoading && !(info.error ?? config.error);
  const overrideCount = (config.data?.overrides ?? []).length;
  const blockingByDefault = configurable.filter((d) => config.data?.orgModes?.[d.id] === "block").length;
  const trained = useQuery({
    queryKey: ["admin", "guardrail-trained-detectors"],
    queryFn: () => api.get<{ detectors: unknown[] }>("/v1/guardrails/trained-detectors"),
  });
  const trainedUnresolved: Unresolved | null = trained.isError ? { unknown: 1, warnings: 0 } : trained.data ? { unknown: 0, warnings: 0 } : null;
  const content = useQuery({
    queryKey: ["admin", "detection-content"],
    retry: false,
    queryFn: () => api.get<{ packs: unknown[]; outboundAudienceEnforced?: boolean }>("/v1/detection-content"),
  });
  const contentUnresolved = detectionContentUnresolved(content);
  const matrixRows: MatrixRow[] | undefined = effective.data
    ? configurable.map((d) => {
        const prov = effective.data?.provenance?.find((p) => p.detector === d.id);
        const source: Source = !prov
          ? "default"
          : prov.complianceFloor && prov.effective === prov.complianceFloor && prov.effective !== (prov.override ?? prov.orgDefault)
            ? "floor"
            : prov.override && prov.effective === prov.override
              ? "override"
              : config.data?.org
                ? "default"
                : "shipped";
        return { detector: d, prov, source };
      })
    : undefined;

  return (
    <>
      <PageHeader
        title="Guardrails"
        info={<p>Content-safety detectors evaluated at the same interception point, and with the same block / warn / log verbs, as PII enforcement — on the way in AND on the way out. Every detector shipped today is a deterministic local rule set, not a model: it catches literal phrasings, misses novel ones, and will occasionally fire on benign text. That is why the shipped posture is 'log', and why this page shows each detector's limits next to its switch.</p>}
      />
      <div className={v.stack}>
        {/* while the settings have not loaded, the vendored content still shows, as it did above them before I-2 */}
        {!gateOpen && <DetectionContentPanel />}
        <QueryGate
          loading={info.isLoading || config.isLoading}
          error={info.error ?? config.error}
          onRetry={() => {
            void info.refetch();
            void config.refetch();
          }}
        >
          {/* I-2 (#453, pattern 5): the verdict line stays above the tabs, so no tab hides that nothing is refused */}
          <div className={v.row} role="group" aria-label="Guardrail posture">
            {config.data?.org ? (
              <Badge tone="ok">Deployment defaults set</Badge>
            ) : (
              <Badge
                tone="warn"
                info="No deployment default has been set, so the shipped posture applies: every added layer observes in 'log' mode and refuses nothing. Turning a layer up is a deliberate act."
              >
                Shipped posture · nothing refused
              </Badge>
            )}
            <Badge tone={blockingByDefault > 0 ? "danger" : "neutral"}>
              {`Blocking by default: ${blockingByDefault} of ${configurable.length}`}
            </Badge>
            <Badge tone="neutral">{`Overrides: ${overrideCount}`}</Badge>
          </div>

          {/* ---------------- the matrix: what actually applies, and why ---------------- */}
          <Card
            title="What actually applies (and why)"
            info={
              <p>
                One row per detector, resolved for a hypothetical call: the deployment default, then any override for
                the agent, then the compliance floor of the project. The floor is a ceiling on how lax a call can be:
                nothing set on this page can lower it.
              </p>
            }
          >
            <div className={v.stack}>
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
              {effective.error && !effective.data ? (
                <ErrorState
                  title="Couldn't resolve what applies"
                  message={effective.error instanceof Error ? effective.error.message : String(effective.error)}
                  onRetry={() => void effective.refetch()}
                />
              ) : (
                <Table<MatrixRow>
                  rows={matrixRows}
                  loading={effective.isLoading}
                  rowKey={(r) => r.detector.id}
                  empty="No configurable detector is reported by this gateway."
                  columns={[
                    {
                      key: "control",
                      header: "Control",
                      render: (r) => (
                        <span className={v.stackTight}>
                          <strong>{r.detector.id.replace(/_/g, " ")}</strong>
                          <span className={v.faint}>{`${r.detector.tier} · ${r.detector.phases.join(" + ")}`}</span>
                          <span>
                            <Badge tone="warn" infoLabel={`the limits of ${r.detector.id.replace(/_/g, " ")}`} info={r.detector.limits}>
                              Limited coverage
                            </Badge>
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: "state",
                      header: "State",
                      render: (r) =>
                        r.prov ? <Badge tone={modeTone(r.prov.effective)}>{r.prov.effective}</Badge> : <Badge tone="neutral">not reported</Badge>,
                    },
                    {
                      key: "source",
                      header: "Source",
                      render: (r) =>
                        r.prov ? (
                          <span className={v.stackTight}>
                            <span>{SOURCE_WORDS[r.source]}</span>
                            <span className={v.faint}>
                              {`default ${r.prov.orgDefault} · override ${r.prov.override ?? "—"} · floor ${r.prov.complianceFloor ?? "—"}`}
                            </span>
                          </span>
                        ) : (
                          <span className={v.faint}>—</span>
                        ),
                    },
                    {
                      key: "fix",
                      header: "Fix",
                      render: (r) =>
                        !r.prov ? (
                          <span className={v.faint}>The gateway did not resolve this detector.</span>
                        ) : r.source === "floor" ? (
                          <span>Raised by the project&apos;s compliance profile. Nothing on this page can lower it.</span>
                        ) : r.source === "override" ? (
                          <Button size="sm" variant="ghost" onClick={() => setTab("overrides")}>
                            Change the override
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setTab("defaults")}>
                            Change the default
                          </Button>
                        ),
                    },
                    {
                      key: "refuses",
                      header: "At block, it refuses",
                      render: (r) => <span className={v.faint}>{refusesAtBlock(r.detector)}</span>,
                    },
                  ]}
                />
              )}
              {effective.data && <div className={v.faint}>{effective.data.streamingNote}</div>}
            </div>
          </Card>

          <Tabs
            label="Guardrail settings"
            idPrefix="guardrails"
            tabs={[
              { id: "defaults", label: tabLabel("Deployment defaults", { unknown: 0, warnings: config.data?.org ? 0 : 1 }) },
              { id: "overrides", label: `Overrides (${overrideCount})` },
              { id: "trained", label: tabLabel("Trained detectors", trainedUnresolved) },
              { id: "content", label: tabLabel("Detection content", contentUnresolved) },
              { id: "sample", label: "Try a sample" },
              { id: "decisions", label: "Decisions" },
            ]}
            active={tab}
            onChange={setTab}
          />
          {/* every panel stays mounted (hidden when not selected), so a draft default, override or sample survives a tab switch */}
          <GuardrailsPanel id="defaults" tab={tab}>
            <Card title="Deployment defaults">
              <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                {config.data?.org ? (
                  "These apply to every governed call unless an override or a compliance profile says otherwise."
                ) : (
                  // the chip itself is in the posture line above the tabs; its explanation is spelt out here
                  "No deployment default has been set, so the shipped posture applies: every added layer observes in 'log' mode and refuses nothing. Turning a layer up is a deliberate act."
                )}
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
                        <Badge tone="neutral">{d.tier}</Badge>{" "}
                        <Badge tone="neutral">{d.phases.join(" + ")}</Badge>{" "}
                        <Badge tone="neutral">{d.ruleCount} rules</Badge>
                      </div>
                      <div>
                        <Badge tone="warn" infoLabel={`the limits of ${d.id.replace(/_/g, " ")}`} info={d.limits}>
                          Limited coverage
                        </Badge>
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
          </GuardrailsPanel>

          <GuardrailsPanel id="overrides" tab={tab}>
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
                      srHeader: "Actions",
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
          </GuardrailsPanel>

          {/* ---------------- trained detectors (ADR-0220) ---------------- */}
          <GuardrailsPanel id="trained" tab={tab}>
            <TrainedDetectorsPanel />
          </GuardrailsPanel>

          <GuardrailsPanel id="content" tab={tab}>
            <DetectionContentPanel />
          </GuardrailsPanel>

          <GuardrailsPanel id="sample" tab={tab}>
            <Card
              title="Try a sample"
              info={
                <p>
                  Runs every detector over the text and reports what WOULD fire. Nothing is enforced,
                  dispatched or recorded as a violation — this is how you measure a layer's
                  false-positive rate on your own text before moving it off &lsquo;log&rsquo;.
                </p>
              }
            >
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
          </GuardrailsPanel>

          <GuardrailsPanel id="decisions" tab={tab}>
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
                  blocked {totals?.blocked ?? 0} · warned{" "}
                  {totals?.warned ?? 0} · logged{" "}
                  {totals?.logged ?? 0}. Sourced from the single audit log; counts
                  only, never the matched content.
                </span>
              </div>
                <DataList<ViolationRow>
                  listId="guardrail-decisions"
                  noun="guardrail decisions"
                  endpoint="/v1/guardrails/violations"
                  exportPath="/v1/guardrails/violations/export.xlsx"
                  queryKey={["admin", "guardrail-violations"]}
                  legacyKey="violations"
                  count="estimate"
                  filters={violationFilters}
                  defaultSort={{ key: "at", dir: "desc" }}
                  rowKey={(r) => r.id}
                  onRows={(_rows, raw) => setTotals((raw.totals as Record<string, number> | undefined) ?? null)}
                  empty={<EmptyState title="No guardrail events yet" body="Nothing has tripped a detector on this deployment." />}
                  columns={[
                    { key: "at", header: "When", main: true, sortable: true, render: (r) => ago(r.at) },
                    {
                      key: "outcome",
                      header: "Outcome",
                      main: true,
                      sortable: true,
                      required: "The outcome is always shown",
                      render: (r) => (
                        <Badge tone={r.effect === "deny" ? "danger" : "warn"}>
                          {r.detail.guardrail?.outcome ?? r.ruleId}
                        </Badge>
                      ),
                    },
                    { key: "phase", header: "Phase", main: true, sortable: true, render: (r) => r.detail.guardrail?.phase ?? "—" },
                    { key: "obj", header: "Surface", main: true, sortable: true, render: (r) => r.objectType },
                    {
                      key: "f",
                      header: "Findings (counts only)",
                      main: true,
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
            </Card>
          </GuardrailsPanel>
        </QueryGate>
      </div>
    </>
  );
}
