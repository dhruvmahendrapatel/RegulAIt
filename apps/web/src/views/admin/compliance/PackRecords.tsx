/**
 * ADR-0058 — one pack's controls and attestations (`GET /v1/compliance/packs/:id`,
 * `POST …/attestations`) and the stored scorecard artifacts
 * (`GET /v1/compliance/pack-reports`, `…/:id`).
 *
 * An attestation is the customer's OWN statement about an organisational
 * control, attributed to the person who records it. It is reported as
 * "attested", never "satisfied", and only an attestation-required control can
 * take one: the form offers no other.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt } from "../../../api/format";
import { Badge, Button, Card, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { KV, QueryGate, Stat, useAction, useNameMaps } from "../adminKit";
import { NewestNote } from "../../../ui/fold";
import { withRefusalCopy } from "../governance/refusalCopy";
import {
  EMPTY_ATTESTATION,
  PACK_REFUSALS,
  attestableControls,
  attestationBody,
  attestationLapsed,
  scopeWords,
  type AttestationForm,
  type PackAttestation,
  type PackControl,
  type PackDetail,
  type PackReport,
  type PackReportSummary,
} from "./packRecordsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "neutral"> = {
  satisfied: "ok",
  attested: "info",
  unsatisfied: "danger",
  attestation_required: "warn",
  unaddressed: "neutral",
};

export function PackDetailCard(props: { packId: string; onClose: () => void }) {
  const names = useNameMaps();
  const detail = useQuery({
    queryKey: ["admin", "compliance-pack", props.packId],
    queryFn: () => withRefusalCopy(() => api.get<PackDetail>(`/v1/compliance/packs/${props.packId}`), PACK_REFUSALS),
  });
  const d = detail.data;
  return (
    <Card
      title={d ? `${d.pack.framework} v${d.pack.version} — controls and attestations` : "Pack detail"}
      actions={
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
        {d ? (
          <div className={v.stack} data-testid="pack-detail">
            <p className={v.dim}>{d.pack.title}</p>
            <Table<PackControl>
              rows={d.controls}
              rowKey={(c) => c.id}
              columns={[
                { key: "ref", header: "Control", render: (c) => <code>{c.controlRef}</code> },
                { key: "title", header: "Title", render: (c) => <span className={v.dim}>{c.title}</span> },
                { key: "coverage", header: "Declared coverage", render: (c) => c.coverage },
                {
                  key: "evidence",
                  header: "Evidenced by",
                  render: (c) =>
                    c.attestationRequired ? (
                      <Badge tone="warn">a person's attestation</Badge>
                    ) : (
                      <span>
                        <code>{c.collector}</code> <span className={v.faint}>≥ {c.minEvidenceCount}</span>
                      </span>
                    ),
                },
                { key: "note", header: "Owner note", render: (c) => <span className={v.faint}>{c.ownerNote ?? ""}</span> },
              ]}
            />
            <div className={v.sectionTitle}>Attestations</div>
            <Table<PackAttestation>
              rows={d.attestations}
              rowKey={(x) => x.id}
              empty={<span className={v.faint}>No attestation has been recorded for this pack.</span>}
              columns={[
                { key: "ref", header: "Control", render: (x) => <code>{x.controlRef}</code> },
                { key: "statement", header: "Statement", render: (x) => <span className={v.dim}>{x.statement}</span> },
                { key: "evidence", header: "Evidence reference", render: (x) => x.evidenceRef ?? <span className={v.faint}>—</span> },
                {
                  key: "valid",
                  header: "Valid until",
                  render: (x) =>
                    x.validUntil === null ? (
                      <span className={v.faint}>no expiry stated</span>
                    ) : attestationLapsed(x) ? (
                      <Badge tone="danger">lapsed {ago(x.validUntil)}</Badge>
                    ) : (
                      fmtAt(x.validUntil)
                    ),
                },
                {
                  key: "by",
                  header: "Attested by",
                  render: (x) => `${x.attestedByUserId ? (names.userName.get(x.attestedByUserId) ?? x.attestedByUserId) : "—"} · ${ago(x.attestedAt)}`,
                },
              ]}
            />
            <AttestationFormView packId={props.packId} controls={d.controls} onRecorded={() => void detail.refetch()} />
            <p className={v.faint}>{d.disclaimer}</p>
          </div>
        ) : null}
      </QueryGate>
    </Card>
  );
}

function AttestationFormView(props: { packId: string; controls: readonly PackControl[]; onRecorded: () => void }) {
  const act = useAction();
  const options = attestableControls(props.controls);
  const [form, setForm] = useState<AttestationForm>(EMPTY_ATTESTATION);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { intro: useId(), valid: useId(), problem: useId() };
  const set = <K extends keyof AttestationForm>(k: K, value: AttestationForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };
  if (options.length === 0) {
    return (
      <p className={v.faint}>
        Every control in this pack is evidenced from the ledgers, so there is nothing for a person to attest to.
      </p>
    );
  }
  return (
    <form
      aria-label="Record an attestation"
      aria-describedby={ids.intro}
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        const built = attestationBody(form);
        if (!built.ok) {
          setProblem(built.problem);
          return;
        }
        void act
          .run(
            () => withRefusalCopy(() => api.post(`/v1/compliance/packs/${props.packId}/attestations`, built.body), PACK_REFUSALS),
            "Attestation recorded — the scorecard reports it as attested, not satisfied",
          )
          .then((ok) => {
            if (ok) {
              setForm(EMPTY_ATTESTATION);
              props.onRecorded();
            }
          });
      }}
    >
      <div className={v.sectionTitle}>Record an attestation</div>
      <p className={v.faint} id={ids.intro}>
        Your own statement about an organisational control, recorded under your name. regulAIt collects no evidence for
        it; the scorecard shows it as attested, never as satisfied.
      </p>
      <div className={a.formRow}>
        <Field label="Control">
          <Select value={form.controlRef} onChange={(e) => set("controlRef", e.target.value)}>
            <option value="">— choose a control —</option>
            {options.map((c) => (
              <option key={c.id} value={c.controlRef}>
                {c.controlRef} — {c.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Valid until (optional)">
          <Input type="date" value={form.validUntil} aria-describedby={ids.valid} onChange={(e) => set("validUntil", e.target.value)} />
        </Field>
        <Field label="Evidence reference (optional)" grow>
          <Input value={form.evidenceRef} maxLength={600} onChange={(e) => set("evidenceRef", e.target.value)} placeholder="where the proof lives, for example LMS report 2026-Q3" />
        </Field>
      </div>
      <p className={v.faint} id={ids.valid}>
        Leave empty if no expiry is stated; the scorecard then says so rather than treating it as permanent.
      </p>
      <Field label="Statement" grow>
        <Textarea rows={3} maxLength={4000} value={form.statement} onChange={(e) => set("statement", e.target.value)} />
      </Field>
      <div className={v.row}>
        <Button type="submit" variant="primary" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
          Record attestation
        </Button>
      </div>
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
    </form>
  );
}

export function PackReportsCard(props: { packId?: string | null; packLabel?: string | null; onClearPack?: () => void }) {
  const names = useNameMaps();
  const [openId, setOpenId] = useState<string | null>(null);
  const qs = props.packId ? `?packId=${props.packId}&limit=50` : "?limit=50";
  const reports = useQuery({
    queryKey: ["admin", "compliance-pack-reports", props.packId ?? "all"],
    queryFn: () => api.get<{ reports: PackReportSummary[]; disclaimer: string }>(`/v1/compliance/pack-reports${qs}`),
  });
  return (
    <Card
      title={props.packLabel ? `Stored reports — ${props.packLabel}` : "Stored reports"}
      actions={
        props.packId && props.onClearPack ? (
          <Button size="sm" variant="ghost" onClick={props.onClearPack}>
            Show every pack
          </Button>
        ) : undefined
      }
    >
      <p className={v.faint}>
        Each evaluation stores the scorecard it produced, with the pack version and the exact projects it covered. A
        stored report is a record of that moment, not a live figure.
      </p>
      <QueryGate loading={reports.isLoading} error={reports.error} onRetry={() => void reports.refetch()}>
        <NewestNote shown={reports.data?.reports?.length ?? 0} limit={50} noun="reports" />
        <Table<PackReportSummary>
          rows={reports.data?.reports ?? []}
          rowKey={(r) => r.id}
          empty={<span className={v.faint}>No report has been generated yet. Evaluate a pack to store one.</span>}
          columns={[
            { key: "pack", header: "Pack", render: (r) => <code>{`${r.framework} v${r.packVersion}`}</code> },
            { key: "period", header: "Period", render: (r) => `${r.periodStart.slice(0, 10)} → ${r.periodEnd.slice(0, 10)}` },
            { key: "scope", header: "Covers", render: (r) => scopeWords(r) },
            { key: "by", header: "Generated by", render: (r) => (r.requestedByUserId ? (names.userName.get(r.requestedByUserId) ?? r.requestedByUserId) : "—") },
            { key: "at", header: "Generated", render: (r) => ago(r.generatedAt), sort: (r) => r.generatedAt },
            {
              key: "open",
              header: "",
              srHeader: "Actions",
              align: "right",
              render: (r) => (
                <Button size="sm" aria-label={`Open the ${r.framework} v${r.packVersion} report from ${ago(r.generatedAt)}`} onClick={() => setOpenId(r.id === openId ? null : r.id)}>
                  {r.id === openId ? "Close" : "Open"}
                </Button>
              ),
            },
          ]}
        />
      </QueryGate>
      {openId && <PackReportView reportId={openId} />}
    </Card>
  );
}

function PackReportView(props: { reportId: string }) {
  const report = useQuery({
    queryKey: ["admin", "compliance-pack-report", props.reportId],
    queryFn: () => withRefusalCopy(() => api.get<{ report: PackReport }>(`/v1/compliance/pack-reports/${props.reportId}`), PACK_REFUSALS),
  });
  const r = report.data?.report;
  const totals = r?.payload.totals ?? {};
  return (
    <div className={v.stack} style={{ marginTop: "var(--s2)" }} data-testid="pack-report">
      <QueryGate loading={report.isLoading} error={report.error} onRetry={() => void report.refetch()}>
        {r ? (
          <>
            <KV
              rows={[
                ["Pack", `${r.framework} v${r.packVersion}`],
                ["Period", r.payload.period?.label ?? `${r.periodStart.slice(0, 10)} → ${r.periodEnd.slice(0, 10)}`],
                ["Covers", scopeWords(r)],
                ["Generated", fmtAt(r.generatedAt)],
              ]}
            />
            {r.payload.statement ? <p className={v.dim}>{r.payload.statement}</p> : null}
            <div className={a.statRow}>
              <Stat value={totals.satisfied ?? 0} label="Evidenced from the ledgers" />
              <Stat value={totals.unsatisfied ?? 0} label="No evidence in the period" />
              <Stat value={totals.attestationRequired ?? 0} label="Attestation outstanding" />
              <Stat value={totals.attested ?? 0} label="Attested (customer's own statement)" />
            </div>
            <Table
              rows={r.payload.controls ?? []}
              rowKey={(c) => c.controlRef}
              columns={[
                { key: "ref", header: "Control", render: (c) => <code>{c.controlRef}</code> },
                { key: "title", header: "Title", render: (c) => <span className={v.dim}>{c.title}</span> },
                { key: "status", header: "Status", render: (c) => <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{c.status}</Badge> },
                {
                  key: "evidence",
                  header: "Evidence",
                  render: (c) => (c.evidenceCount === null ? <span className={v.faint}>not auto-evidenced</span> : `${c.evidenceCount} / ${c.minEvidenceCount}`),
                },
              ]}
            />
            {r.payload.disclaimer ? <p className={v.faint}>{r.payload.disclaimer}</p> : null}
          </>
        ) : null}
      </QueryGate>
    </div>
  );
}
