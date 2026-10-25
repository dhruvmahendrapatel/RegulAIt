/**
 * Batch U4 — the red-team reads and the one write the Red-teaming page lacked:
 *
 *  - POSTURE (`GET /v1/redteam/summary`): what got through recently, by
 *    severity and attack class, with who ran it;
 *  - STANDING FINDINGS (`GET /v1/redteam/findings`): every defeat on record,
 *    newest first, filterable by class and severity. A record, not a queue;
 *  - THE PER-TRIAL RECORD of a run (`GET /v1/redteam/runs/:id/trials`, ADR-0068);
 *  - ATTACH A RUN TO A MODEL CARD as evidence (`POST /v1/redteam/runs/:id/evidence`),
 *    confirmed first, with every refusal in words.
 *
 * The coverage disclosure travels with every number, as on the rest of the page.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../../api/client";
import { ago, fmtUsd } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, SeverityBadge, Table } from "../../../ui/kit";
import { QueryGate, Stat, optionEls, useAction } from "../adminKit";
import { RED_TEAM_SEVERITIES, REDTEAM_EVIDENCE_REFUSALS, asrText, probeTrialSummary, type ProbeTrial, type ProbeTrialSummary } from "./redteamModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

interface SummaryRun {
  id: string;
  agentName: string;
  libraryName: string;
  libraryVersion: number;
  trigger: string;
  probes: number;
  defeated: number;
  resistRate: number | null;
  gatePassed: boolean | null;
  regression: boolean;
  startedAt: string;
  by: string | null;
}
interface Summary {
  runs: number;
  regressions: number;
  failed: number;
  findings: number;
  bySeverity: Record<string, number>;
  byClass: Record<string, number>;
  totalCostUsd: number;
  recent: SummaryRun[];
  disclosure: string;
}

export function RedTeamSummaryCard(props: { onOpenRun: (id: string) => void }) {
  const q = useQuery({ queryKey: ["admin", "redteam-summary"], queryFn: () => api.get<Summary>("/v1/redteam/summary") });
  const s = q.data;
  return (
    <Card title="Posture — what got through recently">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {s && (
          <div className={v.stack}>
            <div className={a.formRow}>
              <Stat value={s.runs} label="runs (latest 200)" />
              <Stat value={s.findings} label="probes that got through" />
              <Stat value={s.failed} label="runs that failed the gate" />
              <Stat value={s.regressions} label="regressions" />
              <Stat value={fmtUsd(s.totalCostUsd)} label="metered cost" />
            </div>
            <div className={v.row} role="group" aria-label="Findings by severity">
              {RED_TEAM_SEVERITIES.map((sev) => (
                <span key={sev} className={v.row}>
                  <SeverityBadge severity={sev} /> <span className={v.num}>{s.bySeverity?.[sev] ?? 0}</span>
                </span>
              ))}
            </div>
            {Object.keys(s.byClass ?? {}).length > 0 && (
              <p className={v.dim}>
                By attack class:{" "}
                {Object.entries(s.byClass ?? {})
                  .sort((x, y) => y[1] - x[1])
                  .map(([k, n]) => `${k} ${n}`)
                  .join(" · ")}
              </p>
            )}
            <Table<SummaryRun>
              rows={s.recent ?? []}
              rowKey={(r) => r.id}
              empty={<EmptyState title="No red-team runs yet" />}
              columns={[
                { key: "agent", header: "Agent", render: (r) => r.agentName },
                { key: "lib", header: "Library", render: (r) => `${r.libraryName} v${r.libraryVersion}` },
                { key: "def", header: "Got through", render: (r) => `${r.defeated}/${r.probes}` },
                {
                  key: "gate",
                  header: "Gate",
                  render: (r) => (
                    <Badge tone={r.gatePassed === false ? "danger" : "ok"}>
                      {r.gatePassed === false ? (r.regression ? "regression" : "failed") : "no known regression"}
                    </Badge>
                  ),
                },
                { key: "by", header: "Run by", render: (r) => r.by ?? (r.trigger === "manual" ? "unknown" : r.trigger) },
                { key: "when", header: "When", render: (r) => ago(r.startedAt) },
                {
                  key: "open",
                  header: "",
                  align: "right",
                  render: (r) => (
                    <Button size="sm" aria-label={`Open the run of ${r.libraryName} against ${r.agentName}`} onClick={() => props.onOpenRun(r.id)}>
                      Open
                    </Button>
                  ),
                },
              ]}
            />
            <p className={v.faint}>{s.disclosure}</p>
          </div>
        )}
      </QueryGate>
    </Card>
  );
}

interface FindingRow {
  finding: { id: string; runId: string; probeKey: string; attackClass: string; severity: string; score: number; outputSnippet: string | null };
  agentName: string;
  libraryName: string;
  libraryVersion: number;
  startedAt: string;
}

export function RedTeamFindingsCard(props: { attackClasses: string[]; onOpenRun: (id: string) => void }) {
  const [attackClass, setAttackClass] = useState("");
  const [severity, setSeverity] = useState("");
  const [limit, setLimit] = useState("100");
  const params = new URLSearchParams({ limit, ...(attackClass ? { attackClass } : {}), ...(severity ? { severity } : {}) });
  const q = useQuery({
    queryKey: ["admin", "redteam-findings", attackClass, severity, limit],
    queryFn: () => api.get<{ findings: FindingRow[]; disclosure: string }>(`/v1/redteam/findings?${params.toString()}`),
  });
  return (
    <Card title="Standing findings — every defeat on record">
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Attack class">
            <Select value={attackClass} onChange={(e) => setAttackClass(e.target.value)}>
              {optionEls(props.attackClasses.map((c) => ({ v: c, l: c })), "every class")}
            </Select>
          </Field>
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {optionEls(RED_TEAM_SEVERITIES.map((s) => ({ v: s, l: s })), "every severity")}
            </Select>
          </Field>
          <Field label="Show at most">
            <Select value={limit} onChange={(e) => setLimit(e.target.value)}>
              {["25", "100", "500"].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Table<FindingRow>
          rows={q.data?.findings}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(r) => r.finding.id}
          empty={<EmptyState title="No standing findings match" body="No probe in the matching runs got through. That is not proof of safety — see the disclosure." />}
          columns={[
            { key: "probe", header: "Probe", render: (r) => <code>{r.finding.probeKey}</code> },
            { key: "class", header: "Class", render: (r) => r.finding.attackClass },
            { key: "sev", header: "Severity", render: (r) => <SeverityBadge severity={r.finding.severity} /> },
            { key: "agent", header: "Agent", render: (r) => r.agentName },
            { key: "lib", header: "Library", render: (r) => `${r.libraryName} v${r.libraryVersion}` },
            { key: "out", header: "What the agent produced", render: (r) => <span className={v.faint}>{(r.finding.outputSnippet ?? "").slice(0, 200)}</span> },
            { key: "when", header: "Run", render: (r) => ago(r.startedAt) },
            {
              key: "open",
              header: "",
              align: "right",
              render: (r) => (
                <Button size="sm" aria-label={`Open run that found ${r.finding.probeKey}`} onClick={() => props.onOpenRun(r.finding.runId)}>
                  Open run
                </Button>
              ),
            },
          ]}
        />
        {(q.data?.findings?.length ?? 0) >= Number(limit) && (
          <p className={v.faint}>Showing the newest {limit}. Narrow by class or severity, or raise the limit, to see older ones.</p>
        )}
        {q.data && <p className={v.faint}>{q.data.disclosure}</p>}
      </div>
    </Card>
  );
}

interface TrialsResponse {
  run: {
    id: string;
    trials: number;
    measurementQuality: string | null;
    asr: number | null;
    asrTrials: number;
    asrLower: number | null;
    asrUpper: number | null;
    notRunProbes: number;
    platformHeld: number;
    corpusVersion: number | null;
    presetTightened: string[];
  };
  trials: Array<{ id: string; trial: number; probes: number; defeated: number; errored: number; costUsd: number; startedAt: string }>;
  probeTrials: ProbeTrial[];
  asrDisclosure: string;
  disclosure: string;
}

/** ADR-0068 §1: the per-trial record of one run */
export function RunTrialsSection(props: { runId: string }) {
  const q = useQuery({
    queryKey: ["admin", "redteam-run-trials", props.runId],
    queryFn: () => api.get<TrialsResponse>(`/v1/redteam/runs/${props.runId}/trials`),
  });
  const probes = q.data ? probeTrialSummary(q.data.probeTrials ?? []) : [];
  return (
    <section className={v.stack} aria-label="Per-trial record">
      <div className={v.sectionTitle}>Per-trial record</div>
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data?.run && (
          <>
            <p>
              Attack success rate: <strong>{asrText(q.data.run)}</strong>. Measurement: {q.data.run.measurementQuality ?? "unlabelled"}; {q.data.run.trials} trial
              {q.data.run.trials === 1 ? "" : "s"} per probe.
              {q.data.run.notRunProbes > 0 && ` ${q.data.run.notRunProbes} probe(s) did not run.`}
              {q.data.run.platformHeld > 0 && ` ${q.data.run.platformHeld} held by the platform before the model.`}
            </p>
            <p className={v.faint}>{q.data.asrDisclosure}</p>
            <Table
              rows={q.data.trials ?? []}
              rowKey={(t) => t.id}
              empty={<EmptyState title="No trial rows recorded" body="A run from before the per-trial record (ADR-0068) has only its summary." />}
              columns={[
                { key: "t", header: "Trial", render: (t) => t.trial },
                { key: "p", header: "Probes", render: (t) => t.probes },
                { key: "d", header: "Got through", render: (t) => t.defeated },
                { key: "e", header: "Errored", render: (t) => t.errored },
                { key: "c", header: "Cost", render: (t) => fmtUsd(t.costUsd) },
              ]}
            />
            {probes.length > 0 && (
              <Table<ProbeTrialSummary>
                rows={probes}
                rowKey={(p) => p.probeKey}
                columns={[
                  { key: "k", header: "Probe", render: (p) => <code>{p.probeKey}</code> },
                  { key: "s", header: "Severity", render: (p) => <SeverityBadge severity={p.severity} /> },
                  { key: "d", header: "Got through", render: (p) => `${p.defeated} of ${p.trials}` },
                  { key: "e", header: "Errored", render: (p) => p.errored },
                  { key: "f", header: "Stable?", render: (p) => (p.flapped ? <Badge tone="warn">flapped between trials</Badge> : <Badge tone="neutral">steady</Badge>) },
                ]}
              />
            )}
          </>
        )}
      </QueryGate>
    </section>
  );
}

interface CardOption {
  id: string;
  intendedUse: string;
  subjectName?: string | null;
}

/** ADR-0045 §5: cite this run as measured evidence on a model card */
export function AttachRunEvidence(props: { runId: string; attached: Array<{ id: string; cardId: string; label: string | null }>; onDone: () => void }) {
  const cards = useQuery({ queryKey: ["admin", "mrm-cards"], queryFn: () => api.get<{ cards: CardOption[] }>("/v1/mrm/cards") });
  const [cardId, setCardId] = useState("");
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const act = useAction();
  const cardName = (id: string) => {
    const c = (cards.data?.cards ?? []).find((x) => x.id === id);
    return c ? `${c.subjectName ?? "model"} — ${c.intendedUse}` : id;
  };
  const attach = () => {
    setConfirming(false);
    setWarning(null);
    void act.run(async () => {
      try {
        const out = await api.post<{ evidence: { id: string }; aiBomSnapshotWarning?: string }>(`/v1/redteam/runs/${props.runId}/evidence`, {
          cardId,
          ...(label.trim() ? { label: label.trim() } : {}),
        });
        if (out.aiBomSnapshotWarning) setWarning(out.aiBomSnapshotWarning);
      } catch (e) {
        const code = e instanceof ApiError && typeof e.payload.error === "string" ? e.payload.error : null;
        if (code && REDTEAM_EVIDENCE_REFUSALS[code]) throw new Error(REDTEAM_EVIDENCE_REFUSALS[code]);
        throw e;
      }
      setLabel("");
      props.onDone();
    }, "Run attached to the model card as evidence");
  };
  return (
    <section className={v.stack} aria-label="Model card evidence">
      <div className={v.sectionTitle}>Model card evidence</div>
      {props.attached.length > 0 ? (
        <ul>
          {props.attached.map((e) => (
            <li key={e.id}>
              Cited on <Link to="/admin/model-risk">{cardName(e.cardId)}</Link>
              {e.label ? ` — ${e.label}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className={v.faint}>This run is not cited on any model card yet.</p>
      )}
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (cardId) setConfirming(true);
        }}
      >
        <Field label="Model card">
          <Select value={cardId} onChange={(e) => setCardId(e.target.value)} required>
            {optionEls((cards.data?.cards ?? []).map((c) => ({ v: c.id, l: `${c.subjectName ?? "model"} — ${c.intendedUse}` })), cards.isLoading ? "loading cards…" : "choose a card")}
          </Select>
        </Field>
        <Field label="Label (optional)" grow>
          <Input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="&nbsp;">
          <Button type="submit" disabled={!cardId || act.busy}>
            Attach as evidence
          </Button>
        </Field>
      </form>
      {cards.isError && (
        <p className={v.errLine} role="alert">
          The model cards could not be loaded: {cards.error instanceof Error ? cards.error.message : String(cards.error)}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      {warning && (
        <p role="status">
          <Badge tone="warn">AI BOM</Badge> {warning}
        </p>
      )}
      <ConfirmModal
        open={confirming}
        title="Attach this run to the model card?"
        confirmLabel="Attach evidence"
        body={
          <p>
            The run's evaluation is cited as measured evidence on <strong>{cardName(cardId)}</strong>. The attach is audited and, where AI BOM sign-off
            snapshots are on, takes a signed snapshot of the card's agent; without a signing key that is refused and nothing is saved. A citation can be
            detached later on the Model risk page.
          </p>
        }
        onConfirm={attach}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
