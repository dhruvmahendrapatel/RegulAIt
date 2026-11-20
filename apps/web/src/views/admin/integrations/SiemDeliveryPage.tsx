/**
 * ADR-0303 — SIEM delivery of the audit chain: the admin page for SIEM destinations.
 *
 *  - The list shows each destination's state (off, delivering, retrying, stopped after failures), how far behind it is
 *    (`lag`: audit rows not yet acknowledged), and the last error as a plain sentence (the gateway keeps only a code).
 *  - A new destination is created OFF. Its signing secret is shown once, from the answer that minted it; it is never
 *    put in the query cache or storage.
 *  - Turning one on is a relaxation and asks the admin to confirm it is them (step-up); turning it off does not.
 *    Rotating the secret asks too. Recovering a stopped or retrying destination does not, and is audited.
 *  - Every action says why it is unavailable when it is.
 *
 * The rules are in `siemDestinationsModel.ts`. A URL cannot be changed: a new URL is a new destination.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { RevealCard, useAction, type RevealedSecret } from "../adminKit";
import { withRefusalCopy } from "../governance/refusalCopy";
import {
  createBody,
  createProblems,
  deliveryState,
  EMPTY_DRAFT,
  errorText,
  rowActions,
  SIEM_REFUSALS,
  SIEM_STORED_NOTE,
  type CreateDraft,
  type SiemDestination,
  type SiemList,
} from "./siemDestinationsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "siem-destinations"] as const;

export default function SiemDeliveryPage() {
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<SiemList>("/v1/siem/destinations") });
  const act = useAction();
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
  const [tried, setTried] = useState(false);
  const [enableFor, setEnableFor] = useState<SiemDestination | null>(null);
  const [rotateFor, setRotateFor] = useState<SiemDestination | null>(null);
  const problems = createProblems(draft);
  const shown = tried ? problems : {};
  const refetch = () => list.refetch();
  const showSecret = (d: SiemDestination, secret: string | null) => {
    if (secret) setReveal({ title: `Signing secret for ${d.name}`, secret, stored: SIEM_STORED_NOTE });
  };
  const run = (fn: () => Promise<unknown>, ok: string) => void act.run(() => withRefusalCopy(fn, SIEM_REFUSALS), ok).then((done) => done && void refetch());

  const create = () => {
    setTried(true);
    if (Object.keys(problems).length > 0 || act.busy) return;
    const body = createBody(draft);
    run(async () => {
      const out = await api.post<{ destination: SiemDestination; secret: string | null }>("/v1/siem/destinations", body);
      setDraft(EMPTY_DRAFT);
      setTried(false);
      showSecret(out.destination, out.secret);
    }, `Destination ${body.name} added. It is off until you turn it on.`);
  };
  const setEnabled = (d: SiemDestination, enabled: boolean) =>
    run(
      () => withStepUp((h) => stepUpApi.put(`/v1/siem/destinations/${d.id}/enabled`, { enabled }, h)),
      enabled ? `${d.name} is on. Delivery starts from its cursor.` : `${d.name} is off. Its cursor is kept.`,
    );
  const rotate = (d: SiemDestination) =>
    run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<{ destination: SiemDestination; secret: string | null }>(`/v1/siem/destinations/${d.id}/rotate-secret`, {}, h));
      showSecret(out.destination, out.secret);
    }, `New signing secret for ${d.name}. Give it to the receiver now; the old one stops working.`);
  const recover = (d: SiemDestination) => run(() => api.post(`/v1/siem/destinations/${d.id}/recover`, {}), `${d.name} is back to delivery now.`);

  return (
    <>
      <PageHeader
        title="SIEM delivery"
        sub="Send the hash-chained audit log to your SIEM, signed, in order, and at least once."
        info={
          <p>
            Each destination gets batches of audit events, signed with Standard Webhooks. Its cursor moves only when your
            receiver answers 2xx, so nothing is skipped; a failure resends the same batch. Only an allow-listed set of fields
            is sent{list.data?.envelope?.fields?.length ? ` (${list.data.envelope.fields.join(", ")})` : ""}. The receiver's
            host must be on the egress allow-list.
          </p>
        }
      />
      <div className={v.stack}>
        {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />

        <Card title="Destinations" count={list.data?.destinations.length}>
          <Table<SiemDestination>
            rows={list.data?.destinations}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void refetch()}
            rowKey={(d) => d.id}
            empty={<EmptyState title="No SIEM destination yet" body="Add one below. It starts off, so nothing is sent until you turn it on." />}
            columns={[
              {
                key: "name",
                header: "Destination",
                render: (d) => (
                  <>
                    <div>{d.name}</div>
                    <div className={v.faint}>
                      {d.kind} · {d.url}
                    </div>
                  </>
                ),
              },
              {
                key: "state",
                header: "Delivery",
                render: (d) => {
                  const st = deliveryState(d);
                  const err = errorText(d.lastErrorCode);
                  return (
                    <>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {err && d.state !== "active" ? <div className={v.faint}>{err}</div> : null}
                      {d.state === "backoff" && d.nextAttemptAt ? <div className={v.faint}>next try {ago(d.nextAttemptAt)}</div> : null}
                    </>
                  );
                },
              },
              {
                key: "lag",
                header: "Behind",
                align: "right",
                render: (d) => (
                  <>
                    <span className={v.num}>{d.lag.toLocaleString("en-US")}</span>
                    <div className={v.faint}>{d.lastSuccessAt ? `last delivered ${ago(d.lastSuccessAt)}` : "nothing delivered yet"}</div>
                  </>
                ),
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (d) => {
                  const why = rowActions(d);
                  return (
                    <RowActions
                      primary={
                        d.enabled ? (
                          <Button size="sm" aria-label={`Turn off ${d.name}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setEnabled(d, false)}>
                            Turn off
                          </Button>
                        ) : (
                          <Button size="sm" variant="primary" aria-label={`Turn on ${d.name}`} aria-disabled={act.busy || undefined} onClick={() => !act.busy && setEnableFor(d)}>
                            Turn on
                          </Button>
                        )
                      }
                      secondary={
                        <Button size="sm" aria-label={`Recover ${d.name}`} disabled={why.recover !== null || act.busy} title={why.recover ?? undefined} onClick={() => recover(d)}>
                          Recover
                        </Button>
                      }
                      rest={
                        <Button size="sm" variant="ghost" aria-label={`Rotate the secret of ${d.name}`} disabled={why.rotate !== null || act.busy} title={why.rotate ?? undefined} onClick={() => setRotateFor(d)}>
                          Rotate secret
                        </Button>
                      }
                    />
                  );
                },
              },
            ]}
          />
        </Card>

        <Card title="Add a destination">
          <form
            className={v.stack}
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <div className={a.formRow}>
              <Field label="Name" error={shown.name}>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="splunk-hec" />
              </Field>
              <Field label="Receiver URL" grow error={shown.url} help="The host must be on the egress allow-list. A URL cannot be changed later; a new URL is a new destination.">
                <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://siem.example.internal/regulait" />
              </Field>
              <Field label="Start from">
                <Select value={draft.startFrom} onChange={(e) => setDraft({ ...draft, startFrom: e.target.value as CreateDraft["startFrom"] })}>
                  <option value="now">Now (new events only)</option>
                  <option value="beginning">The beginning of the audit log</option>
                </Select>
              </Field>
            </div>
            <label className={v.rowTight}>
              <input type="checkbox" checked={draft.allowPlaintextHttp} onChange={(e) => setDraft({ ...draft, allowPlaintextHttp: e.target.checked })} />
              <span>Allow plain http (only for a receiver inside your own network; the allow-list entry must allow it too)</span>
            </label>
            <div className={v.row}>
              <Button type="submit" variant="primary" disabled={act.busy}>
                Add destination
              </Button>
              <span className={v.faint}>It is added off. Nothing is sent until you turn it on.</span>
            </div>
          </form>
        </Card>
      </div>

      <ConfirmModal
        open={enableFor !== null}
        title={enableFor ? `Turn on ${enableFor.name}?` : "Turn on this destination?"}
        body={
          <p>
            Audit events start leaving this deployment for {enableFor?.url}, from its cursor. Turning it on is recorded in the
            audit trail, and you will be asked to confirm it is you.
          </p>
        }
        confirmLabel="Turn on"
        onConfirm={() => {
          const d = enableFor;
          setEnableFor(null);
          if (d) setEnabled(d, true);
        }}
        onCancel={() => setEnableFor(null)}
      />
      <ConfirmModal
        open={rotateFor !== null}
        danger
        title={rotateFor ? `Rotate the signing secret of ${rotateFor.name}?` : "Rotate the signing secret?"}
        body={<p>The old secret stops working at once, so the receiver must get the new one. You will be asked to confirm it is you.</p>}
        confirmLabel="Rotate secret"
        onConfirm={() => {
          const d = rotateFor;
          setRotateFor(null);
          if (d) rotate(d);
        }}
        onCancel={() => setRotateFor(null)}
      />
    </>
  );
}
