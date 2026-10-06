/**
 * ADR-0182 (ADR-0175 batch D4) A11 — Decision regression. OWNER: A11 (D4).
 *
 * A change to what produces intake decisions (the review policy, the required
 * AI tests, the intake template) is previewed against the golden set before
 * it goes live: the shipped cases plus every reviewer override. This page
 * lists the runs with a side-by-side view of each case whose outcome a change
 * alters, the golden cases (add one from a use case, retire a reviewer one),
 * and — for admins — the two settings of the activation gate.
 *
 * `PreviewImpactModal` and `RegressionDiff` are exported for the "Preview
 * impact" step of the review policy page and the required-tests editor.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, Select, Table, Tabs, Textarea } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import rec from "./record.module.css";
import { shortDate } from "./useCaseLifecycle";

// ---------------------------------------------------------------------------
// The API shapes (packages/shared/src/decision-regression.ts)
// ---------------------------------------------------------------------------

export type RegressionSubject = "review_policy" | "required_tests" | "intake_template";
export type OutcomeField = "tier" | "reasons" | "frameworks" | "requiredRoles" | "requiredTests" | "suggestedControls" | "approverRouting";
export interface DecisionOutcome {
  tier: string | null;
  reasons: string[];
  frameworks: string[];
  requiredRoles: string[];
  requiredTests: string[];
  suggestedControls: string[];
  approverRouting: string | null;
}
export interface RegressionEntry {
  caseId: string;
  label: string;
  source: "shipped" | "override";
  changed: OutcomeField[];
  before: DecisionOutcome | null;
  after: DecisionOutcome;
  reasonsDiff: Array<{ value: string; added: boolean; removed: boolean }>;
}
export interface RegressionRun {
  id: string;
  trigger: "ci" | "preview" | "activation";
  subject: RegressionSubject;
  candidateDigest: string;
  baselineDigest: string | null;
  cases: number;
  changed: number;
  entries: RegressionEntry[];
  createdAt: string;
  createdByName: string | null;
  expiresAt: string | null;
}
interface RegressionCase {
  id: string;
  source: "shipped" | "override";
  label: string;
  expected: Partial<DecisionOutcome> | null;
  fromUseCaseId: string | null;
  createdAt: string | null;
  createdByName: string | null;
  outcome: DecisionOutcome;
  unmetExpectation: OutcomeField[];
}
/** what an activation write carries besides its body */
export interface RegressionAcceptance {
  regressionRunId: string;
  acceptChangedOutcomes?: boolean;
  acceptReason?: string;
}

export const PREVIEW_PATH = "/v1/governance/decision-regression/preview";
const RUNS_KEY = ["decision-regression", "runs"] as const;
const CASES_KEY = ["decision-regression", "cases"] as const;

export const SUBJECT_LABEL: Record<RegressionSubject, string> = {
  review_policy: "Review policy",
  required_tests: "Required AI tests",
  intake_template: "Intake template",
};
const TRIGGER_LABEL: Record<RegressionRun["trigger"], string> = { ci: "CI", preview: "Preview", activation: "Activation" };
export const FIELD_LABEL: Record<OutcomeField, string> = {
  tier: "Screening tier",
  reasons: "Screening reasons",
  frameworks: "Suggested frameworks",
  requiredRoles: "Required review roles",
  requiredTests: "Required AI tests",
  suggestedControls: "Suggested controls",
  approverRouting: "Sign-off routing",
};

const tierText = (t: string | null | undefined) => (t ? t[0]!.toUpperCase() + t.slice(1) : "Unscreened");
const MIN_REASON = 10;

function fieldValue(field: OutcomeField, o: DecisionOutcome | null): ReactNode {
  if (!o) return <span className={v.faint}>none</span>;
  const val = o[field];
  if (field === "tier") return tierText(val as string | null);
  if (val === null || val === undefined) return <span className={v.faint}>none</span>;
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className={v.faint}>none</span>;
    return (
      <ul style={{ margin: 0, paddingLeft: "1.1em" }}>
        {val.map((x) => (
          <li key={x} className={v.mono} style={{ fontSize: "var(--text-sm)" }}>
            {x}
          </li>
        ))}
      </ul>
    );
  }
  return String(val);
}

/** the reasons' line diff: removed then added lines, marked in words too */
function ReasonsDiff(props: { parts: RegressionEntry["reasonsDiff"] }) {
  const changed = props.parts.filter((p) => p.added || p.removed);
  if (changed.length === 0) return null;
  return (
    <ul aria-label="Changed screening reasons" style={{ margin: "var(--s1) 0 0", padding: 0, listStyle: "none", display: "grid", gap: 2 }}>
      {changed.map((p, i) => (
        <li
          key={`${i}-${p.value}`}
          className={v.mono}
          style={{
            fontSize: "var(--text-sm)",
            padding: "2px 8px",
            borderRadius: "var(--rg-r-sm)",
            background: p.added ? "var(--ok-soft)" : "var(--danger-soft)",
            color: p.added ? "var(--ok-soft-text)" : "var(--danger-soft-text)",
          }}
        >
          {p.added ? "+ added: " : "− removed: "}
          {p.value}
        </li>
      ))}
    </ul>
  );
}

/** every case whose outcome the change alters: before and after, side by side */
export function RegressionDiff(props: { entries: RegressionEntry[] }) {
  if (props.entries.length === 0) {
    return <p className={v.dim} style={{ margin: 0 }}>No golden case changes its outcome.</p>;
  }
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: "var(--s2)" }}>
      {props.entries.map((e) => (
        <li
          key={e.caseId}
          aria-label={`Changed case: ${e.label}`}
          style={{ border: "1px solid var(--rg-line)", borderRadius: "var(--rg-r-md)", padding: "var(--s2)", background: "var(--rg-surface)" }}
        >
          <div className={v.row} style={{ marginBottom: "var(--s1)", flexWrap: "wrap" }}>
            <strong>{e.label}</strong>
            <Badge tone={e.source === "override" ? "info" : "neutral"}>{e.source === "override" ? "Reviewer case" : "Shipped case"}</Badge>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-sm)" }}>
            <caption className={v.dim} style={{ textAlign: "left", paddingBottom: 4 }}>
              {e.changed.length} field{e.changed.length === 1 ? "" : "s"} change
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", width: "22%", padding: "4px 8px 4px 0" }}>Field</th>
                <th scope="col" style={{ textAlign: "left", padding: "4px 8px" }}>Before (live)</th>
                <th scope="col" style={{ textAlign: "left", padding: "4px 8px" }}>After (this change)</th>
              </tr>
            </thead>
            <tbody>
              {e.changed.map((f) => (
                <tr key={f} style={{ borderTop: "1px solid var(--rg-line)", verticalAlign: "top" }}>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 600, padding: "6px 8px 6px 0" }}>{FIELD_LABEL[f]}</th>
                  <td style={{ padding: "6px 8px" }}>{fieldValue(f, e.before)}</td>
                  <td style={{ padding: "6px 8px" }}>{fieldValue(f, e.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.changed.includes("reasons") ? <ReasonsDiff parts={e.reasonsDiff} /> : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The "Preview impact" step (review policy, required tests)
// ---------------------------------------------------------------------------

/**
 * Runs the golden set against `candidate`, shows what changes, and only then
 * lets the admin save it — with the run's id and, when outcomes change, their
 * acceptance and reason (the gateway refuses anything else under the strict
 * `decision_regression_gate`). A refusal at save (the preview went stale, or
 * someone else changed the setting meanwhile) is shown with "Preview again".
 */
export function PreviewImpactModal(props: {
  open: boolean;
  subject: RegressionSubject;
  candidate: unknown;
  /** "the review policy" */
  what: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: (acceptance: RegressionAcceptance) => Promise<void>;
}) {
  const [run, setRun] = useState<RegressionRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accept, setAccept] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    setSaveError(null);
    setRun(null);
    setAccept(false);
    setReason("");
    try {
      const r = await api.post<RegressionRun>(PREVIEW_PATH, { subject: props.subject, candidate: props.candidate });
      if (mine === seq.current) setRun(r);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (props.open) void load();
    else seq.current++;
    // the candidate is fixed while the dialog is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const needsAcceptance = (run?.changed ?? 0) > 0;
  const reasonOk = reason.trim().length >= MIN_REASON;
  const canSave = !!run && !saving && (!needsAcceptance || (accept && reasonOk));

  const save = async () => {
    if (!run) return;
    setSaving(true);
    setSaveError(null);
    try {
      await props.onSave({
        regressionRunId: run.id,
        ...(needsAcceptance ? { acceptChangedOutcomes: true, acceptReason: reason.trim() } : {}),
      });
    } catch (e) {
      const code = e instanceof ApiError ? String(e.payload.error ?? "") : "";
      setSaveError(
        code.startsWith("decision_regression_")
          ? `${e instanceof Error ? e.message : String(e)}`
          : `Not saved: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={props.open}
      wide
      title={`Preview impact: ${props.what}`}
      onClose={props.onCancel}
      actions={
        <>
          <Button onClick={props.onCancel}>Cancel</Button>
          {saveError || error ? (
            <Button onClick={() => void load()} disabled={loading}>
              Preview again
            </Button>
          ) : null}
          <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
            {saving ? "Saving…" : props.saveLabel}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.dim} style={{ margin: 0 }}>
          regulAIt replays every golden case (the shipped set and the reviewer cases) under the configuration live now
          and under this change. A case is listed when anything it decides changes: the tier, the suggestions, the
          required reviews or tests, or who signs off.
        </p>
        {loading ? <p role="status" style={{ margin: 0 }}>Running the golden cases…</p> : null}
        {error ? (
          <p role="alert" style={{ margin: 0, color: "var(--danger-soft-text)" }}>
            The preview did not run: {error}
          </p>
        ) : null}
        {run ? (
          <>
            <p role="status" style={{ margin: 0 }}>
              <strong>
                {run.changed} of {run.cases} golden case{run.cases === 1 ? "" : "s"} change{run.changed === 1 ? "s" : ""}
              </strong>{" "}
              <span className={v.dim}>(run taken {shortDate(run.createdAt)}{run.expiresAt ? `, usable until ${new Date(run.expiresAt).toLocaleTimeString()}` : ""})</span>
            </p>
            <RegressionDiff entries={run.entries} />
            {needsAcceptance ? (
              <div className={v.stackTight}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                  <span>I have reviewed these changed outcomes and accept them for {props.what}.</span>
                </label>
                <Field
                  label="Why these outcomes should change"
                  error={accept && reason.length > 0 && !reasonOk ? `Write at least ${MIN_REASON} characters.` : null}
                >
                  <Textarea value={reason} rows={3} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <p className={v.dim} style={{ margin: 0 }}>
                  At least {MIN_REASON} characters. Recorded in the audit log with the run.
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        {saveError ? (
          <p role="alert" style={{ margin: 0, color: "var(--danger-soft-text)" }}>
            {saveError}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function DecisionRegressionPage() {
  const [tab, setTab] = useState<"runs" | "cases" | "settings">("runs");
  return (
    <>
      <PageHeader
        title="Decision regression"
        sub="Golden cases, regression runs and the outcomes a policy change would alter."
        info={
          <p>
            Before a change to the review policy, the required AI tests or the intake template goes live, regulAIt replays
            the golden cases under it and shows every case whose outcome changes. Every use-case decision records the
            versions that produced it, on the use case&apos;s Decision records tab.
          </p>
        }
      />
      <div className={v.stack}>
        <Tabs
          tabs={[
            { id: "runs", label: "Runs" },
            { id: "cases", label: "Golden cases" },
            { id: "settings", label: "Settings" },
          ]}
          active={tab}
          onChange={(id) => setTab(id as typeof tab)}
        />
        {tab === "runs" ? <RunsSection /> : tab === "cases" ? <CasesSection /> : <SettingsSection />}
      </div>
    </>
  );
}

function RunsSection() {
  const runs = useQuery({ queryKey: RUNS_KEY, queryFn: () => api.get<{ runs: RegressionRun[] }>("/v1/governance/decision-regression/runs") });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: [...RUNS_KEY, openId],
    queryFn: () => api.get<RegressionRun>(`/v1/governance/decision-regression/runs/${openId}`),
    enabled: !!openId,
  });
  return (
    <>
      <Card title="Regression runs">
        <Table
          rows={runs.data?.runs}
          loading={runs.isLoading}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenId(r.id)}
          rowLabel={(r) => `Open the ${TRIGGER_LABEL[r.trigger].toLowerCase()} run of ${SUBJECT_LABEL[r.subject].toLowerCase()} from ${shortDate(r.createdAt)}`}
          empty={<EmptyState title="No runs yet" body="A run is recorded each time a change is previewed or activated." />}
          columns={[
            { key: "at", header: "When", render: (r) => shortDate(r.createdAt), sort: (r) => r.createdAt },
            { key: "subject", header: "Change to", render: (r) => SUBJECT_LABEL[r.subject] },
            { key: "trigger", header: "Run", render: (r) => <Badge tone={r.trigger === "activation" ? "primary" : "neutral"}>{TRIGGER_LABEL[r.trigger]}</Badge> },
            {
              key: "changed",
              header: "Changed outcomes",
              render: (r) => <Badge tone={r.changed > 0 ? "warn" : "ok"}>{`${r.changed} of ${r.cases}`}</Badge>,
              sort: (r) => r.changed,
            },
            { key: "by", header: "By", render: (r) => r.createdByName ?? <span className={v.faint}>system</span> },
          ]}
        />
      </Card>
      {openId ? (
        <Card
          title={detail.data ? `${TRIGGER_LABEL[detail.data.trigger]} of ${SUBJECT_LABEL[detail.data.subject].toLowerCase()}, ${shortDate(detail.data.createdAt)}` : "Run"}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setOpenId(null)}>
              Close
            </Button>
          }
        >
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {detail.data ? (
              <div className={v.stack}>
                <p className={v.dim} style={{ margin: 0 }}>
                  {detail.data.changed} of {detail.data.cases} golden cases change. Body digest{" "}
                  <code>{detail.data.candidateDigest.slice(0, 12)}</code>
                  {detail.data.baselineDigest ? (
                    <>
                      , compared with the live configuration <code>{detail.data.baselineDigest.slice(0, 12)}</code>
                    </>
                  ) : null}
                  .
                </p>
                <RegressionDiff entries={detail.data.entries} />
              </div>
            ) : null}
          </QueryGate>
        </Card>
      ) : null}
    </>
  );
}

const EXPECTED_TIERS = [
  { v: "prohibited", l: "Prohibited" },
  { v: "high", l: "High" },
  { v: "limited", l: "Limited" },
  { v: "minimal", l: "Minimal" },
  { v: "unscreened", l: "Unscreened (no valid answers)" },
];

function CasesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cases = useQuery({ queryKey: CASES_KEY, queryFn: () => api.get<{ cases: RegressionCase[] }>("/v1/governance/decision-regression/cases") });
  const useCases = useQuery({
    queryKey: ["use-cases", "for-regression"],
    queryFn: () => api.get<{ useCases?: Array<{ id: string; name: string; euAiActTier?: string | null }> }>("/v1/use-cases"),
  });
  const [ucId, setUcId] = useState("");
  const [label, setLabel] = useState("");
  const [tier, setTier] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<RegressionCase | null>(null);

  const add = async () => {
    if (!ucId || !label.trim() || !tier) {
      setAddError("Choose a use case, name the case and choose the tier it must keep.");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await api.post("/v1/governance/decision-regression/cases", {
        fromUseCaseId: ucId,
        label: label.trim(),
        expected: { tier: tier === "unscreened" ? null : tier },
      });
      toast("Case added to the golden set", "success");
      setUcId("");
      setLabel("");
      setTier("");
      await queryClient.invalidateQueries({ queryKey: CASES_KEY });
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const retire = async (c: RegressionCase) => {
    try {
      await api.del(`/v1/governance/decision-regression/cases/${c.id}`);
      toast("Case retired", "success");
      await queryClient.invalidateQueries({ queryKey: CASES_KEY });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRetiring(null);
    }
  };

  return (
    <>
      <Card title="Golden cases">
        <p className={v.dim} style={{ marginTop: 0 }}>
          Shipped cases come with regulAIt and change only with its code. A reviewer case replays the answers of a real use
          case and pins the outcome a reviewer decided it must keep.
        </p>
        <Table
          rows={cases.data?.cases}
          loading={cases.isLoading}
          error={cases.error}
          onRetry={() => void cases.refetch()}
          rowKey={(c) => c.id}
          empty={<EmptyState title="No cases" body="The shipped golden set could not be read." />}
          columns={[
            { key: "label", header: "Case", render: (c) => c.label, sort: (c) => c.label },
            { key: "source", header: "Source", render: (c) => <Badge tone={c.source === "override" ? "info" : "neutral"}>{c.source === "override" ? "Reviewer" : "Shipped"}</Badge> },
            { key: "tier", header: "Tier now", render: (c) => tierText(c.outcome.tier) },
            {
              key: "expect",
              header: "Expectation",
              render: (c) =>
                c.unmetExpectation.length === 0 ? (
                  <Badge tone="ok">Kept</Badge>
                ) : (
                  <Badge tone="warn">{`Differs: ${c.unmetExpectation.map((f) => FIELD_LABEL[f].toLowerCase()).join(", ")}`}</Badge>
                ),
            },
            {
              key: "act",
              header: <span className={rec.srOnly}>Actions</span>,
              render: (c) =>
                c.source === "override" ? (
                  <Button size="sm" variant="ghost" aria-label={`Retire case ${c.label}`} onClick={() => setRetiring(c)}>
                    Retire
                  </Button>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card title="Add a reviewer case from a use case">
        <form
          className={v.stack}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <p className={v.dim} style={{ margin: 0 }}>
            When a reviewer overrides an outcome, keep it: the use case&apos;s stored answers become a case, and every later
            preview shows whether a change would decide it differently.
          </p>
          <Field label="Use case">
            <Select value={ucId} onChange={(e) => setUcId(e.target.value)}>
              <option value="">Choose a use case…</option>
              {(useCases.data?.useCases ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Case name">
            <Input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} placeholder="Credit pre-check stays high" />
          </Field>
          <Field label="Tier it must keep">
            <Select value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="">Choose a tier…</option>
              {EXPECTED_TIERS.map((t) => (
                <option key={t.v} value={t.v}>
                  {t.l}
                </option>
              ))}
            </Select>
          </Field>
          {addError ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger-soft-text)" }}>
              {addError}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" disabled={adding}>
              {adding ? "Adding…" : "Add case"}
            </Button>
          </div>
        </form>
      </Card>
      <ConfirmModal
        open={!!retiring}
        title="Retire this case?"
        body={retiring ? <p style={{ margin: 0 }}>Previews will no longer replay “{retiring.label}”. The record of the case and the runs that included it are kept.</p> : null}
        confirmLabel="Retire case"
        danger
        onConfirm={() => retiring && void retire(retiring)}
        onCancel={() => setRetiring(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings (admin): the activation gate's two settings
// ---------------------------------------------------------------------------

/** packages/shared/src/accountability.ts ACCOUNTABILITY_SETTING_COPY (the web
 * does not import the shared package; the wording is kept in step by review) */
const GATE_COPY = {
  label: "Decision regression gate",
  strict:
    "Enforce: a change to the review policy, the required tests or an intake template is refused unless a regression run of the same body, newer than the maximum age, was previewed, and any changed outcomes were accepted with a reason.",
  relaxed:
    "Warn records the missing or stale preview and saves anyway; off skips the check and says so. Either way a change can alter past decisions' outcomes without anyone having looked.",
};
const AGE_COPY = {
  label: "Regression preview maximum age (minutes)",
  strict: "60 minutes: a preview older than an hour no longer admits the change it previewed.",
  relaxed: "A longer window (up to 1440) admits a preview taken before other changes landed.",
};
const STRICT_GATE = "enforce";
const STRICT_AGE = 60;

function SettingsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery({
    queryKey: ["org-settings"],
    queryFn: () => api.get<{ settings: { decisionRegressionGate?: string; decisionRegressionMaxAgeMinutes?: number } }>("/v1/org/settings"),
  });
  const live = q.data?.settings;
  const [mode, setMode] = useState<string | null>(null);
  const [age, setAge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const curMode = mode ?? live?.decisionRegressionGate ?? STRICT_GATE;
  const curAge = age ?? String(live?.decisionRegressionMaxAgeMinutes ?? STRICT_AGE);
  const ageN = Number(curAge);
  const ageValid = Number.isInteger(ageN) && ageN >= 1 && ageN <= 1440;
  const relaxed = curMode !== STRICT_GATE || (ageValid && ageN > STRICT_AGE);
  const dirty = curMode !== (live?.decisionRegressionGate ?? STRICT_GATE) || (ageValid && ageN !== (live?.decisionRegressionMaxAgeMinutes ?? STRICT_AGE));

  const save = async () => {
    if (!ageValid) {
      setError("The maximum age is a whole number of minutes from 1 to 1440.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put("/v1/org/settings", { decisionRegressionGate: curMode, decisionRegressionMaxAgeMinutes: ageN });
      toast("Decision regression settings saved", "success");
      setMode(null);
      setAge(null);
      await queryClient.invalidateQueries({ queryKey: ["org-settings"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Settings">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <form
          className={v.stack}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={GATE_COPY.label}>
            <Select value={curMode} onChange={(e) => setMode(e.target.value)}>
              <option value="enforce">Enforce (strict default)</option>
              <option value="warn">Warn</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          <p className={v.dim} style={{ margin: 0 }}>{GATE_COPY.strict}</p>
          <Field label={AGE_COPY.label} error={!ageValid ? "From 1 to 1440 minutes." : null}>
            <Input inputMode="numeric" value={curAge} onChange={(e) => setAge(e.target.value)} aria-invalid={!ageValid ? true : undefined} />
          </Field>
          <p className={v.dim} style={{ margin: 0 }}>{AGE_COPY.strict}</p>
          <div className={v.row} style={{ flexWrap: "wrap" }}>
            {relaxed ? <Badge tone="warn">Relaxed</Badge> : <Badge tone="ok">Strict default</Badge>}
            <span className={v.dim}>A change to either setting is audited, with its old and new value.</span>
          </div>
          {relaxed ? (
            <p style={{ margin: 0 }} className={v.dim}>
              {curMode !== STRICT_GATE ? GATE_COPY.relaxed : AGE_COPY.relaxed}
            </p>
          ) : null}
          {error ? (
            <p role="alert" style={{ margin: 0, color: "var(--danger-soft-text)" }}>
              {error}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="primary" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      </QueryGate>
    </Card>
  );
}
