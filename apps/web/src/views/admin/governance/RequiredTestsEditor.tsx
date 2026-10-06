/**
 * ADR-0180 A3 — the required AI test classes per risk tier, on the review
 * policy page. Its own route and its own save
 * (`PUT /v1/governance/review-policy/required-tests`, admin, audited), because
 * the policy PUT above rebuilds `tiers` and must never drop this setting.
 *
 * Secure by default: a tier the policy leaves out uses the strict default in
 * code, and the card says so. An admin may relax a tier (the change is
 * audited). An OWASP id that no red-team class or eval scorer can measure is
 * offered disabled, with the reason, because the gateway refuses it.
 *
 * ADR-0182 A11: saving is a "Preview impact" step first (the golden cases
 * replayed under the draft); the save carries the run's id and any accepted
 * changes, as the gateway's decision-regression gate requires.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import { Badge, Button, Card, Field, Input, Select } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate } from "../adminKit";
import { shortDate } from "./useCaseLifecycle";
import { TIERS } from "./reviewPolicy";
import p from "./reviewPolicy.module.css";
import { PreviewImpactModal, type RegressionAcceptance } from "./DecisionRegressionPage";

type Tier = (typeof TIERS)[number]["id"];

interface TestClassInfo {
  id: string;
  name: string;
  list: "owasp-llm-top-10" | "owasp-agentic-top-10";
  redteamClasses: string[];
  scorerKinds: string[];
  measurable: boolean;
}
interface RequiredClass {
  testClass: string;
  maxAsr?: number;
  minScore?: number;
}
interface TierPolicy {
  classes: RequiredClass[];
  freshnessDays: number;
}
export interface RequiredTestsView {
  policy: Partial<Record<Tier, TierPolicy>>;
  effective: Record<Tier, { source: "policy" | "default"; freshnessDays: number; classes: Array<RequiredClass & { name: string; maxAsr: number | null; minScore: number | null }> }>;
  defaults: Record<Tier, TierPolicy>;
  defaultsNote: string;
  freshness: { defaultDays: number; maxDays: number };
  testClasses: TestClassInfo[];
  unmeasurableExplanation: string;
  updatedAt: string | null;
  updatedByName: string | null;
}

export const REQUIRED_TESTS_PATH = "/v1/governance/review-policy/required-tests";
const KEY = ["review-policy", "required-tests"] as const;

/** a short display form of an OWASP id: `owasp:llm:01` → `LLM01`, `owasp:agentic:asi02` → `ASI02` */
export function owaspShort(id: string): string {
  const m = /^owasp:(llm|agentic):(.+)$/.exec(id);
  if (!m) return id;
  return m[1] === "llm" ? `LLM${m[2]}` : m[2]!.toUpperCase();
}

interface RowDraft {
  testClass: string;
  /** the threshold as typed: percent for red-team classes, 0..1 for eval-only ones */
  threshold: string;
}
interface TierDraft {
  /** `default` = not in the stored policy (the strict code default applies) */
  source: "policy" | "default";
  rows: RowDraft[];
  freshness: string;
}
type Draft = Record<Tier, TierDraft>;

const byRedteam = (info: TestClassInfo | undefined) => (info?.redteamClasses.length ?? 0) > 0;

function draftFrom(view: RequiredTestsView): Draft {
  const out = {} as Draft;
  for (const t of TIERS) {
    const e = view.effective[t.id];
    out[t.id] = {
      source: e.source,
      rows: e.classes.map((c) => ({ testClass: c.testClass, threshold: String(c.maxAsr ?? c.minScore ?? "") })),
      freshness: String(e.freshnessDays),
    };
  }
  return out;
}

export function RequiredTestsEditor() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<RequiredTestsView>(REQUIRED_TESTS_PATH) });
  return (
    <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
      {q.data && q.data.effective && Array.isArray(q.data.testClasses) ? (
        <RequiredTestsForm key={q.data.updatedAt ?? "default"} view={q.data} />
      ) : q.data ? (
        <Card title="Required AI tests by tier">
          <p className={p.error} role="alert">The required AI tests could not be read from the gateway.</p>
        </Card>
      ) : null}
    </QueryGate>
  );
}

function RequiredTestsForm(props: { view: RequiredTestsView }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { view } = props;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [errors, setErrors] = useState<Partial<Record<Tier, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = new Map(view.testClasses.map((c) => [c.id, c]));
  const unmeasurable = view.testClasses.filter((c) => !c.measurable);

  /** any edit turns a default tier into a stored one, starting from what it showed */
  const edit = (tier: Tier, f: (t: TierDraft) => TierDraft) =>
    setDraft((d) => ({ ...d, [tier]: { ...f(d[tier]), source: "policy" } }));
  const resetTier = (tier: Tier) =>
    setDraft((d) => ({
      ...d,
      [tier]: {
        source: "default",
        rows: view.defaults[tier].classes.map((c) => ({ testClass: c.testClass, threshold: String(c.maxAsr ?? c.minScore ?? "") })),
        freshness: String(view.defaults[tier].freshnessDays),
      },
    }));

  const [candidate, setCandidate] = useState<Partial<Record<Tier, TierPolicy>> | null>(null);

  /** validate the draft, then open the "Preview impact" step with its body */
  const preview = () => {
    const found: Partial<Record<Tier, string>> = {};
    const body: Partial<Record<Tier, TierPolicy>> = {};
    for (const t of TIERS) {
      const td = draft[t.id];
      if (td.source === "default") continue;
      const days = Number(td.freshness);
      if (!Number.isInteger(days) || days < 1 || days > view.freshness.maxDays) {
        found[t.id] = `Freshness must be a whole number of days from 1 to ${view.freshness.maxDays}.`;
        continue;
      }
      const classes: RequiredClass[] = [];
      for (const r of td.rows) {
        const n = Number(r.threshold);
        const red = byRedteam(info.get(r.testClass));
        if (r.threshold.trim() === "" || !Number.isFinite(n) || n < 0 || n > (red ? 100 : 1)) {
          found[t.id] = red
            ? `${owaspShort(r.testClass)}: the attack success rate limit is a percentage from 0 to 100.`
            : `${owaspShort(r.testClass)}: the minimum score is a number from 0 to 1.`;
          break;
        }
        classes.push(red ? { testClass: r.testClass, maxAsr: n } : { testClass: r.testClass, minScore: n });
      }
      body[t.id] = { classes, freshnessDays: days };
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSubmitError(null);
    setCandidate(body);
  };

  /** the save itself, from the preview step. A field-level refusal (422)
   * closes the step and is shown on the card, as before. */
  const save = async (acceptance: RegressionAcceptance) => {
    if (!candidate) return;
    setBusy(true);
    try {
      await api.put(REQUIRED_TESTS_PATH, { ...candidate, ...acceptance });
      setCandidate(null);
      toast("Required AI tests saved", "success");
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setCandidate(null);
        setSubmitError(e.message);
        return;
      }
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); preview(); }}>
      <Card title="Required AI tests by tier">
        <p className={p.lead}>
          Before a use case may ship, every agent in its stack needs a completed red-team or eval run that measured each
          required OWASP test class, on the agent&apos;s current configuration, within the freshness limit, and within the
          threshold. The deploy gate checks this live.
        </p>
        <p className={p.lead}>{view.defaultsNote}</p>
        <ul className={p.tiers}>
          {TIERS.map((tier) => {
            const td = draft[tier.id];
            const used = new Set(td.rows.map((r) => r.testClass));
            const label = `${tier.label} tier`;
            return (
              <li key={tier.id} className={p.tier} aria-label={`Required AI tests, ${label.toLowerCase()}`}>
                <span className={p.tierName}>
                  {label}{" "}
                  {td.source === "default" ? <Badge tone="info">Strict default</Badge> : <Badge tone="warn">Set by policy</Badge>}
                  <span className={p.tierHint}>{tier.hint}</span>
                </span>
                <div className={p.people}>
                  {td.rows.length === 0 ? (
                    <span className={p.none}>No required tests. A use case of this tier ships without test evidence.</span>
                  ) : (
                    <ul className={p.roles}>
                      {td.rows.map((r, i) => {
                        const ci = info.get(r.testClass);
                        const red = byRedteam(ci);
                        return (
                          <li key={r.testClass} className={p.check} style={{ flexWrap: "wrap" }}>
                            <code>{owaspShort(r.testClass)}</code>
                            <span>{ci?.name ?? r.testClass}</span>
                            <Input
                              aria-label={`${label}: ${owaspShort(r.testClass)} ${red ? "maximum attack success rate (%)" : "minimum eval score (0 to 1)"}`}
                              inputMode="decimal"
                              style={{ width: 90 }}
                              value={r.threshold}
                              onChange={(e) => edit(tier.id, (t) => ({ ...t, rows: t.rows.map((x, j) => (j === i ? { ...x, threshold: e.target.value } : x)) }))}
                            />
                            <span className={p.tierHint}>{red ? "max attack success %" : "min score"}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Remove ${owaspShort(r.testClass)} from the ${label.toLowerCase()}`}
                              onClick={() => edit(tier.id, (t) => ({ ...t, rows: t.rows.filter((_, j) => j !== i) }))}
                            >
                              Remove
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <Select
                    aria-label={`Add a required test class to the ${label.toLowerCase()}`}
                    className={p.addPerson}
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      const ci = info.get(id);
                      if (!id || !ci?.measurable) return;
                      edit(tier.id, (t) => ({ ...t, rows: [...t.rows, { testClass: id, threshold: byRedteam(ci) ? "0" : "0.8" }] }));
                    }}
                  >
                    <option value="">Add a test class…</option>
                    {view.testClasses.map((c) => (
                      <option key={c.id} value={c.id} disabled={!c.measurable || used.has(c.id)}>
                        {owaspShort(c.id)} {c.name}
                        {!c.measurable ? " (cannot be measured)" : used.has(c.id) ? " (required)" : ""}
                      </option>
                    ))}
                  </Select>
                  {td.source === "policy" ? (
                    <div>
                      <Button size="sm" variant="ghost" onClick={() => resetTier(tier.id)}>
                        Reset {label.toLowerCase()} to the strict default
                      </Button>
                    </div>
                  ) : null}
                  {errors[tier.id] ? <p className={p.error} role="alert">{errors[tier.id]}</p> : null}
                </div>
                <Field label="Freshness (days)">
                  <Input
                    aria-label={`${label}: freshness in days (1 to ${view.freshness.maxDays})`}
                    inputMode="numeric"
                    value={td.freshness}
                    aria-invalid={errors[tier.id]?.startsWith("Freshness") ? true : undefined}
                    onChange={(e) => edit(tier.id, (t) => ({ ...t, freshness: e.target.value }))}
                  />
                </Field>
              </li>
            );
          })}
        </ul>
        <div className={p.people} style={{ marginTop: "var(--s2)" }}>
          <span className={p.peopleLabel}>Why some OWASP classes cannot be required</span>
          <p className={p.lead}>
            {unmeasurable.map((c) => `${owaspShort(c.id)} ${c.name}`).join(", ")}: {view.unmeasurableExplanation}
          </p>
        </div>
        <div className={p.footer}>
          <p className={p.footerNote}>
            {view.updatedAt ? `Last changed ${shortDate(view.updatedAt)}${view.updatedByName ? ` by ${view.updatedByName}` : ""}.` : "Not changed yet: every tier uses the strict default."}
          </p>
          {submitError ? <p className={p.error} role="alert">The required tests were not saved: {submitError}</p> : null}
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Preview impact"}</Button>
        </div>
      </Card>
      <PreviewImpactModal
        open={candidate !== null}
        subject="required_tests"
        candidate={candidate ?? {}}
        what="the required AI tests"
        saveLabel="Save required tests"
        onCancel={() => setCandidate(null)}
        onSave={save}
      />
    </form>
  );
}
