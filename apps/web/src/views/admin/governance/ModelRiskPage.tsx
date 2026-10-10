/**
 * Model risk management (ADR-0045).
 *
 * The screen where "has a human accepted the risk of using this model for this
 * purpose, and is that acceptance still valid?" is answered. Four things it
 * exists to keep honest, rendered rather than merely documented:
 *
 *  - **The posture label is computed, never claimed.** With `mrmEnforced` off
 *    the banner says DECLARED but NOT enforced, in those words, because a page
 *    that implies a gate the toggle does not back is worse than no page.
 *  - **Bias/fairness is a DECLARATION, and the page says so where an admin
 *    reads it.** RegulAIt does not measure fairness. The slots record what was
 *    assessed, by whom, and where the evidence lives; the disclaimer travels
 *    with the number so the number is never mistaken for a measurement.
 *  - **Expiry is work, not an outage.** The expiring list is the first thing
 *    below the posture banner, because the point of a recertification date is
 *    that somebody acts on it BEFORE it stops production.
 *  - **Sign-off is not here.** The request goes to the ONE Approvals Queue and
 *    the decision is made there. This page has no approve button, deliberately.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import {
  QueryGate,
  RemoveButton,
  optionEls,
  useAction,
  useAgents,
  useUsers,
  userOpts,
  agentOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { EngineScanEvidenceChip } from "./EngineScanChip";
import type { ArtifactScan } from "./modelArtifacts";

type CardState = "unsigned" | "pending" | "approved" | "expiring" | "expired" | "revoked";

interface BiasSlot {
  dimension: string;
  method: string;
  resultRef?: string | null;
  status: "not_assessed" | "in_progress" | "assessed" | "waived";
  assessedAt?: string | null;
  assessedBy?: string | null;
}
interface SignOff {
  id: string;
  status: string;
  effectiveStatus: string;
  approverUserId: string;
  approvalId: string | null;
  validUntil: string | null;
  daysUntilExpiry: number | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  supersedesId: string | null;
  requestedAt: string;
}
interface Evidence {
  id: string;
  kind: "eval_run" | "external" | "engine_scan";
  evalRunId: string | null;
  externalRef: string | null;
  /** ADR-0187 B5-M: an `engine_scan` row cites a model-artifact scan; the read carries the scan (null if it is gone) */
  artifactScanId?: string | null;
  artifactScan?: ArtifactScan | null;
  label: string | null;
  attachedAt: string;
}
interface ModelCard {
  id: string;
  agentId: string | null;
  customProviderId: string | null;
  intendedUse: string;
  limitations: string | null;
  dataClaims: Record<string, unknown>;
  biasFairness: BiasSlot[];
  standardRefs: string[];
  state: CardState;
  daysUntilExpiry: number | null;
  subjectKind?: string;
  subjectName?: string | null;
  subjectModel?: string | null;
  approvals: SignOff[];
  evidence: Evidence[];
  completeness: {
    complete: boolean;
    missing: string[];
    bias: { declared: number; assessed: number; waived: number; unevidenced: number; complete: boolean; disclaimer: string };
  };
  createdAt: string;
}
interface StatusView {
  enforced: boolean;
  warnDays: number;
  /** ADR-0086 §3's follow-up (batch B3): staleness-forces-recertification —
   * on by default (ADR-0181); deepens the dispatch gate and only bites while enforced */
  stalenessRecertEnabled: boolean;
  stalenessRecertThreshold: number;
  posture: "enforced" | "declared" | "absent";
  label: string;
  cards: number;
  approved: number;
  expiring: number;
  expired: number;
  pending: number;
  unsigned: number;
  revoked: number;
  note: string;
}
interface ExpiringView {
  warnDays: number;
  items: Array<SignOff & { cardId: string; intendedUse: string | null }>;
}

/** ADR-0086 — the ledger-computed block on the detail read. Rendered apart
 * from the manually attached evidence, always; the two never blend. */
interface AutofillView {
  computedAt: string;
  window: { days: number };
  note: string;
  sections: {
    evals: {
      runsEver: number;
      runsInWindow: number;
      latestRun: { id: string; passRate: number | null; cases: number; startedAt: string } | null;
      groundedness: {
        runsInWindow: number;
        latestRun: { scorerKind: string; passRate: number | null } | null;
        note?: string;
      };
      note?: string;
    };
    redteam: {
      measured: boolean;
      runsEver: number;
      latestRun: {
        asr: number | null;
        asrLower: number | null;
        asrUpper: number | null;
        asrTrials: number;
        measurementQuality: string | null;
        startedAt: string;
      } | null;
      note: string;
    };
    guardrails: {
      orgDefault: { modes: Record<string, string> } | null;
      agentOverrides: Array<{ agentId: string | null; modes: Record<string, string> }>;
      note: string;
    };
    usage: {
      dispatchesInWindow: number;
      costUsdInWindow: number;
      lastDispatchAt: string | null;
      note?: string;
    };
    grants: {
      effectiveHolders: number;
      directUsers: number;
      grantingRoles: string[];
      revokedUsers: number;
      note: string;
    };
    drift: {
      baselinesPinned: number;
      latestScheduledRun: { regression: boolean | null; scoreDelta: number | null; startedAt: string } | null;
      regressionsInWindow: number;
      note?: string;
    };
    links: {
      useCases: Array<{ id: string; name: string; status: string }>;
      risks: Array<{ id: string; title: string; status: string; category: string }>;
      vendors: Array<{ id: string; name: string; status: string }>;
      note: string;
    };
  };
}
interface StalenessView {
  certified: boolean;
  lastCertifiedAt: string | null;
  changesSinceCertification: Record<string, number> | null;
  drifted: boolean;
  summary: string | null;
  /** ADR-0181: risks only non-admins have written, awaiting triage (not drift) */
  pendingTriage?: string | null;
  note: string;
}

const modeSummary = (modes: Record<string, string>) =>
  Object.entries(modes)
    .map(([k, v2]) => `${k}=${v2}`)
    .join(", ");

const stateTone = (s: CardState) =>
  s === "approved" ? "ok" : s === "expiring" ? "warn" : s === "pending" ? "info" : "danger";

export default function ModelRiskPage() {
  const agents = useAgents();
  const users = useUsers();
  const act = useAction();

  const status = useQuery({
    queryKey: ["admin", "mrm-status"],
    queryFn: () => api.get<StatusView>("/v1/mrm/status"),
  });
  const cards = useQuery({
    queryKey: ["admin", "mrm-cards"],
    queryFn: () => api.get<{ cards: ModelCard[]; enforced: boolean }>("/v1/mrm/cards"),
  });
  const expiring = useQuery({
    queryKey: ["admin", "mrm-expiring"],
    queryFn: () => api.get<ExpiringView>("/v1/mrm/expiring"),
  });


  const [newAgent, setNewAgent] = useState("");
  const [newUse, setNewUse] = useState("");
  const [newLimits, setNewLimits] = useState("");
  const [newClaims, setNewClaims] = useState("");
  const [newRefs, setNewRefs] = useState("");
  const [openCard, setOpenCard] = useState<string | null>(null);
  // ADR-0086 — the DETAIL read is the one that fills itself from the ledgers;
  // it is fetched per open card (the list read stays cheap on purpose)
  const cardDetail = useQuery({
    queryKey: ["admin", "mrm-card", openCard],
    enabled: openCard !== null,
    queryFn: () =>
      api.get<{ card: ModelCard & { autofill: AutofillView; staleness: StalenessView } }>(
        `/v1/mrm/cards/${openCard}`,
      ),
  });
  const [approver, setApprover] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [evidenceRun, setEvidenceRun] = useState("");
  // ADR-0187 X28: a model-artifact scan cited as evidence (its id from Admission review → Model artifacts)
  const [evidenceScan, setEvidenceScan] = useState("");
  // ADR-0086 B3: the staleness-recert threshold edit buffer (null = untouched)
  const [stalenessThreshold, setStalenessThreshold] = useState<string | null>(null);

  const refreshAll = async () => {
    await Promise.all([status.refetch(), cards.refetch(), expiring.refetch(), cardDetail.refetch()]);
  };

  const detail = (cards.data?.cards ?? []).find((c) => c.id === openCard) ?? null;
  const autofill = openCard === cardDetail.data?.card.id ? cardDetail.data.card.autofill : null;
  const staleness = openCard === cardDetail.data?.card.id ? cardDetail.data.card.staleness : null;

  return (
    <>
      <PageHeader
        title="Model risk"
        sub="One risk position, on one model, for one stated purpose."
        info={<p>A model card is one risk position on one model for one stated purpose: intended use, provider-stated data claims, known limitations, a recorded bias/fairness assessment, linked evidence, a named human sign-off, and the date that sign-off lapses. regulAIt records and expires these; it does NOT measure bias or fairness — that requires running the model against a purpose-built dataset.</p>}
      />
      <div className={v.stack}>
        <QueryGate
          loading={status.isLoading || cards.isLoading}
          error={status.error ?? cards.error}
          onRetry={() => void refreshAll()}
        >
          {/* ---------------- posture ---------------- */}
          <Card title="Enforcement posture">
            <div className={v.stack}>
              <div>
                <Badge
                  tone={
                    status.data?.posture === "enforced"
                      ? "ok"
                      : status.data?.posture === "declared"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {status.data?.posture ?? "—"}
                </Badge>{" "}
                <span className={v.faint}>{status.data?.label}</span>
              </div>
              <div className={a.formRow}>
                <Field label="Refuse dispatch of an unreviewed or lapsed model">
                  <Select
                    value={status.data?.enforced ? "on" : "off"}
                    onChange={(e) =>
                      void act.run(async () => {
                        await withStepUp((h) => stepUpApi.post("/v1/mrm/enforcement", { enforced: e.target.value === "on" }, h));
                        await refreshAll();
                      }, "Model-risk enforcement updated")
                    }
                  >
                    <option value="on">on — 409 at dispatch without a live sign-off (strict default)</option>
                    <option value="off">off — cards are recorded, nothing is refused</option>
                  </Select>
                </Field>
                <Field label={`Warn window (days before validUntil)`}>
                  <Input readOnly value={status.data?.warnDays ?? 30} />
                </Field>
                <Field label="Expiry sweep">
                  <Button
                    onClick={() =>
                      void act.run(async () => {
                        const r = await api.post<{ expired: number }>("/v1/mrm/expiry-sweep", {});
                        await refreshAll();
                        return `${r.expired} lapsed sign-off(s) marked expired`;
                      })
                    }
                  >
                    Run sweep
                  </Button>
                </Field>
              </div>
              {/* ADR-0086 §3's follow-up (batch B3) — staleness forces
                  recertification: a per-org opt-in DEEPENING the dispatch
                  gate above. On by default (ADR-0181); off = staleness
                  informs and gates nothing, as ADR-0086 first shipped. */}
              <div className={a.formRow}>
                <Field label="Staleness forces recertification">
                  <Select
                    value={status.data?.stalenessRecertEnabled ? "on" : "off"}
                    onChange={(e) =>
                      void act.run(async () => {
                        await withStepUp((h) => stepUpApi.post("/v1/mrm/enforcement", {
                          enforced: status.data?.enforced ?? true,
                          stalenessRecertEnabled: e.target.value === "on",
                        }, h));
                        await refreshAll();
                      }, "Staleness-recertification setting updated")
                    }
                  >
                    <option value="on">on — a certified card that drifted past the threshold refuses dispatch (strict default)</option>
                    <option value="off">off — drift informs, nothing more</option>
                  </Select>
                </Field>
                <Field label="Drift threshold (regressions and changes since certification)">
                  <Input
                    type="number"
                    min={1}
                    value={stalenessThreshold ?? status.data?.stalenessRecertThreshold ?? 1}
                    onChange={(e) => setStalenessThreshold(e.target.value)}
                  />
                </Field>
                {/* OUTSIDE a Field on purpose: a <label>-wrapped button
                    inherits the label text as its accessible name */}
                <div style={{ alignSelf: "flex-end" }}>
                  <Button
                    disabled={act.busy || stalenessThreshold === null}
                    onClick={() =>
                      void act.run(async () => {
                        await withStepUp((h) => stepUpApi.post("/v1/mrm/enforcement", {
                          enforced: status.data?.enforced ?? true,
                          stalenessRecertThreshold: Number(stalenessThreshold),
                        }, h));
                        setStalenessThreshold(null);
                        await refreshAll();
                      }, "Drift threshold saved")
                    }
                  >
                    Save threshold
                  </Button>
                </div>
              </div>
              <div className={v.faint}>
                Staleness-forces-recertification only bites while the dispatch gate above is on — it
                deepens that gate, it creates none of its own. When armed, a card with a LIVE
                sign-off that has drifted at least this many times since the last granting decision
                refuses dispatch on the same 409 the expiry gate uses, naming the drift; a
                recertification resets the clock. Drift is a regression (an eval or red-team run
                that measured worse than at certification, or a scheduled run that failed its gate),
                a risk-register change, an agent guardrail relaxation, a model, prompt or endpoint
                change, or an edit of the card — the same events the card&apos;s certification-drift
                banner names. A risk counts once an admin or a named risk acceptor has written it; one
                only a non-admin has registered shows as awaiting triage. Passing runs and grants are
                routine evidence, not drift. Off keeps drift purely informational.
              </div>
              <div className={v.faint}>{status.data?.note}</div>
              <div className={a.formRow}>
                {(
                  [
                    ["cards", status.data?.cards],
                    ["approved", status.data?.approved],
                    ["expiring", status.data?.expiring],
                    ["expired", status.data?.expired],
                    ["pending", status.data?.pending],
                    ["unsigned", status.data?.unsigned],
                  ] as Array<[string, number | undefined]>
                ).map(([label, n]) => (
                  <Field key={label} label={label}>
                    <Input readOnly value={n ?? 0} />
                  </Field>
                ))}
              </div>
            </div>
          </Card>

          {/* ---------------- expiring work ---------------- */}
          <Card title="Expiring and lapsed sign-offs">
            {(expiring.data?.items ?? []).length === 0 ? (
              <EmptyState
                title="Nothing lapsing"
                body="No risk acceptance expires inside the warn window. A lapse should reach this list as work long before it stops a dispatch."
              />
            ) : (
              <Table
                rows={expiring.data?.items ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "use", header: "Intended use", render: (r) => r.intendedUse ?? r.cardId },
                  {
                    key: "state",
                    header: "State",
                    render: (r) => (
                      <Badge tone={r.effectiveStatus === "expired" ? "danger" : "warn"}>
                        {r.effectiveStatus}
                      </Badge>
                    ),
                  },
                  { key: "until", header: "Valid until", render: (r) => (r.validUntil ? ago(r.validUntil) : "no expiry") },
                  { key: "days", header: "Days", render: (r) => r.daysUntilExpiry ?? "—" },
                ]}
              />
            )}
          </Card>

          {/* ---------------- author a card ---------------- */}
          <Card title="Author a model card">
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api.post("/v1/mrm/cards", {
                    agentId: newAgent,
                    intendedUse: newUse,
                    ...(newLimits ? { limitations: newLimits } : {}),
                    ...(newClaims ? { dataClaims: JSON.parse(newClaims) as Record<string, unknown> } : {}),
                    ...(newRefs
                      ? { standardRefs: newRefs.split(",").map((s) => s.trim()).filter(Boolean) }
                      : {}),
                  });
                  setNewUse("");
                  setNewLimits("");
                  setNewClaims("");
                  setNewRefs("");
                  await refreshAll();
                }, "Model card created — it enforces nothing until it carries an approved sign-off");
              }}
            >
              <div className={a.formRow}>
                <Field label="Agent">
                  <Select value={newAgent} onChange={(e) => setNewAgent(e.target.value)} required>
                    {optionEls(agentOpts(agents.data?.agents), "select an agent")}
                  </Select>
                </Field>
                <Field label="Intended use" grow>
                  <Input
                    value={newUse}
                    onChange={(e) => setNewUse(e.target.value)}
                    placeholder="summarize customer tickets"
                    required
                  />
                </Field>
              </div>
              <Field label="Known limitations">
                <Textarea
                  rows={2}
                  value={newLimits}
                  onChange={(e) => setNewLimits(e.target.value)}
                  placeholder="not for legal or medical advice; degrades on non-English input"
                />
              </Field>
              <div className={a.formRow}>
                <Field label="Provider data claims (JSON)" grow>
                  <Textarea
                    rows={2}
                    value={newClaims}
                    onChange={(e) => setNewClaims(e.target.value)}
                    placeholder='{"training":"vendor-stated; no customer data","retention":"30 days"}'
                  />
                </Field>
                <Field label="Standard refs (comma separated)" grow>
                  <Input
                    value={newRefs}
                    onChange={(e) => setNewRefs(e.target.value)}
                    placeholder="nist-ai-rmf:MEASURE-2.11, iso-42001:8.3"
                  />
                </Field>
              </div>
              <div className={v.faint}>
                Referencing a NIST AI RMF / ISO 42001 control id helps an auditor follow the mapping. It does
                not make this deployment, or its customer, certified against anything.
              </div>
              <div>
                <Button type="submit" disabled={!newAgent || !newUse}>
                  Create card
                </Button>
              </div>
            </form>
          </Card>

          {/* ---------------- the registry ---------------- */}
          <Card title="Model cards">
            {(cards.data?.cards ?? []).length === 0 ? (
              <EmptyState
                title="No model cards"
                body="An empty registry enforces nothing, whatever the toggle says. Cards are human work — the platform can require them and expire them, it cannot write them."
              />
            ) : (
              <Table
                rows={cards.data?.cards ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "subject", header: "Model", render: (r) => r.subjectName ?? r.agentId ?? r.customProviderId },
                  { key: "use", header: "Intended use", render: (r) => r.intendedUse },
                  {
                    key: "state",
                    header: "State",
                    render: (r) => <Badge tone={stateTone(r.state)}>{r.state}</Badge>,
                  },
                  {
                    key: "complete",
                    header: "Card",
                    render: (r) =>
                      r.completeness.complete ? (
                        <Badge tone="ok">complete</Badge>
                      ) : (
                        <Badge tone="warn" title={`missing: ${r.completeness.missing.join(", ")}`}>
                          missing {r.completeness.missing.length}
                        </Badge>
                      ),
                  },
                  { key: "evidence", header: "Evidence", render: (r) => r.evidence.length },
                  {
                    key: "expiry",
                    header: "Expires",
                    render: (r) => (r.daysUntilExpiry === null ? "—" : `${r.daysUntilExpiry}d`),
                  },
                  {
                    key: "open",
                    header: "",
                    render: (r) => (
                      <Button variant="ghost" onClick={() => setOpenCard(r.id === openCard ? null : r.id)}>
                        {r.id === openCard ? "Close" : "Open"}
                      </Button>
                    ),
                  },
                  {
                    key: "actions",
                    header: "",
                    align: "right",
                    render: (r) => (
                      <RemoveButton
                        what={`the model card for ${r.subjectName ?? r.agentId ?? "this model"}`}
                        // A card in force is the thing MRM enforcement stands on:
                        // deleting it is not tidying, it is withdrawing a control.
                        // Say which one, rather than letting it read like removing
                        // a row from a list.
                        consequence={
                          <p>
                            The card and its evidence are deleted. If MRM enforcement is on, this
                            model then has <strong>no risk position at all</strong> — which is not
                            the same as a lapsed one: a lapsed card refuses dispatch, and a missing
                            card is judged by whatever the enforcement toggle says about models
                            without cards. The sign-off history goes with it. Retiring a model is
                            usually what is wanted instead; delete when the card was created in
                            error.
                          </p>
                        }
                        onRemove={() => api.del(`/v1/mrm/cards/${r.id}`)}
                        onDone={() => {
                          if (openCard === r.id) setOpenCard(null);
                          void cards.refetch();
                        }}
                      />
                    ),
                  },
                ]}
              />
            )}
          </Card>

          {/* ---------------- one card ---------------- */}
          {detail && (
            <Card title={`${detail.subjectName ?? "model"} — ${detail.intendedUse}`}>
              <div className={v.stack}>
                <div>
                  <Badge tone={stateTone(detail.state)}>{detail.state}</Badge>{" "}
                  <span className={v.faint}>
                    {detail.completeness.complete
                      ? "every section of this card is authored and evidenced"
                      : `missing: ${detail.completeness.missing.join(", ")}`}
                  </span>
                </div>

                {/* ADR-0086 — staleness first: a certified card whose world
                    moved says so before anything else on the card */}
                {staleness?.drifted && (
                  <div>
                    <Badge tone="warn">certification drift</Badge>{" "}
                    <strong>{staleness.summary}</strong>
                    <div className={v.faint}>{staleness.note}</div>
                  </div>
                )}
                {staleness?.pendingTriage && (
                  <div>
                    <Badge tone="info">awaiting triage</Badge>{" "}
                    <span>{staleness.pendingTriage}</span>
                  </div>
                )}

                {/* ADR-0086 — the computed block. Everything below this label
                    is a query over the ledgers, never something an author
                    typed, and it is rendered APART from the manually attached
                    evidence further down. */}
                {autofill && (
                  <div className={v.stack}>
                    <div>
                      <Badge tone="info">Computed from ledgers at read time</Badge>{" "}
                      <span className={v.faint}>
                        window: last {autofill.window.days} days · nothing here is stored on the card
                        or editable by its author
                      </span>
                    </div>
                    <div>
                      <strong>Evaluations:</strong> {autofill.sections.evals.runsEver} run
                      {autofill.sections.evals.runsEver === 1 ? "" : "s"} recorded (
                      {autofill.sections.evals.runsInWindow} in window)
                      {autofill.sections.evals.latestRun?.passRate != null &&
                        ` · latest pass rate ${Math.round(autofill.sections.evals.latestRun.passRate * 100)}%`}
                      {autofill.sections.evals.note && (
                        <span className={v.faint}> — {autofill.sections.evals.note}</span>
                      )}
                    </div>
                    <div>
                      <strong>Groundedness (ADR-0067):</strong>{" "}
                      {autofill.sections.evals.groundedness.latestRun
                        ? `latest ${autofill.sections.evals.groundedness.latestRun.scorerKind}` +
                          (autofill.sections.evals.groundedness.latestRun.passRate != null
                            ? ` pass rate ${Math.round(autofill.sections.evals.groundedness.latestRun.passRate * 100)}%`
                            : "")
                        : (autofill.sections.evals.groundedness.note ?? "unmeasured")}
                    </div>
                    <div>
                      <strong>Red team (ADR-0068):</strong>{" "}
                      {autofill.sections.redteam.measured && autofill.sections.redteam.latestRun ? (
                        <>
                          latest ASR{" "}
                          {autofill.sections.redteam.latestRun.asr != null
                            ? `${(autofill.sections.redteam.latestRun.asr * 100).toFixed(1)}%`
                            : "—"}{" "}
                          (95% CI{" "}
                          {autofill.sections.redteam.latestRun.asrLower != null
                            ? `${(autofill.sections.redteam.latestRun.asrLower * 100).toFixed(1)}%`
                            : "—"}
                          –
                          {autofill.sections.redteam.latestRun.asrUpper != null
                            ? `${(autofill.sections.redteam.latestRun.asrUpper * 100).toFixed(1)}%`
                            : "—"}
                          , n={autofill.sections.redteam.latestRun.asrTrials},{" "}
                          {autofill.sections.redteam.latestRun.measurementQuality ?? "unlabelled"})
                        </>
                      ) : (
                        <span>{autofill.sections.redteam.note}</span>
                      )}
                    </div>
                    <div>
                      <strong>Guardrails in force (ADR-0042):</strong>{" "}
                      {autofill.sections.guardrails.orgDefault
                        ? `org default ${modeSummary(autofill.sections.guardrails.orgDefault.modes)}`
                        : "no org default configured"}
                      {autofill.sections.guardrails.agentOverrides.length > 0 &&
                        ` · agent override ${autofill.sections.guardrails.agentOverrides
                          .map((o) => modeSummary(o.modes))
                          .join(" · ")}`}
                    </div>
                    <div>
                      <strong>Usage:</strong> {autofill.sections.usage.dispatchesInWindow} governed
                      dispatch{autofill.sections.usage.dispatchesInWindow === 1 ? "" : "es"} in window ·
                      ${autofill.sections.usage.costUsdInWindow.toFixed(4)}
                      {autofill.sections.usage.lastDispatchAt &&
                        ` · last ${ago(autofill.sections.usage.lastDispatchAt)}`}
                    </div>
                    <div>
                      <strong>Entitlement standing:</strong>{" "}
                      {autofill.sections.grants.effectiveHolders} user
                      {autofill.sections.grants.effectiveHolders === 1 ? "" : "s"} may invoke this
                      subject
                      {autofill.sections.grants.grantingRoles.length > 0 &&
                        ` (roles: ${autofill.sections.grants.grantingRoles.join(", ")})`}
                    </div>
                    <div>
                      <strong>Drift standing (ADR-0044 §5):</strong>{" "}
                      {autofill.sections.drift.baselinesPinned > 0
                        ? `${autofill.sections.drift.baselinesPinned} baseline(s) pinned · ${autofill.sections.drift.regressionsInWindow} regression(s) in window`
                        : (autofill.sections.drift.note ?? "no baseline pinned")}
                    </div>
                    <div>
                      <strong>Linked governance objects:</strong>{" "}
                      {autofill.sections.links.useCases.length} use case(s) ·{" "}
                      {autofill.sections.links.risks.length} risk(s) ·{" "}
                      {autofill.sections.links.vendors.length} vendor(s)
                    </div>
                    <div className={v.faint}>{autofill.note}</div>
                  </div>
                )}

                <div className={v.faint}>
                  <strong>Bias / fairness:</strong> {detail.completeness.bias.declared} declared,{" "}
                  {detail.completeness.bias.assessed} assessed, {detail.completeness.bias.waived} waived,{" "}
                  {detail.completeness.bias.unevidenced} without evidence.
                </div>
                <div className={v.faint}>{detail.completeness.bias.disclaimer}</div>

                {detail.biasFairness.length > 0 && (
                  <Table
                    rows={detail.biasFairness}
                    rowKey={(r) => `${r.dimension}:${r.method}`}
                    columns={[
                      { key: "d", header: "Dimension", render: (r) => r.dimension },
                      { key: "m", header: "Method", render: (r) => r.method },
                      { key: "s", header: "Status", render: (r) => <Badge tone={r.status === "assessed" ? "ok" : r.status === "waived" ? "neutral" : "warn"}>{r.status}</Badge> },
                      { key: "r", header: "Evidence ref", render: (r) => r.resultRef ?? "—" },
                      { key: "by", header: "By", render: (r) => r.assessedBy ?? "—" },
                    ]}
                  />
                )}

                {/* sign-off request — the DECISION is not here */}
                <form
                  className={a.formRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post(`/v1/mrm/cards/${detail.id}/sign-off`, {
                        approverUserId: approver,
                        validUntil: new Date(validUntil).toISOString(),
                      });
                      setValidUntil("");
                      await refreshAll();
                    }, "Sign-off requested — decide it in the Approvals Queue");
                  }}
                >
                  <Field label="Request sign-off from">
                    <Select value={approver} onChange={(e) => setApprover(e.target.value)} required>
                      {optionEls(userOpts(users.data?.users), "select an approver")}
                    </Select>
                  </Field>
                  <Field label="Recertify by">
                    <Input
                      type="date"
                      value={validUntil}
                      onChange={(e) => setValidUntil(e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="&nbsp;">
                    <Button type="submit" disabled={!approver || !validUntil}>
                      Request
                    </Button>
                  </Field>
                </form>
                <div className={v.faint}>
                  The request lands in the one <Link to="/admin/approvals" style={{ textDecoration: "underline" }}>Approvals Queue</Link>. There is no
                  approve button on this page, deliberately — one inbox, one decision path, one audit trail.
                </div>

                <Table
                  rows={detail.approvals}
                  rowKey={(r) => r.id}
                  columns={[
                    {
                      key: "s",
                      header: "Status",
                      render: (r) => (
                        <Badge
                          tone={
                            r.effectiveStatus === "approved"
                              ? "ok"
                              : r.effectiveStatus === "pending"
                                ? "info"
                                : "danger"
                          }
                          title={
                            r.effectiveStatus !== r.status
                              ? `stored status '${r.status}' is stale — this record has lapsed and is enforced as expired`
                              : undefined
                          }
                        >
                          {r.effectiveStatus}
                        </Badge>
                      ),
                    },
                    { key: "until", header: "Valid until", render: (r) => (r.validUntil ? ago(r.validUntil) : "no expiry") },
                    { key: "req", header: "Requested", render: (r) => ago(r.requestedAt) },
                    { key: "dec", header: "Decided", render: (r) => (r.decidedAt ? ago(r.decidedAt) : "—") },
                    { key: "why", header: "Reason", render: (r) => r.decisionReason ?? "—" },
                    { key: "sup", header: "Supersedes", render: (r) => (r.supersedesId ? "yes" : "—") },
                  ]}
                />

                {detail.approvals.some((r) => r.effectiveStatus === "approved") && (
                  <div>
                    <Button
                      variant="danger"
                      onClick={() =>
                        void act.run(async () => {
                          await api.post(`/v1/mrm/cards/${detail.id}/revoke`, {
                            reason: "revoked from the model risk registry",
                          });
                          await refreshAll();
                        }, "Risk acceptance revoked")
                      }
                    >
                      Revoke acceptance
                    </Button>
                  </div>
                )}

                {/* evidence — the MANUAL half, deliberately labelled apart
                    from the computed block above (ADR-0086: the two never
                    blend) */}
                <div>
                  <Badge tone="neutral">Attached evidence (manual)</Badge>{" "}
                  <span className={v.faint}>
                    what a human chose to cite — separate from, and never summed into, the computed
                    block above
                  </span>
                </div>
                <form
                  className={a.formRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post(`/v1/mrm/cards/${detail.id}/evidence`, {
                        kind: "eval_run",
                        evalRunId: evidenceRun,
                      });
                      setEvidenceRun("");
                      await refreshAll();
                    }, "Eval run attached as evidence");
                  }}
                >
                  <Field label="Attach an evaluation run (ADR-0044) as evidence" grow>
                    <Input
                      value={evidenceRun}
                      onChange={(e) => setEvidenceRun(e.target.value)}
                      placeholder="eval run id from /admin/evals"
                    />
                  </Field>
                  <Field label="&nbsp;">
                    <Button type="submit" disabled={!evidenceRun}>
                      Attach
                    </Button>
                  </Field>
                </form>
                <form
                  className={a.formRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post(`/v1/mrm/cards/${detail.id}/evidence`, {
                        kind: "engine_scan",
                        artifactScanId: evidenceScan.trim(),
                      });
                      setEvidenceScan("");
                      await refreshAll();
                    }, "Model-artifact scan attached as evidence");
                  }}
                >
                  <Field label="Attach a model-artifact scan as evidence" grow>
                    <Input
                      value={evidenceScan}
                      onChange={(e) => setEvidenceScan(e.target.value)}
                      placeholder="scan id from Admission review → Model artifacts"
                    />
                  </Field>
                  <Field label="&nbsp;">
                    <Button type="submit" disabled={!evidenceScan.trim()}>
                      Attach scan
                    </Button>
                  </Field>
                </form>
                {detail.evidence.length > 0 && (
                  <Table
                    rows={detail.evidence}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: "k", header: "Kind", render: (r) => r.kind },
                      {
                        key: "ref",
                        header: "Reference",
                        render: (r) =>
                          r.kind === "engine_scan" ? <EngineScanEvidenceChip scan={r.artifactScan} /> : (r.evalRunId ?? r.externalRef),
                      },
                      { key: "l", header: "Label", render: (r) => r.label ?? "—" },
                      { key: "at", header: "Attached", render: (r) => ago(r.attachedAt) },
                      {
                        key: "actions",
                        header: "",
                        align: "right",
                        render: (r) => (
                          <RemoveButton
                            what={`this ${r.kind} evidence`}
                            label="Detach"
                            consequence={
                              <p>
                                The citation is removed from this card. The {r.kind === "engine_scan" ? "scan" : "evaluation run"} itself is
                                untouched — this detaches the reference, it does not delete the
                                evidence. If the card's completeness depended on it, the card
                                becomes incomplete again, which is the honest result: a card is
                                complete only while something actually backs it.
                              </p>
                            }
                            onRemove={() => api.del(`/v1/mrm/cards/${detail.id}/evidence/${r.id}`)}
                            onDone={() => void refreshAll()}
                          />
                        ),
                      },
                    ]}
                  />
                )}
                <div className={v.faint}>
                  A high evaluation score is an input to a risk decision, never a substitute for one — a model
                  can score well and still be unapproved for a use that touches regulated data.
                </div>
              </div>
            </Card>
          )}
        </QueryGate>
      </div>
    </>
  );
}
