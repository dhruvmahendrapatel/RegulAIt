/**
 * AI risk register (ADR-0081) — gap L2's named-risk layer over the measurements.
 *
 * The register links what this deployment already measures — red-team ASR,
 * groundedness evals, guardrail configs, the denial trails — to named risk
 * scenarios with an owner, a mitigating control, and a residual-risk
 * acceptance record. Three things this page keeps honest, rendered rather
 * than merely documented:
 *
 *  - **Evidence is computed, never ticked.** The evidence panel is a live
 *    read of the real ledgers at the moment the detail loads. There is no
 *    control anywhere here (or in the API) that sets an evidence number.
 *  - **Measured and declared never blend.** The owner's likelihood/impact
 *    render in their own labelled block beside the ledger numbers; no
 *    combined score exists anywhere.
 *  - **Acceptance is a record, not a control.** Accepting residual risk is an
 *    admin (or named risk acceptor) act with a required rationale; it changes
 *    no enforcement, and the evidence measured at that moment is frozen into
 *    the audit trail.
 *  - **Acceptance is time-boxed (ADR-0180 §6).** Each acceptance has an expiry
 *    capped by the residual level (6 months for high or critical, 12
 *    otherwise); history is kept, and an expired acceptance reopens the risk.
 *    The admin's tolerance editor sits at the top of the page.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useAgents, useProjects, agentOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { RiskLibraryPicker } from "./RiskLibraryPicker";
import { RiskAcceptancePanel } from "./RiskAcceptancePanel";
import { RiskTolerancePanel } from "./RiskTolerancePanel";
import { useSession } from "../../../session/SessionContext";

type RiskStatus = "open" | "mitigating" | "accepted" | "closed";

interface RiskRow {
  id: string;
  title: string;
  description: string;
  category: string;
  ownerUserId: string;
  ownerName?: string | null;
  projectId: string | null;
  agentId: string | null;
  useCaseId: string | null;
  status: RiskStatus;
  likelihood: string;
  impact: string;
  mitigation: string | null;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  acceptanceNote: string | null;
  createdAt: string;
}
interface LibraryEntry {
  key: string;
  title: string;
  description: string;
  category: string;
  likelihood: string;
  impact: string;
  mitigatingControl: string;
  evidenceResolvers: string[];
}
interface EvidenceEntry {
  resolver: string;
  kind: "measured" | "configuration" | "none";
  source: string | null;
  queried: string | null;
  measured: Record<string, unknown> | null;
  evidence?: string;
  note?: string;
}
interface RiskDetail {
  risk: RiskRow;
  declared: {
    likelihood: string;
    impact: string;
    status: RiskStatus;
    mitigation: string | null;
    acceptance: { acceptedByUserId: string | null; acceptedAt: string; note: string } | null;
    note: string;
  };
  evidence: {
    window: { start: string; end: string; days: number };
    scope: { projectId: string | null; agentId: string | null };
    entries: EvidenceEntry[];
    computedAt: string;
    note: string;
    disclaimer: string;
  };
}

const statusTone = (s: RiskStatus): Tone =>
  s === "accepted" ? "warn" : s === "mitigating" ? "info" : s === "closed" ? "neutral" : "danger";
const kindTone = (k: EvidenceEntry["kind"]): Tone =>
  k === "measured" ? "info" : k === "configuration" ? "ok" : "warn";

function measuredCells(m: Record<string, unknown>): string {
  return Object.entries(m)
    .map(([k, val]) =>
      val !== null && typeof val === "object"
        ? `${k}: ${JSON.stringify(val)}`
        : `${k}: ${String(val)}`,
    )
    .join("  ·  ");
}

export default function RisksPage() {
  const [searchParams] = useSearchParams();
  const agents = useAgents();
  const projects = useProjects();
  const act = useAction();

  const library = useQuery({
    queryKey: ["admin", "risk-library"],
    queryFn: () => api.get<{ library: LibraryEntry[]; disclaimer: string }>("/v1/risks/library"),
  });
  const list = useQuery({
    queryKey: ["admin", "risks"],
    queryFn: () => api.get<{ risks: RiskRow[] }>("/v1/risks"),
  });
  const [openId, setOpenId] = useState<string | null>(searchParams.get("riskId"));
  const detail = useQuery({
    queryKey: ["admin", "risk", openId],
    queryFn: () => api.get<RiskDetail>(`/v1/risks/${openId}`),
    enabled: Boolean(openId),
  });

  // register form — library-seeded, everything overridable before submit
  const [libKey, setLibKey] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("tool_misuse");
  const [likelihood, setLikelihood] = useState("medium");
  const [impact, setImpact] = useState("medium");
  const [mitigation, setMitigation] = useState("");
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");

  // detail actions
  const [transitionReason, setTransitionReason] = useState("");
  const { auth } = useSession();

  const seedFromLibrary = (key: string) => {
    setLibKey(key);
    const entry = (library.data?.library ?? []).find((e) => e.key === key);
    if (!entry) return;
    setTitle(entry.title);
    setDesc(entry.description);
    setCategory(entry.category);
    setLikelihood(entry.likelihood);
    setImpact(entry.impact);
    setMitigation(entry.mitigatingControl);
  };

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Risks"
        sub="The register that makes the measurements legible as risk."
        info={<p>The register that makes the measurements legible as risk: a named scenario, an owner, the mitigating control we actually enforce, and a residual-risk acceptance record. Evidence is computed live from the real ledgers at read time — never hand-ticked — and likelihood/impact stay declared human judgments beside it, never blended into a score.</p>}
      />
      <div className={v.stack}>
        {auth?.isAdmin ? <RiskTolerancePanel /> : null}
        <RiskLibraryPicker onAdded={() => void refreshAll()} />
        {/* ---------------- register ---------------- */}
        <Card title="Register a risk">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/risks", {
                  title,
                  description: desc,
                  category,
                  likelihood,
                  impact,
                  ...(mitigation.trim() ? { mitigation: mitigation.trim() } : {}),
                  ...(agentId ? { agentId } : {}),
                  ...(projectId ? { projectId } : {}),
                });
                setLibKey("");
                setTitle("");
                setDesc("");
                setMitigation("");
                await refreshAll();
              }, "Risk registered — its evidence is computed from the ledgers on every read");
            }}
          >
            <div className={a.formRow}>
              <Field label="Seed from the risk library (optional)" grow>
                <Select value={libKey} onChange={(e) => seedFromLibrary(e.target.value)}>
                  {optionEls(
                    (library.data?.library ?? []).map((l) => ({ v: l.key, l: l.title })),
                    "start blank",
                  )}
                </Select>
              </Field>
              <Field label="Category (the evidence key)">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="tool_misuse">tool misuse</option>
                  <option value="scope_drift">scope drift</option>
                  <option value="prompt_injection">prompt injection</option>
                  <option value="data_leakage_pii">data leakage / PII</option>
                  <option value="over_permissioning">over-permissioning</option>
                  <option value="budget_overrun">budget overrun</option>
                  <option value="hallucination">hallucination</option>
                  <option value="shadow_ai">shadow AI</option>
                  <option value="third_party_ai">third-party AI (vendors)</option>
                  <option value="bias_fairness">bias / fairness</option>
                  <option value="unsafe_output">unsafe output</option>
                </Select>
              </Field>
            </div>
            <Field label="Risk title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="adversarial input steers an agent" required />
            </Field>
            <Field label="Scenario description">
              <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} required />
            </Field>
            <Field label="Mitigating control — what this deployment actually enforces">
              <Textarea rows={2} value={mitigation} onChange={(e) => setMitigation(e.target.value)} />
            </Field>
            <div className={a.formRow}>
              <Field label="Likelihood (declared judgment)">
                <Select value={likelihood} onChange={(e) => setLikelihood(e.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </Field>
              <Field label="Impact (declared judgment)">
                <Select value={impact} onChange={(e) => setImpact(e.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </Select>
              </Field>
              <Field label="Agent scope (optional)">
                <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {optionEls(agentOpts(agents.data?.agents), "org-wide")}
                </Select>
              </Field>
              <Field label="Project scope (optional)">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {optionEls((projects.data?.projects ?? []).map((p) => ({ v: p.id, l: p.name })), "org-wide")}
                </Select>
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={act.busy}>Register risk</Button>
            </div>
          </form>
        </Card>

        {/* ---------------- register list ---------------- */}
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <Card title="Register">
            {(list.data?.risks ?? []).length === 0 ? (
              <EmptyState
                title="No risks registered yet"
                body="Register one above — the library seeds the scenarios this deployment's ledgers can evidence."
              />
            ) : (
              <Table
                rows={list.data?.risks ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
                columns={[
                  { key: "title", header: "Risk", render: (r) => r.title },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
                  },
                  {
                    key: "category",
                    header: "Category",
                    render: (r) => <Badge tone="neutral">{r.category.replace(/_/g, " ")}</Badge>,
                  },
                  {
                    key: "declared",
                    header: "Declared L/I",
                    render: (r) => (
                      <span className={v.faint}>
                        {r.likelihood} / {r.impact}
                      </span>
                    ),
                  },
                  { key: "owner", header: "Owner", render: (r) => r.ownerName ?? r.ownerUserId },
                  { key: "created", header: "Registered", render: (r) => ago(r.createdAt) },
                ]}
              />
            )}
          </Card>
        </QueryGate>

        {/* ---------------- detail ---------------- */}
        {openId && (
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {d && (
              <Card
                title={`Risk: ${d.risk.title}`}
                actions={<Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>}
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={statusTone(d.risk.status)}>{d.risk.status}</Badge>{" "}
                    <Badge tone="neutral">{d.risk.category.replace(/_/g, " ")}</Badge>{" "}
                    <span className={v.faint}>
                      {d.risk.status === "accepted"
                        ? `residual risk accepted ${d.risk.acceptedAt ? ago(d.risk.acceptedAt) : ""}: ${d.risk.acceptanceNote}`
                        : "status moves through audited transitions; acceptance is its own recorded act"}
                    </span>
                  </div>
                  <div className={v.faint}>{d.risk.description}</div>

                  {/* DECLARED — the human's side, labelled */}
                  <Card title="Declared — human judgments (never blended into the evidence)">
                    <div className={a.formRow}>
                      <Field label="Likelihood">
                        <Input readOnly value={d.declared.likelihood} />
                      </Field>
                      <Field label="Impact">
                        <Input readOnly value={d.declared.impact} />
                      </Field>
                      <Field label="Mitigating control" grow>
                        <Input readOnly value={d.declared.mitigation ?? "none recorded"} />
                      </Field>
                    </div>
                  </Card>

                  {/* MEASURED — the ledgers' side, computed at read time */}
                  <Card title={`Evidence — computed live from the ledgers (last ${d.evidence.window.days} days)`}>
                    <div className={v.stack}>
                      <div className={v.faint}>{d.evidence.note}</div>
                      {d.evidence.entries.map((e) => (
                        <div key={e.resolver}>
                          <Badge tone={kindTone(e.kind)}>{e.kind}</Badge>{" "}
                          <strong>{e.resolver.replace(/_/g, " ")}</strong>{" "}
                          {e.kind === "none" ? (
                            <span className={v.faint}>
                              {e.evidence} — {e.note}
                            </span>
                          ) : (
                            <span className={v.faint}>
                              {e.measured ? measuredCells(e.measured) : ""}
                              {e.note ? ` — ${e.note}` : ""}
                              {e.queried ? ` (queried: ${e.queried})` : ""}
                            </span>
                          )}
                        </div>
                      ))}
                      <div className={v.faint}>{d.evidence.disclaimer}</div>
                    </div>
                  </Card>

                  {/* transitions (owner or admin) */}
                  {(d.risk.status === "open" || d.risk.status === "mitigating") && (
                    <div className={a.formRow}>
                      <Field label="Transition reason — required and audited" grow>
                        <Input
                          value={transitionReason}
                          onChange={(e) => setTransitionReason(e.target.value)}
                          placeholder="guardrail rollout under way"
                        />
                      </Field>
                      <Field label=" ">
                        <Button
                          disabled={act.busy || !transitionReason.trim()}
                          onClick={() =>
                            void act.run(async () => {
                              await api.post(`/v1/risks/${d.risk.id}/transition`, {
                                status: d.risk.status === "open" ? "mitigating" : "open",
                                reason: transitionReason.trim(),
                              });
                              setTransitionReason("");
                              await refreshAll();
                            }, "Risk transitioned — the move and its reason are on the audit trail")
                          }
                        >
                          {d.risk.status === "open" ? "Start mitigating" : "Back to open"}
                        </Button>
                      </Field>
                      <Field label=" ">
                        <Button
                          variant="ghost"
                          disabled={act.busy || !transitionReason.trim()}
                          onClick={() =>
                            void act.run(async () => {
                              await api.post(`/v1/risks/${d.risk.id}/transition`, {
                                status: "closed",
                                reason: transitionReason.trim(),
                              });
                              setTransitionReason("");
                              await refreshAll();
                            }, "Risk closed")
                          }
                        >
                          Close risk
                        </Button>
                      </Field>
                    </div>
                  )}

                  {/* ADR-0180 §6: tolerance vs residual, the acceptance history, the time-boxed accept form */}
                  <RiskAcceptancePanel key={d.risk.id} riskId={d.risk.id} onChanged={() => void refreshAll()} />
                </div>
              </Card>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}
