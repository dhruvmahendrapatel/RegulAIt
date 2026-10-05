/**
 * ADR-0180 §6 (A10) — a risk's residual position against the org's tolerance,
 * its time-boxed acceptance history, and the form that records a new one.
 *
 *  - Tolerance vs residual: the residual band, the tolerance that applies and
 *    where it came from (the strict default or a configured category/tier),
 *    and whether a valid acceptance covers it.
 *  - History: who accepted, when, until when, the compensating controls, and
 *    whether each record is live, superseded, expired or revoked. Nothing is
 *    overwritten; a new acceptance supersedes the live one.
 *  - The form: the expiry is capped by the residual band (6 months for high
 *    or critical, 12 otherwise), explained in plain words; empty = the cap.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt } from "../../../api/format";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type Band = "low" | "medium" | "high" | "critical";
type AcceptanceState = "live" | "superseded" | "expired" | "revoked";

interface AcceptanceRow {
  id: string;
  state: AcceptanceState;
  responseType: string;
  residualBand: Band;
  acceptedByUserId: string | null;
  acceptedByName: string | null;
  acceptedAt: string;
  expiresAt: string;
  rationale: string;
  compensatingControls: Array<{ controlRef: string | null; description: string }>;
  supersededAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
}
export interface AcceptanceHistory {
  riskId: string;
  position: {
    band: Band | null;
    tolerance: { band: string; source: "default" | "category" | "tier" };
    acceptance: { id: string; expiresAt: string } | null;
    aboveTolerance: boolean;
    maxAcceptanceMonths: number | null;
    maxExpiresAt: string | null;
  };
  canAccept: boolean;
  acceptRefusal: string | null;
  acceptances: AcceptanceRow[];
}

export const RESPONSE_TYPE_LABELS: Record<string, string> = {
  accept: "Accept the residual risk",
  mitigate_partially: "Partly mitigated; accept the rest",
  transfer: "Transferred (for example, insured or contracted out)",
  avoid_pending: "Accept until the activity is stopped",
};

const BAND_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const bandTone = (b: string | null): Tone =>
  b === "critical" || b === "high" ? "danger" : b === "medium" ? "warn" : b === "low" ? "ok" : "neutral";
const stateTone = (s: AcceptanceState): Tone =>
  s === "live" ? "ok" : s === "expired" ? "warn" : s === "revoked" ? "danger" : "neutral";
const sourceLabel = (s: "default" | "category" | "tier") =>
  s === "default" ? "strict default" : s === "category" ? "set for this category" : "set for this tier";

/** "in 5 months", "in 12 days", "expired 3 days ago" */
export function expiresIn(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return `expired ${ago(iso)}`;
  const days = Math.ceil(ms / 86_400_000);
  if (days < 45) return `in ${days} day${days === 1 ? "" : "s"}`;
  const months = Math.round(days / 30.44);
  return `in about ${months} month${months === 1 ? "" : "s"}`;
}

const REFUSAL_TEXT: Record<string, string> = {
  not_a_risk_acceptor: "Only an admin or a risk acceptor named in the review policy can accept residual risk.",
  proposer_cannot_accept_risk:
    "You own the use case this risk belongs to, so someone else must accept it (the acceptance has to be independent).",
  risk_terminal: "A closed risk has nothing left to accept.",
};

/** the plain-language limit for this band */
export function limitExplanation(band: Band | null, maxMonths: number | null, maxExpiresAt: string | null): string {
  if (!band || !maxMonths || !maxExpiresAt) return "";
  const date = maxExpiresAt.slice(0, 10);
  const why =
    band === "high" || band === "critical"
      ? `Because this risk's residual level is ${band}, an acceptance can last at most ${maxMonths} months`
      : `For ${band} residual risk an acceptance can last at most ${maxMonths} months`;
  return (
    `${why} (until ${date}). High or critical risk must be looked at again within 6 months; anything lower within ` +
    "12 months. Leave the date empty to use the maximum. When the acceptance expires, the risk reopens and needs a " +
    "new decision."
  );
}

export function RiskAcceptancePanel(props: { riskId: string; onChanged?: () => void }) {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "risk-acceptances", props.riskId],
    queryFn: () => api.get<AcceptanceHistory>(`/v1/risks/${props.riskId}/acceptances`),
  });
  const [responseType, setResponseType] = useState("accept");
  const [rationale, setRationale] = useState("");
  const [expiry, setExpiry] = useState("");
  const [controls, setControls] = useState<Array<{ controlRef: string; description: string }>>([]);
  const h = q.data;
  const p = h?.position;
  const maxDate = p?.maxExpiresAt ? p.maxExpiresAt.slice(0, 10) : undefined;
  const minDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const expiryError = expiry && maxDate && expiry > maxDate ? `The latest allowed date is ${maxDate}.` : null;

  const submit = () =>
    void act.run(async () => {
      // a picked day runs to the end of that day, but never past the cap
      let expiresAt: string | undefined;
      if (expiry) {
        const end = new Date(`${expiry}T23:59:59.000Z`);
        const cap = p?.maxExpiresAt ? new Date(p.maxExpiresAt) : null;
        expiresAt = (cap && end > cap ? cap : end).toISOString();
      }
      await api.post(`/v1/risks/${props.riskId}/acceptances`, {
        responseType,
        rationale: rationale.trim(),
        compensatingControls: controls
          .filter((c) => c.description.trim())
          .map((c) => ({ controlRef: c.controlRef.trim() || null, description: c.description.trim() })),
        ...(expiresAt ? { expiresAt } : {}),
      });
      setRationale("");
      setExpiry("");
      setControls([]);
      await q.refetch();
      props.onChanged?.();
    }, "Acceptance recorded. It lapses at its expiry date and the risk then reopens.");

  return (
    <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
      {h && p && (
        <div className={v.stack}>
          <Card title="Residual risk against tolerance">
            <div className={v.stack} data-testid="risk-position">
              <div>
                Residual level: <Badge tone={bandTone(p.band)}>{p.band ?? "none (closed)"}</Badge>{" "}
                · Tolerance: <Badge tone="neutral">{`up to ${p.tolerance.band}`}</Badge>{" "}
                <span className={v.faint}>({sourceLabel(p.tolerance.source)})</span>
              </div>
              <div>
                {p.aboveTolerance ? (
                  <Badge tone="danger">Above tolerance: needs a valid acceptance</Badge>
                ) : p.acceptance ? (
                  <Badge tone="ok">{`Covered by an acceptance until ${p.acceptance.expiresAt.slice(0, 10)}`}</Badge>
                ) : p.band && BAND_RANK[p.band]! <= BAND_RANK[p.tolerance.band]! ? (
                  <Badge tone="ok">Within tolerance</Badge>
                ) : (
                  <Badge tone="neutral">No residual position</Badge>
                )}
              </div>
              <div className={v.faint}>
                With nothing configured, any residual risk above medium needs a valid, time-limited acceptance. An
                above-tolerance risk with no valid acceptance raises an alert and holds the deployment gate.
              </div>
            </div>
          </Card>

          <Card title="Acceptance history">
            {h.acceptances.length === 0 ? (
              <EmptyState title="Never accepted" body="No acceptance has been recorded for this risk." />
            ) : (
              <Table
                rows={h.acceptances}
                rowKey={(r) => r.id}
                columns={[
                  { key: "state", header: "Status", render: (r) => <Badge tone={stateTone(r.state)}>{r.state}</Badge> },
                  { key: "who", header: "Accepted by", render: (r) => r.acceptedByName ?? "an operator" },
                  { key: "when", header: "When", render: (r) => <span title={fmtAt(r.acceptedAt)}>{ago(r.acceptedAt)}</span> },
                  {
                    key: "expires",
                    header: "Expires",
                    render: (r) => (
                      <span title={fmtAt(r.expiresAt)}>
                        {r.state === "superseded"
                          ? `superseded ${r.supersededAt ? ago(r.supersededAt) : ""}`
                          : r.state === "revoked"
                            ? "revoked"
                            : expiresIn(r.expiresAt)}
                      </span>
                    ),
                  },
                  { key: "band", header: "Level", render: (r) => <Badge tone={bandTone(r.residualBand)}>{r.residualBand}</Badge> },
                  { key: "type", header: "Response", render: (r) => RESPONSE_TYPE_LABELS[r.responseType] ?? r.responseType },
                  {
                    key: "why",
                    header: "Rationale and compensating controls",
                    render: (r) => (
                      <div>
                        <div>{r.rationale}</div>
                        {r.compensatingControls.length > 0 && (
                          <ul className={v.faint} style={{ margin: 0, paddingLeft: "1.2em" }}>
                            {r.compensatingControls.map((c, i) => (
                              <li key={i}>
                                {c.controlRef ? <code>{c.controlRef}</code> : null}
                                {c.controlRef ? ": " : ""}
                                {c.description}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Card>

          <Card title={p.acceptance ? "Record a new acceptance (replaces the current one)" : "Accept the residual risk"}>
            {!h.canAccept ? (
              <div className={v.faint} data-testid="accept-refusal">
                {REFUSAL_TEXT[h.acceptRefusal ?? ""] ?? "You cannot accept this risk."}
              </div>
            ) : (
              <form
                className={v.stack}
                aria-label="Accept residual risk"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <p className={v.hint} data-testid="expiry-limit">
                  {limitExplanation(p.band, p.maxAcceptanceMonths, p.maxExpiresAt)}
                </p>
                <div className={a.formRow}>
                  <Field label="Response">
                    <Select value={responseType} onChange={(e) => setResponseType(e.target.value)}>
                      {Object.entries(RESPONSE_TYPE_LABELS).map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Expires on (optional)" error={expiryError}>
                    <Input type="date" value={expiry} min={minDate} max={maxDate} onChange={(e) => setExpiry(e.target.value)} />
                  </Field>
                </div>
                <Field label="Why is the remaining risk acceptable? (required, recorded)">
                  <Textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} required minLength={10} />
                </Field>
                <fieldset className={v.stack} style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className={v.faint}>Compensating controls (optional)</legend>
                  {controls.map((c, i) => (
                    <div className={a.formRow} key={i}>
                      <Field label={`Control ${i + 1} reference (optional)`}>
                        <Input
                          value={c.controlRef}
                          placeholder="eu-ai-act:art-14-human-oversight"
                          onChange={(e) => setControls(controls.map((x, j) => (j === i ? { ...x, controlRef: e.target.value } : x)))}
                        />
                      </Field>
                      <Field label={`Control ${i + 1}: what it does`} grow>
                        <Input
                          value={c.description}
                          onChange={(e) => setControls(controls.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                        />
                      </Field>
                      <Field label=" ">
                        <Button type="button" variant="ghost" onClick={() => setControls(controls.filter((_, j) => j !== i))}>
                          {`Remove control ${i + 1}`}
                        </Button>
                      </Field>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={controls.length >= 20}
                      onClick={() => setControls([...controls, { controlRef: "", description: "" }])}
                    >
                      Add a compensating control
                    </Button>
                  </div>
                </fieldset>
                <div>
                  <Button type="submit" variant="danger" disabled={act.busy || rationale.trim().length < 10 || !!expiryError}>
                    Record acceptance
                  </Button>
                </div>
              </form>
            )}
          </Card>
        </div>
      )}
    </QueryGate>
  );
}
