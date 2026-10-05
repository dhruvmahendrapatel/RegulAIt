/**
 * ADR-0173 batch 2b — outbound webhooks: what leaves this deployment, to
 * where, and whether it arrived. Admin-only.
 *
 *  1. A SUBSCRIPTION names a URL and the events it wants (exact events, or a
 *     whole family so later events of that family reach it too). The URL is a
 *     destination under the egress guard — its host must be on the egress
 *     allow-list, exactly like a custom provider or an external scorer.
 *  2. SIGNING follows the Standard Webhooks specification: each delivery
 *     carries `webhook-id`, `webhook-timestamp` and `webhook-signature`
 *     under the subscription's `whsec_` secret, so any off-the-shelf verifier
 *     works. The secret is shown ONCE, at creation and on rotation, and is
 *     stored encrypted under the deployment's data key.
 *  3. THE DELIVERY LOG is the evidence: every attempt's status, response code
 *     and error, retried with backoff by the scheduler until delivered or out
 *     of attempts. A failed delivery can be requeued.
 *  4. PAYLOADS carry ids, names, hashes, actor ids and timestamps — never a
 *     prompt's text and never a secret.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate, RemoveButton, useAction, useEgressAllowHosts } from "../adminKit";
import { selectorCovers, webhookSelectors } from "../../builder/promptsLogic";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface WebhookEvent {
  name: string;
  family: string;
  description: string;
  fields: string[];
}
interface EventsResponse {
  families: string[];
  events: WebhookEvent[];
  signing: { scheme: string; headers: string[]; note: string };
}
interface Subscription {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  allowPlaintextHttp: boolean;
  createdByUserId: string | null;
  secretRotatedAt: string;
  createdAt: string;
  updatedAt: string;
  lastDelivery: { status: DeliveryStatus; at: string } | null;
  pendingDeliveries: number;
  failedDeliveries: number;
}
type DeliveryStatus = "pending" | "delivered" | "failed";
interface Delivery {
  id: string;
  subscriptionId: string;
  event: string;
  messageId: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastAttemptAt: string | null;
  responseCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

const KEYS = {
  subs: ["admin", "webhooks"] as const,
  events: ["admin", "webhook-events"] as const,
  deliveries: (id: string) => ["admin", "webhook-deliveries", id] as const,
};

/** a checkbox row tall enough, and a box large enough, for a 24px touch target (WCAG 2.5.8) */
const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;

const STATUS_TONE: Record<DeliveryStatus, "ok" | "warn" | "danger"> = { delivered: "ok", pending: "warn", failed: "danger" };

/** the event checkboxes: one fieldset per family, with "every event, including future ones" */
function EventPicker(props: {
  catalog: EventsResponse;
  checked: string[];
  onChecked: (next: string[]) => void;
  families: string[];
  onFamilies: (next: string[]) => void;
  idPrefix: string;
}) {
  return (
    <>
      {props.catalog.families.map((fam) => {
        const whole = props.families.includes(fam);
        const events = props.catalog.events.filter((e) => e.family === fam);
        return (
          <fieldset key={fam} style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className={v.faint}>
              <code>{fam}.*</code> events
            </legend>
            <div style={ROW}>
              <input
                type="checkbox"
                style={BOX}
                id={`${props.idPrefix}-fam-${fam}`}
                checked={whole}
                onChange={() => props.onFamilies(whole ? props.families.filter((f) => f !== fam) : [...props.families, fam])}
              />
              <label htmlFor={`${props.idPrefix}-fam-${fam}`}>Every {fam} event, including ones added later</label>
            </div>
            {events.map((e) => (
              <div key={e.name} style={{ ...ROW, paddingLeft: "var(--s3)" }}>
                <input
                  type="checkbox"
                  style={BOX}
                  id={`${props.idPrefix}-ev-${e.name}`}
                  checked={whole || props.checked.includes(e.name)}
                  disabled={whole}
                  onChange={() => props.onChecked(props.checked.includes(e.name) ? props.checked.filter((x) => x !== e.name) : [...props.checked, e.name])}
                />
                <label htmlFor={`${props.idPrefix}-ev-${e.name}`}>
                  <code>{e.name}</code> <span className={v.faint}>— {e.description}</span>
                </label>
              </div>
            ))}
          </fieldset>
        );
      })}
    </>
  );
}

/** the secret, once — it is stored encrypted and never shown again */
function SecretReveal(props: { name: string; secret: string; onDismiss: () => void }) {
  const { toast } = useToast();
  return (
    <Card>
      <div className={v.stack}>
        <div className={v.row}>
          <strong>Signing secret for {props.name}</strong>
          <Badge tone="warn">shown once</Badge>
          <span className={v.grow} />
          <Button size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
        <div className={a.secretRow}>
          <code className={a.secretCode} data-testid="webhook-secret">
            {props.secret}
          </code>
          <Button
            size="sm"
            onClick={() =>
              void navigator.clipboard.writeText(props.secret).then(
                () => toast("Copied", "success"),
                () => toast("Clipboard unavailable — select the text manually", "error"),
              )
            }
          >
            Copy
          </Button>
        </div>
        <div className={v.faint}>
          Give this to the receiver to verify signatures with any Standard Webhooks library. It is stored encrypted under this deployment&apos;s data key
          and is not shown again; rotate it to get a new one.
        </div>
      </div>
    </Card>
  );
}

function DeliveriesModal(props: { sub: Subscription | null; onClose: () => void }) {
  const act = useAction();
  const deliveries = useQuery({
    queryKey: KEYS.deliveries(props.sub?.id ?? ""),
    queryFn: () => api.get<{ deliveries: Delivery[] }>(`/v1/webhooks/${props.sub!.id}/deliveries?limit=50`),
    enabled: !!props.sub,
  });
  return (
    <Modal open={props.sub !== null} title={`Deliveries — ${props.sub?.name ?? ""}`} onClose={props.onClose} wide actions={<Button onClick={props.onClose}>Close</Button>}>
      <QueryGate loading={deliveries.isLoading} error={deliveries.error} onRetry={() => void deliveries.refetch()}>
        <Table
          rows={deliveries.data?.deliveries ?? []}
          rowKey={(r) => r.id}
          empty={<EmptyState title="Nothing sent yet" body="Deliveries appear here when a subscribed event happens or a test is sent." />}
          columns={[
            { key: "event", header: "Event", render: (r) => <code>{r.event}</code> },
            { key: "status", header: "Status", render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
            { key: "attempts", header: "Attempts", render: (r) => `${r.attempts} of ${r.maxAttempts}` },
            { key: "code", header: "Response", render: (r) => (r.responseCode ?? "—") },
            {
              key: "when",
              header: "When",
              render: (r) =>
                r.status === "pending" && r.nextRetryAt ? `next try ${ago(r.nextRetryAt)}` : r.lastAttemptAt ? `last try ${ago(r.lastAttemptAt)}` : ago(r.createdAt),
            },
            { key: "error", header: "Error", render: (r) => <span className={v.faint}>{r.lastError ?? ""}</span> },
            {
              key: "actions",
              header: "",
              render: (r) =>
                r.status === "failed" && r.event !== "webhook.test" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={act.busy}
                    aria-label={`Retry delivery of ${r.event}`}
                    onClick={() => void act.run(() => api.post(`/v1/webhooks/deliveries/${r.id}/retry`, {}), `Delivery of ${r.event} requeued`).then(() => deliveries.refetch())}
                  >
                    Retry
                  </Button>
                ) : null,
            },
          ]}
        />
      </QueryGate>
    </Modal>
  );
}

function EditModal(props: { sub: Subscription | null; catalog: EventsResponse | undefined; onClose: () => void }) {
  const act = useAction();
  const sub = props.sub;
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [lastId, setLastId] = useState<string | null>(null);
  if (sub && sub.id !== lastId) {
    setLastId(sub.id);
    setName(sub.name);
    setUrl(sub.url);
    setFamilies(sub.events.filter((e) => e.endsWith(".*")).map((e) => e.slice(0, -2)));
    setChecked(sub.events.filter((e) => !e.endsWith(".*")));
  }
  const selectors = webhookSelectors(checked, families);
  const close = () => {
    setLastId(null);
    props.onClose();
  };
  return (
    <Modal
      open={sub !== null}
      title={`Edit ${sub?.name ?? "webhook"}`}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || selectors.length === 0 || !name.trim() || !url.trim()}
            onClick={() =>
              void act
                .run(
                  () => api.patch(`/v1/webhooks/${sub!.id}`, { ...(name !== sub!.name ? { name } : {}), ...(url !== sub!.url ? { url } : {}), events: selectors }),
                  `Webhook ${name} saved`,
                )
                .then((ok) => {
                  if (ok) close();
                })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <Field label="Endpoint URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      {props.catalog && <EventPicker catalog={props.catalog} checked={checked} onChecked={setChecked} families={families} onFamilies={setFamilies} idPrefix="wh-edit" />}
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
    </Modal>
  );
}

export default function WebhooksPage() {
  const subs = useQuery({ queryKey: KEYS.subs, queryFn: () => api.get<{ subscriptions: Subscription[] }>("/v1/webhooks") });
  const catalog = useQuery({ queryKey: KEYS.events, queryFn: () => api.get<EventsResponse>("/v1/webhooks/events") });
  const hosts = useEgressAllowHosts();
  const act = useAction();
  const [reveal, setReveal] = useState<{ name: string; secret: string } | null>(null);
  const [viewing, setViewing] = useState<Subscription | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [families, setFamilies] = useState<string[]>([]);
  const [plaintext, setPlaintext] = useState(false);
  const selectors = useMemo(() => webhookSelectors(checked, families), [checked, families]);
  const refetch = () => void subs.refetch();

  return (
    <>
      <PageHeader
        title="Webhooks"
        sub="Signed notifications to your own systems when governed things change."
        info={
          <p>
            A webhook sends a signed POST to a URL you choose when a subscribed event happens — a prompt commit, a tag move, a promotion requested or
            decided. Deliveries go through the egress guard, are logged with their outcome, and are retried with backoff by the scheduler.
          </p>
        }
      />
      <div className={v.stack}>
        {reveal && <SecretReveal name={reveal.name} secret={reveal.secret} onDismiss={() => setReveal(null)} />}
        <Card title="How deliveries are signed and what they carry">
          <p className={v.faint}>
            Signing follows the <strong>Standard Webhooks</strong> specification: each delivery carries <code>webhook-id</code> (the same on every retry,
            so a receiver can drop duplicates), <code>webhook-timestamp</code> and <code>webhook-signature</code>, an HMAC-SHA256 under the
            subscription&apos;s <code>whsec_</code> secret. The body is <code>{"{type, timestamp, data}"}</code>, and <code>data</code> holds only ids,
            names, hashes, the acting person&apos;s id and times — never a prompt&apos;s text and never a secret.
          </p>
        </Card>
        <QueryGate loading={subs.isLoading || catalog.isLoading} error={subs.error ?? catalog.error} onRetry={() => void Promise.all([subs.refetch(), catalog.refetch()])}>
          <Card title="Add a webhook">
            <p className={v.faint}>
              The URL&apos;s host must be on the egress allow-list (managed on the Custom LLM providers page); private addresses and plaintext http are
              opt-ins there.
              {(hosts.data?.hosts ?? []).length === 0 && <> The allow-list is empty, so no endpoint is reachable yet.</>}
            </p>
            <form
              className={v.stack}
              onSubmit={(e) => {
                e.preventDefault();
                void act
                  .run(async () => {
                    const res = await api.post<Subscription & { secret: string }>("/v1/webhooks", {
                      name,
                      url,
                      events: selectors,
                      ...(plaintext ? { allowPlaintextHttp: true } : {}),
                    });
                    setReveal({ name: res.name, secret: res.secret });
                  }, `Webhook ${name} added — copy its signing secret now`)
                  .then((ok) => {
                    if (ok) {
                      setName("");
                      setUrl("");
                      setChecked([]);
                      setFamilies([]);
                      setPlaintext(false);
                      refetch();
                    }
                  });
              }}
            >
              <div className={a.formRow}>
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="release-notifier" maxLength={80} required />
                </Field>
                <Field label="Endpoint URL" grow>
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.internal/regulait" required />
                </Field>
              </div>
              {catalog.data && (
                <EventPicker catalog={catalog.data} checked={checked} onChecked={setChecked} families={families} onFamilies={setFamilies} idPrefix="wh-new" />
              )}
              <div style={ROW}>
                <input type="checkbox" style={BOX} id="wh-plaintext" checked={plaintext} onChange={(e) => setPlaintext(e.target.checked)} />
                <label htmlFor="wh-plaintext" className={v.faint}>
                  Plaintext http — this webhook&apos;s half of the opt-in; the allow-list entry must opt in too
                </label>
              </div>
              <div>
                <Button type="submit" variant="primary" disabled={act.busy || selectors.length === 0}>
                  Add webhook
                </Button>
              </div>
            </form>
            {act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )}
          </Card>

          <Card
            title="Webhooks"
            actions={
              <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => void act.run(async () => {
                const r = await api.post<{ due: number; delivered: number; retrying: number; failed: number }>("/v1/webhooks/sweep", {});
                refetch();
                return `Retry pass: ${r.due} due, ${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} gave up`;
              })}>
                Run the retry pass now
              </Button>
            }
          >
            {(subs.data?.subscriptions ?? []).length === 0 ? (
              <EmptyState title="No webhooks" body="Nothing leaves this deployment as a webhook until you add one." />
            ) : (
              <Table
                rows={subs.data?.subscriptions ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "name", header: "Name", render: (r) => <strong>{r.name}</strong> },
                  { key: "url", header: "Endpoint", render: (r) => <code>{r.url}</code> },
                  {
                    key: "events",
                    header: "Events",
                    render: (r) => (
                      <span className={v.faint}>
                        {r.events.join(", ")}
                        {catalog.data ? ` (${catalog.data.events.filter((e) => selectorCovers(r.events, e.name)).length} now)` : ""}
                      </span>
                    ),
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (r) => (
                      <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                        <Badge tone={r.active ? "ok" : "neutral"}>{r.active ? "active" : "paused"}</Badge>
                        {r.lastDelivery && <Badge tone={STATUS_TONE[r.lastDelivery.status]}>last {r.lastDelivery.status} {ago(r.lastDelivery.at)}</Badge>}
                        {r.failedDeliveries > 0 && <Badge tone="danger">{r.failedDeliveries} failed</Badge>}
                        {r.pendingDeliveries > 0 && <Badge tone="warn">{r.pendingDeliveries} retrying</Badge>}
                      </span>
                    ),
                  },
                  {
                    key: "actions",
                    header: "",
                    render: (r) => (
                      <div className={v.row}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          aria-label={`Send a test to ${r.name}`}
                          onClick={() =>
                            void act.run(async () => {
                              const out = await api.post<{ ok: boolean; responseCode: number | null; error: string | null }>(`/v1/webhooks/${r.id}/test`, {});
                              refetch();
                              if (!out.ok) throw new Error(`Test to ${r.name} failed: ${out.error ?? "no answer"}`);
                              return `Test delivered to ${r.name} (HTTP ${out.responseCode})`;
                            })
                          }
                        >
                          Test
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Deliveries of ${r.name}`} onClick={() => setViewing(r)}>
                          Deliveries
                        </Button>
                        <Button size="sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          aria-label={`${r.active ? "Pause" : "Resume"} ${r.name}`}
                          onClick={() =>
                            void act.run(() => api.patch(`/v1/webhooks/${r.id}`, { active: !r.active }), r.active ? `${r.name} paused` : `${r.name} resumed`).then(refetch)
                          }
                        >
                          {r.active ? "Pause" : "Resume"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          aria-label={`Rotate the secret of ${r.name}`}
                          onClick={() =>
                            void act.run(async () => {
                              const res = await api.post<{ name: string; secret: string }>(`/v1/webhooks/${r.id}/rotate-secret`, {});
                              setReveal({ name: res.name, secret: res.secret });
                            }, `Secret of ${r.name} rotated — copy the new one now`)
                          }
                        >
                          Rotate secret
                        </Button>
                        <RemoveButton
                          what={`webhook ${r.name}`}
                          consequence="Nothing more is sent to it, and its delivery log is deleted with it. The audit log keeps the record."
                          onRemove={() => api.del(`/v1/webhooks/${r.id}`)}
                          onDone={refetch}
                        />
                      </div>
                    ),
                  },
                ]}
              />
            )}
            <p className={v.faint}>
              A delivery that fails is retried with exponential backoff by the scheduler&apos;s webhook job, up to its attempt limit, and then marked
              failed and audited. A paused webhook receives nothing.
            </p>
          </Card>
        </QueryGate>
      </div>
      <DeliveriesModal sub={viewing} onClose={() => setViewing(null)} />
      <EditModal sub={editing} catalog={catalog.data} onClose={() => { setEditing(null); refetch(); }} />
    </>
  );
}
