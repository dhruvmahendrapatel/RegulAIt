/**
 * ADR-0190 I3 — one executor's detail and lifecycle on the Engines page.
 *
 *  - QUARANTINE tightens (it places nothing afterwards): confirmed, no step-up.
 *  - RE-ENABLE relaxes: confirmed, `settings_relax` step-up; the executor's
 *    earlier attestations stop counting and it takes no work before a new
 *    passing self-test.
 *  - REVOKE is terminal: confirmed by typing the executor's name.
 *  - DECLARED CLASS maps a customer plane's declared isolation to a class
 *    (a relaxation: step-up), or unmaps it (the strict default: no step-up).
 * Every act is audited by the gateway. Each control is offered only where the
 * gateway would accept it, and says why otherwise.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../../api/client";
import { fmtAt } from "../../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Select } from "../../../../ui/kit";
import { DataList } from "../../../../ui/DataList";
import { KV, useAction } from "../../adminKit";
import {
  CLASSES,
  attestationRecordText,
  availabilityOf,
  classText,
  declaredClassBody,
  executorActs,
  executorReading,
  executorRefusal,
  parseAttestationRecord,
  parseExecutor,
  type AttestationRecord,
  type Executor,
} from "./isolationModel";
import { RevokeDialog, executorCall, revokeExecutor } from "./RevokeExecutor";
import v from "../../../views.module.css";

export const executorKeys = {
  detail: (id: string) => ["admin", "isolation", "executor", id] as const,
  attestations: (id: string) => ["admin", "isolation", "executor", id, "attestations"] as const,
};

type Pending = null | { kind: "quarantine" | "reenable" } | { kind: "revoke" } | { kind: "declared"; value: string };

export function ExecutorDetail(props: { executorId: string; onClose: () => void }) {
  const id = props.executorId;
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: executorKeys.detail(id), retry: false, queryFn: () => api.get<unknown>(`/v1/executors/${encodeURIComponent(id)}`) });
  const act = useAction();
  const [pending, setPending] = useState<Pending>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const executor = detail.data === undefined ? null : parseExecutor(detail.data);
  const raw = (detail.data ?? {}) as Record<string, unknown>;

  const run = (fn: () => Promise<unknown>, ok: string) =>
    act.run(async () => {
      await executorCall(fn);
      await qc.invalidateQueries({ queryKey: ["admin", "isolation"] });
    }, ok);

  const actions = (
    <Button size="sm" variant="ghost" onClick={props.onClose}>
      Close
    </Button>
  );
  if (detail.isPending) return <Card title="Executor" actions={actions}>Loading the executor…</Card>;
  if (detail.isError || !executor) {
    const a = detail.isError ? availabilityOf(detail.error) : null;
    return (
      <Card title="Executor" actions={actions}>
        <EmptyState
          title="Executor unavailable"
          body={
            a?.kind === "forbidden"
              ? "You are not allowed to read this executor."
              : a?.kind === "failed"
                ? `The executor could not be read: ${executorRefusal(detail.error) ?? a.message}`
                : "The gateway sent an executor record this console cannot read. No assurance is shown."
          }
        />
      </Card>
    );
  }

  const acts = executorActs(executor);
  const reading = executorReading(executor, now);
  return (
    <Card title={`Executor ${executor.name}`} actions={actions}>
      <div className={v.stack} data-testid="executor-detail">
        <KV
          rows={[
            ["Attestation", <span key="r"><Badge tone={reading.tone}>{reading.state}</Badge> <span className={v.faint}>{reading.detail}</span></span>],
            ["Backend · runtime", `${executor.backend} · ${executor.runtimeVersion}`],
            ["Expected classes", executor.classesDeclared.map(classText).join(", ") || "None"],
            ...(executor.backend === "customer"
              ? ([["Declared class mapping", executor.declaredClass ? classText(executor.declaredClass) : "Not mapped (satisfies no requirement)"]] as Array<[ReactNode, ReactNode]>)
              : []),
            ["Status", executor.status],
            ["Worker identity", typeof raw.workloadIdentityId === "string" ? <code key="w">{raw.workloadIdentityId}</code> : "Not reported"],
            ["Quarantined", typeof raw.quarantinedAt === "string" ? fmtAt(raw.quarantinedAt) : "No"],
            ["Re-enabled", typeof raw.reenabledAt === "string" ? fmtAt(raw.reenabledAt) : "Never"],
            ["Open work", String(executor.openOffers)],
          ]}
        />

        <div className={v.row}>
          <ActButton label="Quarantine" gate={acts.quarantine} busy={act.busy} onClick={() => setPending({ kind: "quarantine" })} />
          <ActButton label="Re-enable" gate={acts.reenable} busy={act.busy} onClick={() => setPending({ kind: "reenable" })} />
          <ActButton label="Revoke" danger gate={acts.revoke} busy={act.busy} onClick={() => setPending({ kind: "revoke" })} />
        </div>

        {executor.backend === "customer" && <DeclaredClassForm executor={executor} gate={acts.declared_class} busy={act.busy} onSubmit={(value) => setPending({ kind: "declared", value })} />}

        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}

        <h3 className={v.sectionTitle}>Self-test history</h3>
        <p className={v.dim}>
          Every report this executor has sent. Each is software-attested by the executor on its own host. A pass counts only for a class its backend
          can attest, and only until it expires. A record this console cannot read is shown as unreadable, never guessed.
        </p>
        <DataList<unknown>
          listId="executor-attestations"
          noun="self-test reports"
          endpoint={`/v1/executors/${encodeURIComponent(id)}/attestations`}
          exportPath={`/v1/executors/${encodeURIComponent(id)}/attestations/export.xlsx`}
          queryKey={[...executorKeys.attestations(id), "list"]}
          legacyKey="attestations"
          defaultSort={{ key: "at", dir: "desc" }}
          rowKey={(raw) => (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : JSON.stringify(raw))}
          empty={<EmptyState title="No self-test reports" body="This executor has not reported a self-test, so none of its classes count." />}
          columns={[
            {
              key: "at",
              header: "Observed",
              main: true,
              sortable: true,
              render: (raw) => {
                const r = parseAttestationRecord(raw);
                return r ? fmtAt(new Date(r.observedAt).toISOString()) : "Unreadable record";
              },
            },
            { key: "class", header: "Class", main: true, sortable: true, render: (raw) => classText(parseAttestationRecord(raw)?.isolationClass ?? null) },
            {
              key: "verdict",
              header: "Verdict",
              main: true,
              sortable: true,
              required: "The verdict is always shown",
              render: (raw) => {
                const r = parseAttestationRecord(raw);
                if (!r) return <Badge tone="neutral">Unmeasured</Badge>;
                const t = attestationRecordText(r, executor.backend, now);
                return <Badge tone={t.tone}>{t.label}</Badge>;
              },
            },
            {
              key: "expires",
              header: "Expires",
              main: true,
              sortable: true,
              render: (raw) => {
                const r = parseAttestationRecord(raw);
                return r ? fmtAt(new Date(r.expiresAt).toISOString()) : "—";
              },
            },
            {
              key: "report",
              header: "Report SHA-256",
              main: true,
              sortable: true,
              render: (raw) => {
                const r = parseAttestationRecord(raw);
                return r ? <code title={r.reportSha256}>{r.reportSha256.slice(0, 12)}…</code> : "—";
              },
            },
            { key: "profile", header: "Profile digest", sortable: true, render: (raw) => (raw && typeof raw === "object" ? <code>{String((raw as { profileDigest?: unknown }).profileDigest ?? "—").slice(0, 12)}</code> : "—") },
          ]}
        />
      </div>

      <ConfirmModal
        open={pending?.kind === "quarantine"}
        title={`Quarantine ${executor.name}?`}
        danger
        confirmLabel="Quarantine"
        body={
          <p>
            It places nothing from now on, and every call that needs it is refused (<code>executor_quarantined</code>) rather than run with weaker
            isolation. Open work is withdrawn. Re-enabling it later needs a step-up and a new passing self-test. The act is audited.
          </p>
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setPending(null);
          void run(() => api.post(`/v1/executors/${encodeURIComponent(id)}/quarantine`, { code: "admin" }), `${executor.name} quarantined`);
        }}
      />
      <ConfirmModal
        open={pending?.kind === "reenable"}
        title={`Re-enable ${executor.name}?`}
        confirmLabel="Re-enable"
        body={
          <p>
            This relaxes a quarantine, so you will be asked to confirm it&apos;s you. Its earlier self-tests stop counting: it takes no work until it
            passes a new one. The act is audited.
          </p>
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setPending(null);
          void run(() => withStepUp((h) => stepUpApi.post(`/v1/executors/${encodeURIComponent(id)}/reenable`, {}, h)), `${executor.name} re-enabled; it must pass a new self-test`);
        }}
      />
      {pending?.kind === "revoke" && (
        <RevokeDialog
          name={executor.name}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            void run(() => revokeExecutor(id), `${executor.name} revoked`);
          }}
        />
      )}
      <ConfirmModal
        open={pending?.kind === "declared"}
        title={pending?.kind === "declared" && pending.value ? `Map ${executor.name} to ${classText(pending.value)}?` : `Unmap ${executor.name}?`}
        confirmLabel={pending?.kind === "declared" && pending.value ? "Map the declared class" : "Unmap"}
        body={
          pending?.kind === "declared" && pending.value ? (
            <p>
              This relaxes the strict default: the customer plane&apos;s own declaration will satisfy requirements up to {classText(pending.value)}. Its
              evidence still says declared, never verified. You will be asked to confirm it&apos;s you, and the act is audited.
            </p>
          ) : (
            <p>The plane&apos;s declared isolation will satisfy no requirement again (the strict default). The act is audited.</p>
          )
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const p = pending;
          setPending(null);
          if (p?.kind !== "declared") return;
          const body = declaredClassBody(p.value);
          if (!body) return;
          void run(
            () => withStepUp((h) => stepUpApi.put(`/v1/executors/${encodeURIComponent(id)}/declared-class`, body, h)),
            body.class ? `${executor.name} mapped to ${classText(body.class)}` : `${executor.name} unmapped`,
          );
        }}
      />
    </Card>
  );
}

function ActButton(props: { label: string; gate: { ok: true } | { ok: false; reason: string }; busy: boolean; danger?: boolean; onClick: () => void }) {
  const reasonId = useId();
  if (!props.gate.ok)
    return (
      <span className={v.rowTight}>
        <Button size="sm" disabled aria-describedby={reasonId}>
          {props.label}
        </Button>
        <span id={reasonId} className={v.faint}>
          {props.gate.reason}
        </span>
      </span>
    );
  return (
    <Button size="sm" variant={props.danger ? "danger" : undefined} disabled={props.busy} onClick={props.onClick}>
      {props.label}
    </Button>
  );
}

function DeclaredClassForm(props: { executor: Executor; gate: { ok: true } | { ok: false; reason: string }; busy: boolean; onSubmit: (value: string) => void }) {
  const current = props.executor.declaredClass ?? "";
  const [value, setValue] = useState(current);
  const helpId = useId();
  return (
    <form
      className={v.row}
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(value);
      }}
    >
      <Field label="Declared class mapping">
        <Select value={value} disabled={!props.gate.ok} aria-describedby={helpId} onChange={(e) => setValue(e.target.value)}>
          <option value="">Not mapped (strict default)</option>
          {CLASSES.map((c) => (
            <option key={c} value={c}>
              {classText(c)}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={!props.gate.ok || props.busy || value === current}>
        Save mapping
      </Button>
      <span id={helpId} className={v.faint}>
        {props.gate.ok
          ? "A customer plane's isolation is declared, not verified. Unmapped is the strict default; mapping it is a relaxation and needs a step-up."
          : props.gate.reason}
      </span>
    </form>
  );
}
