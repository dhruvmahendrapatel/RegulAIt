/**
 * AI vendor registry (ADR-0084) — the third-party front door.
 *
 * A vendor becomes a governed object whose assessment rides the pillar-2
 * rails: propose, scope at the resting plan stage, record the VENDOR'S OWN
 * ANSWERS in the assessment questionnaire, and a human sign-off on the ONE
 * approvals queue registers the assessment. Three things this page keeps
 * honest, rendered rather than merely documented:
 *
 *  - **Status is decided, never edited.** There is no status control anywhere
 *    here. Approved/rejected happen in the Approvals queue, on the linked
 *    workflow instance; this page only shows the result — and says that an
 *    approval signs off the vendor's claims, it does not verify them.
 *  - **Attested and measured never blend.** Every recorded answer is labelled
 *    "vendor-attested — not verified by this platform", carries who recorded
 *    it and from which questionnaire version, and feeds no pack scorecard.
 *  - **The checklist is the pack data model read-only.** Controls come from
 *    the framework's active compliance pack; nothing here writes into the
 *    org's own attestations or reports.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type VendorStatus = "proposed" | "under_assessment" | "approved" | "rejected" | "retired";

interface VendorAttestation {
  framework: string;
  packVersion: number;
  controlRef: string;
  statement: string;
  evidenceRef: string | null;
  recordedByUserId: string;
  recordedAt: string;
  questionnaireVersion: number;
}
interface VendorRow {
  id: string;
  name: string;
  description: string;
  category: string;
  ownerUserId: string;
  ownerName?: string | null;
  linkedCustomProviderIds: string[];
  linkedAgentProviders: string[];
  packAttestations: VendorAttestation[];
  status: VendorStatus;
  workflowInstanceId: string | null;
  decidedAt: string | null;
  retiredReason: string | null;
  createdAt: string;
}
interface VendorDetail {
  vendor: VendorRow;
  instance: {
    id: string;
    status: string;
    currentStageId: string | null;
    stages: Array<{ id: string; type: string }>;
  } | null;
  questionnaire: { version: number; content: string; createdAt: string } | null;
  questionnaireTemplate: string | null;
  attestations: VendorAttestation[];
  packChecklist: {
    framework: string;
    pack: { id: string; version: number; title: string } | null;
    controls: Array<{
      controlRef: string;
      title: string;
      coverage: string;
      vendorAttestation: VendorAttestation | null;
    }>;
    note: string;
    disclaimer: string;
  } | null;
  disclaimer: string;
}

const statusTone = (s: VendorStatus): Tone =>
  s === "approved" ? "ok" : s === "under_assessment" ? "info" : s === "rejected" ? "danger" : s === "retired" ? "warn" : "neutral";

const CATEGORY_LABELS: Record<string, string> = {
  model_provider: "model provider",
  ai_feature_vendor: "AI-feature vendor",
  data_processor: "data processor",
  integration: "integration",
};

export default function VendorsPage() {
  const act = useAction();

  const list = useQuery({
    queryKey: ["admin", "vendors"],
    queryFn: () => api.get<{ vendors: VendorRow[]; disclaimer: string }>("/v1/vendors"),
  });
  const packs = useQuery({
    queryKey: ["admin", "vendors", "packs"],
    queryFn: () =>
      api.get<{ packs: Array<{ framework: string; status: string }> }>("/v1/compliance/packs"),
  });
  const activeFrameworks = [
    ...new Set((packs.data?.packs ?? []).filter((p) => p.status === "active").map((p) => p.framework)),
  ];

  const [openId, setOpenId] = useState<string | null>(null);
  const [framework, setFramework] = useState("");
  const detail = useQuery({
    queryKey: ["admin", "vendor", openId, framework],
    queryFn: () =>
      api.get<VendorDetail>(
        `/v1/vendors/${openId}${framework ? `?framework=${encodeURIComponent(framework)}` : ""}`,
      ),
    enabled: Boolean(openId),
  });

  // propose form
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("ai_feature_vendor");
  const [providers, setProviders] = useState("");

  // questionnaire + attestation + retire
  const [answers, setAnswers] = useState("");
  const [attestControl, setAttestControl] = useState("");
  const [attestStatement, setAttestStatement] = useState("");
  const [retireReason, setRetireReason] = useState("");

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Vendors"
        sub="Third-party AI as a governed object: a proposed vendor starts a real assessment workflow — plan, questionnaire, human sign-off on the one Approvals queue. Everything a vendor supplies is an attestation: a recorded claim with attribution, never verified by this platform and never blended into computed evidence."
      />
      <div className={v.stack}>
        {/* ---------------- propose ---------------- */}
        <Card title="Propose an AI vendor">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/vendors", {
                  name,
                  description: desc,
                  category,
                  linkedAgentProviders: providers.split(",").map((p) => p.trim()).filter(Boolean),
                });
                setName("");
                setDesc("");
                setProviders("");
                await refreshAll();
              }, "Vendor proposed — its assessment workflow is resting at the plan stage");
            }}
          >
            <div className={a.formRow}>
              <Field label="Vendor name" grow>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Transcribe" required />
              </Field>
              <Field label="Category">
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="model_provider">model provider</option>
                  <option value="ai_feature_vendor">AI-feature vendor</option>
                  <option value="data_processor">data processor</option>
                  <option value="integration">integration</option>
                </Select>
              </Field>
            </div>
            <Field label="Description — what of ours its AI touches">
              <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} required />
            </Field>
            <Field label="Linked provider keys (comma-separated, optional — as they appear on agents)">
              <Input value={providers} onChange={(e) => setProviders(e.target.value)} placeholder="" />
            </Field>
            <div>
              <Button type="submit" disabled={act.busy}>Propose vendor</Button>
            </div>
          </form>
        </Card>

        {/* ---------------- registry ---------------- */}
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <Card title="Registry">
            {(list.data?.vendors ?? []).length === 0 ? (
              <EmptyState
                title="No vendors yet"
                body="Propose one above — third-party AI risk starts being legible when the third party is a governed object."
              />
            ) : (
              <Table
                rows={list.data?.vendors ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
                columns={[
                  { key: "name", header: "Vendor", render: (r) => r.name },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => <Badge tone={statusTone(r.status)}>{r.status.replace(/_/g, " ")}</Badge>,
                  },
                  { key: "category", header: "Category", render: (r) => CATEGORY_LABELS[r.category] ?? r.category },
                  {
                    key: "attest",
                    header: "Attestations",
                    render: (r) =>
                      r.packAttestations.length ? (
                        `${r.packAttestations.length} recorded`
                      ) : (
                        <span className={v.faint}>none</span>
                      ),
                  },
                  { key: "owner", header: "Owner", render: (r) => r.ownerName ?? r.ownerUserId },
                  { key: "created", header: "Proposed", render: (r) => ago(r.createdAt) },
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
                title={`Vendor: ${d.vendor.name}`}
                actions={<Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>}
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={statusTone(d.vendor.status)}>{d.vendor.status.replace(/_/g, " ")}</Badge>{" "}
                    <span className={v.faint}>
                      {d.vendor.status === "retired"
                        ? `retired: ${d.vendor.retiredReason}`
                        : d.vendor.decidedAt
                          ? `decided ${ago(d.vendor.decidedAt)} by the assessment instance's sign-off — a sign-off on the vendor's attested answers, not a verification of them`
                          : "status follows the linked assessment workflow — it is decided, never edited here"}
                    </span>
                  </div>
                  <div className={v.faint}>{d.vendor.description}</div>
                  {d.vendor.linkedAgentProviders.length > 0 && (
                    <div className={v.faint}>Linked providers: {d.vendor.linkedAgentProviders.join(", ")}</div>
                  )}

                  {/* the linked workflow's state */}
                  {d.instance && (
                    <Card title="Assessment workflow (pillar-2 rails)">
                      <div className={v.stack}>
                        <div>
                          {d.instance.stages.map((s) => (
                            <Badge
                              key={s.id}
                              tone={s.id === d.instance!.currentStageId ? "info" : "neutral"}
                              title={s.type}
                            >
                              {s.id}
                            </Badge>
                          ))}{" "}
                          <span className={v.faint}>instance {d.instance.status.replace(/_/g, " ")}</span>
                        </div>
                        {d.instance.status === "blocked_on_plan" && (
                          <div>
                            <Button
                              onClick={() =>
                                void act.run(async () => {
                                  await api.post(`/v1/workflows/instances/${d.instance!.id}/advance`, { stageId: "plan" });
                                  await refreshAll();
                                }, "Planning finished — record the vendor's answers and submit the questionnaire")
                              }
                            >
                              Finish planning
                            </Button>{" "}
                            <span className={v.faint}>
                              The instance rests at the plan stage (ADR-0079) while the assessment is scoped.
                            </span>
                          </div>
                        )}
                        {d.instance.status === "blocked_on_approval" && (
                          <div className={v.faint}>
                            Awaiting sign-off — the decision happens in the{" "}
                            <Link to="/admin/approvals">Approvals queue</Link>, never here.
                          </div>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* questionnaire: submitted artifact, or the blank form to fill */}
                  {d.questionnaire ? (
                    <Card title={`Assessment questionnaire (artifact v${d.questionnaire.version}) — vendor-supplied answers`}>
                      <pre className={v.pre ?? undefined} style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                        {d.questionnaire.content}
                      </pre>
                    </Card>
                  ) : d.instance && d.instance.status === "blocked_on_artifact" ? (
                    <Card title="Assessment questionnaire — record the vendor's answers and submit">
                      <div className={v.stack}>
                        <div className={v.faint}>
                          Every answer below is the vendor&apos;s claim, recorded by you — nothing is pre-filled by a
                          model and nothing is verified by this platform. Submitting stores it as the instance&apos;s
                          versioned artifact and sends the vendor to assessment review.
                        </div>
                        <Textarea
                          rows={14}
                          value={answers || d.questionnaireTemplate || ""}
                          onChange={(e) => setAnswers(e.target.value)}
                        />
                        <div>
                          <Button
                            disabled={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await api.post(`/v1/workflows/instances/${d.instance!.id}/artifacts`, {
                                  stageId: "questionnaire",
                                  content: answers || d.questionnaireTemplate || "",
                                });
                                setAnswers("");
                                await refreshAll();
                              }, "Questionnaire submitted — the vendor is under assessment")
                            }
                          >
                            Submit questionnaire
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ) : null}

                  {/* attested checklist — the pack data model read-only */}
                  <Card title="Pack-control checklist — vendor-attested, not verified by this platform">
                    <div className={v.stack}>
                      <div className={v.faint}>{d.disclaimer}</div>
                      <div className={a.formRow}>
                        <Field label="Framework (active compliance packs)">
                          <Select value={framework} onChange={(e) => setFramework(e.target.value)}>
                            <option value="">choose a framework…</option>
                            {activeFrameworks.map((f) => (
                              <option key={f} value={f}>{f}</option>
                            ))}
                          </Select>
                        </Field>
                      </div>
                      {d.packChecklist &&
                        (d.packChecklist.pack ? (
                          <>
                            <div className={v.faint}>
                              {d.packChecklist.pack.title} (v{d.packChecklist.pack.version}) — {d.packChecklist.note}
                            </div>
                            <Table
                              rows={d.packChecklist.controls}
                              rowKey={(c) => c.controlRef}
                              columns={[
                                { key: "ref", header: "Control", render: (c) => c.controlRef },
                                { key: "title", header: "Title", render: (c) => c.title },
                                {
                                  key: "answer",
                                  header: "Vendor answer (attestation)",
                                  render: (c) =>
                                    c.vendorAttestation ? (
                                      <span>
                                        <Badge tone="warn">vendor claims</Badge> {c.vendorAttestation.statement}{" "}
                                        <span className={v.faint}>
                                          (recorded {ago(c.vendorAttestation.recordedAt)}, questionnaire v
                                          {c.vendorAttestation.questionnaireVersion})
                                        </span>
                                      </span>
                                    ) : (
                                      <span className={v.faint}>no answer recorded</span>
                                    ),
                                },
                              ]}
                            />
                            {d.vendor.status !== "retired" && (
                              <div className={a.formRow}>
                                <Field label="Control ref">
                                  <Select value={attestControl} onChange={(e) => setAttestControl(e.target.value)}>
                                    <option value="">choose…</option>
                                    {d.packChecklist.controls.map((c) => (
                                      <option key={c.controlRef} value={c.controlRef}>{c.controlRef}</option>
                                    ))}
                                  </Select>
                                </Field>
                                <Field label="Vendor's answer — recorded verbatim as a claim" grow>
                                  <Input
                                    value={attestStatement}
                                    onChange={(e) => setAttestStatement(e.target.value)}
                                    placeholder="vendor claims…"
                                  />
                                </Field>
                                <Field label=" ">
                                  <Button
                                    disabled={act.busy || !attestControl || !attestStatement.trim() || !d.questionnaire}
                                    onClick={() =>
                                      void act.run(async () => {
                                        await api.post(`/v1/vendors/${d.vendor.id}/attestations`, {
                                          framework: d.packChecklist!.framework,
                                          controlRef: attestControl,
                                          statement: attestStatement.trim(),
                                        });
                                        setAttestControl("");
                                        setAttestStatement("");
                                        await refreshAll();
                                      }, "Vendor attestation recorded — a claim with attribution, never evidence")
                                    }
                                  >
                                    Record attestation
                                  </Button>
                                </Field>
                              </div>
                            )}
                            {!d.questionnaire && (
                              <div className={v.faint}>
                                Attestations are recorded FROM the assessment questionnaire — submit it first.
                              </div>
                            )}
                          </>
                        ) : (
                          <div className={v.faint}>{d.packChecklist.note}</div>
                        ))}
                    </div>
                  </Card>

                  {/* retire (admin) */}
                  {d.vendor.status !== "retired" && (
                    <div className={a.formRow}>
                      <Field label="Retire (admin) — reason is required and audited" grow>
                        <Input
                          value={retireReason}
                          onChange={(e) => setRetireReason(e.target.value)}
                          placeholder="contract ended; AI features disabled"
                        />
                      </Field>
                      <Field label=" ">
                        <Button
                          variant="danger"
                          disabled={act.busy || !retireReason.trim()}
                          onClick={() =>
                            void act.run(async () => {
                              await api.post(`/v1/vendors/${d.vendor.id}/retire`, { reason: retireReason.trim() });
                              setRetireReason("");
                              await refreshAll();
                            }, "Vendor retired")
                          }
                        >
                          Retire vendor
                        </Button>
                      </Field>
                    </div>
                  )}
                </div>
              </Card>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}
