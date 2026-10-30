/**
 * PM connections (pillar 8) — the customer's PM tool stays the source of
 * truth; RegulAIt links work items, mirrors status and sign-offs out, and
 * records inbound webhook state as drift. The webhook secret is shown exactly
 * once at creation (one-time reveal), stored hashed + encrypted.
 */
import { Suspense, lazy, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { PmConnection } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { RevealCard, useAction, type RevealedSecret } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

/** "30 Oct, 15:10" — the end of a rotation's grace window, in the reader's time */
const graceEnd = (iso: string) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day}, ${time}`;
};


// ADR-0207: the edit, token and rotation dialogs load only when one is opened
const RotateSecretDialog = lazy(() => import("./IntegrationEditDialogs").then((m) => ({ default: m.RotateSecretDialog })));
const EditPmDialog = lazy(() => import("./IntegrationEditDialogs").then((m) => ({ default: m.EditPmDialog })));
const ReplaceTokenDialog = lazy(() => import("./IntegrationEditDialogs").then((m) => ({ default: m.ReplaceTokenDialog })));

const PROVIDERS = [
  { v: "mock", l: "mock (demo — touches nothing real)" },
  { v: "jira", l: "Jira" },
  { v: "azure_devops", l: "Azure DevOps" },
  { v: "linear", l: "Linear" },
  { v: "asana", l: "Asana" },
  { v: "monday", l: "monday.com" },
  { v: "generic_webhook", l: "Generic webhook" },
];

export default function PmConnectionsPage() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "pm-connections"],
    queryFn: () => api.get<{ connections: PmConnection[] }>("/v1/pm/connections"),
  });

  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const [deleting, setDeleting] = useState<PmConnection | null>(null);
  // ADR-0207 (G6): rotate the inbound webhook secret with a 24-hour grace window; edit and replace the token in place
  const [rotating, setRotating] = useState<PmConnection | null>(null);
  const [editing, setEditing] = useState<PmConnection | null>(null);
  const [replacing, setReplacing] = useState<PmConnection | null>(null);
  const [f, setF] = useState({ name: "", provider: "mock", project: "", baseUrl: "", apiVersion: "", token: "" });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const needsBase = ["jira", "azure_devops", "generic_webhook"].includes(f.provider);

  return (
    <>
      <PageHeader
        title="PM connections"
        info={<p>Task graphs and workflow stages map onto the customer's own work items. Users link a run from its detail page; status, sign-offs and decisions mirror out; inbound webhooks record drift, never overwrite the state machine.</p>}
      />
      <div className={v.stack}>
        {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}

        <Card
          title="Add a connection"
          infoLabel="secrets handling"
          info={
            <p>
              Tokens are AES-256-GCM encrypted at rest and never returned. The webhook secret verifies inbound
              traffic with each provider's NATIVE mechanism: HMAC signatures for linear / asana /
              generic_webhook; a ?token= URL parameter for jira and monday (which cannot sign); basic-auth
              password for azure_devops.
            </p>
          }
        >
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(async () => {
                  const created = await api.post<{ name: string; webhookSecret: string }>(
                    "/v1/pm/connections",
                    {
                      name: f.name,
                      provider: f.provider,
                      project: f.project,
                      token: f.token,
                      ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
                      ...(f.apiVersion ? { apiVersion: Number(f.apiVersion) } : {}),
                    },
                  );
                  setReveal({
                    title: `Webhook secret for ${created.name}`,
                    secret: created.webhookSecret,
                    note: `External systems present it when POSTing to ${window.location.origin}/v1/pm/webhooks/${created.name}.`,
                  });
                }, "Connection added — copy the webhook secret above, it is shown once")
                .then((ok) => {
                  if (ok) setF({ name: "", provider: "mock", project: "", baseUrl: "", apiVersion: "", token: "" });
                });
            }}
          >
            <Field label="Name">
              <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="for example demo-pm" />
            </Field>
            <Field
              label="Provider"
              helpLabel="provider kinds"
              help={
                <>
                  Every provider kind is implemented — generic_webhook speaks regulAIt's signed normalized event
                  contract (HMAC-SHA256 in x-regulait-signature) to any HTTP receiver at its base URL. jira,
                  azure_devops and generic_webhook need their base URL. The api version select applies to jira
                  only: v2 (default) sends plain-text descriptions/comments; v3 sends ADF rich text. The demo
                  runs entirely on the mock provider.
                </>
              }
            >
              <Select value={f.provider} onChange={(e) => set("provider", e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p.v} value={p.v}>
                    {p.l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project">
              <Input required value={f.project} onChange={(e) => set("project", e.target.value)} placeholder="for example REGULAIT-DEMO" />
            </Field>
            <Field label={`Base URL${needsBase ? " (required for this provider)" : " (optional)"}`}>
              <Input
                required={needsBase}
                value={f.baseUrl}
                onChange={(e) => set("baseUrl", e.target.value)}
                placeholder="https://<site>.atlassian.net"
              />
            </Field>
            {f.provider === "jira" && (
              <Field label="API version (jira)">
                <Select value={f.apiVersion} onChange={(e) => set("apiVersion", e.target.value)}>
                  <option value="">v2 (default, plain text)</option>
                  <option value="3">v3 + ADF rich text</option>
                  <option value="2">v2 (legacy plain text)</option>
                </Select>
              </Field>
            )}
            <Field label="Token" grow>
              <Input
                required
                type="password"
                value={f.token}
                onChange={(e) => set("token", e.target.value)}
                placeholder="never shown again"
                autoComplete="off"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Add connection
            </Button>
          </form>
          {act.guidance ? (
            <RefusalNotice guidance={act.guidance} />
          ) : (
            act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )
          )}
        </Card>

        <Card flush title="Connections">
          <Table<PmConnection>
            columns={[
              {
                key: "name",
                header: "Name",
                sort: (c) => c.name,
                render: (c) => (
                  <span className={v.row} style={{ gap: "var(--s1)" }}>
                    {c.name}
                    {c.previousSecretValidUntil && new Date(c.previousSecretValidUntil) > new Date() && (
                      <Badge tone="warn">previous secret valid until {graceEnd(c.previousSecretValidUntil)}</Badge>
                    )}
                  </span>
                ),
              },
              {
                key: "provider",
                header: "Provider",
                render: (c) => <Badge tone={c.provider === "mock" ? "neutral" : "info"}>{c.provider}</Badge>,
              },
              { key: "project", header: "Project", render: (c) => c.project },
              { key: "baseUrl", header: "Base URL", render: (c) => c.baseUrl ?? "provider default" },
              { key: "api", header: "API", render: (c) => (c.apiVersion ? `v${c.apiVersion}` : "provider default") },
              {
                key: "webhook",
                header: "Webhook URL",
                render: (c) => <span className={v.mono}>/v1/pm/webhooks/{c.name}</span>,
              },
              { key: "created", header: "Created", render: (c) => ago(c.createdAt) },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (c) => (
                  <RowActions
                    slot="8rem"
                    stacked
                    primary={
                      <Button size="sm" variant="primary" aria-label={`Rotate webhook secret: ${c.name}`} disabled={act.busy} onClick={() => setRotating(c)}>
                        Rotate secret
                      </Button>
                    }
                    secondary={
                      <span className={v.row} style={{ gap: "var(--s1)", flexWrap: "nowrap" }}>
                        <Button size="sm" aria-label={`Edit ${c.name}`} disabled={act.busy} onClick={() => setEditing(c)}>
                          Edit
                        </Button>
                        <Button size="sm" aria-label={`Replace token: ${c.name}`} disabled={act.busy} onClick={() => setReplacing(c)}>
                          Replace token
                        </Button>
                      </span>
                    }
                    rest={
                      <Button size="sm" variant="danger" disabled={act.busy} onClick={() => setDeleting(c)}>
                        Delete connection
                      </Button>
                    }
                  />
                ),
              },
            ]}
            rows={q.data?.connections ?? []}
            rowKey={(c) => c.name}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={
              <EmptyState
                title="No PM connections"
                body="Work items stay the source of truth — connect your PM tool so decisions and sign-offs mirror into it instead of a shadow copy."
              />
            }
          />
        </Card>
      </div>
      <ConfirmModal
        open={deleting !== null}
        title={`Delete PM connection “${deleting?.name}”?`}
        body="Its stored token and inbound webhook secret are destroyed, its work-item links and sync history are removed, and it stops being the alert-ticket connection. Re-creating it mints a new webhook secret, which must be registered again in Jira or Azure DevOps. The removal is recorded in the audit log."
        danger
        confirmLabel="Delete connection"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const c = deleting;
          setDeleting(null);
          if (c)
            void act.run(
              () => api.del(`/v1/pm/connections/${encodeURIComponent(c.name)}`),
              `PM connection “${c.name}” deleted`,
            );
        }}
      />
      <Suspense fallback={null}>
        {rotating && (
          <RotateSecretDialog
            connection={rotating}
            onClose={() => setRotating(null)}
            onRotated={(r) => {
              setRotating(null);
              setReveal(r);
            }}
          />
        )}
        {editing && <EditPmDialog connection={editing} onClose={() => setEditing(null)} />}
        {replacing && <ReplaceTokenDialog kind="pm" connection={replacing} onClose={() => setReplacing(null)} />}
      </Suspense>
    </>
  );
}
