/**
 * Connectors — catalog CRUD (display kind + execution providerKind + per-call
 * price), platform credentials per connector (write-only, with Snowflake's
 * structured-JSON multi-field convention validated at save time), grants
 * (mode + data scope), and the per-user entitlement view.
 */
import { useState } from "react";
import { IntegrationOwnership } from "./IntegrationOwnership";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { Connector, ConnectorCredentialInfo } from "../../../api/adminTypes";
import { ago, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import {
  RemoveButton,
  connectorOpts,
  optionEls,
  useAction,
  useConnectors,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

/**
 * The execution adapters an admin can pick; "" is governance-only (no adapter).
 * A hand-maintained mirror of connector-provider's `CONNECTOR_PROVIDER_KINDS`
 * — the gateway's adr0121 suite pins it against that union AND against the
 * strict egress posture, so a kind this list offers is always one the egress
 * guard can name (AER-015: teams and outlook used to be creatable only by API).
 */
export const PROVIDER_KINDS = ["", "http", "webhook", "slack", "teams", "outlook", "github", "jira", "snowflake", "generic", "mock"];

/**
 * The adapters whose platform credential is a JSON document rather than a bare
 * token, and that document's keys. A hand-maintained mirror of
 * connector-provider's `teamsCredentialSchema` / `outlookCredentialSchema` —
 * the gateway's adr0121 suite pins these keys, and which of them are optional,
 * against the schemas. (Snowflake has its own structured form below.) Without
 * this an admin who picks the teams or outlook adapter sees only a "Token / API
 * key" field, pastes a bare secret, and the save 400s with
 * invalid_connector_credential.
 */
export const JSON_CREDENTIAL_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  teams: { required: ["appId", "appPassword"], optional: ["tenantId", "loginBaseUrl"] },
  outlook: { required: ["appId", "appPassword", "tenantId", "senderUpn"], optional: ["loginBaseUrl"] },
};

/** what an optional key is for — shown beside it in the hint */
const OPTIONAL_KEY_NOTES: Record<string, string> = {
  tenantId: "omit for a multi-tenant bot",
  loginBaseUrl: "sovereign-cloud Entra login host only",
};

/** the JSON a JSON-credential adapter expects, as the field's placeholder; null for a bare-token adapter */
export function credentialJsonTemplate(kind: string | null | undefined): string | null {
  const shape = kind ? JSON_CREDENTIAL_FIELDS[kind] : undefined;
  if (!shape) return null;
  return JSON.stringify(Object.fromEntries(shape.required.map((k) => [k, "…"])), null, 2);
}

/** one sentence naming the document's required and optional keys */
export function credentialJsonHint(kind: string | null | undefined): string | null {
  const shape = kind ? JSON_CREDENTIAL_FIELDS[kind] : undefined;
  if (!shape) return null;
  const optional = shape.optional.map((k) => (OPTIONAL_KEY_NOTES[k] ? `${k} (${OPTIONAL_KEY_NOTES[k]})` : k));
  return (
    `The ${kind} credential is a JSON object, not a bare token: {${shape.required.join(", ")}}` +
    (optional.length ? `; optional: ${optional.join(", ")}` : "") +
    ". The server validates the shape at save time."
  );
}

export default function ConnectorsPage() {
  const connectors = useConnectors();
  const users = useUsers();

  return (
    <>
      <PageHeader
        title="Connectors"
        sub="The connector catalog, decoupled from entitlement — registering one grants nobody anything."
        info={<p>The catalog is decoupled from entitlement. kind is the display category; providerKind is the execution adapter (absent = governance-only). Per-call price feeds pillar 5.</p>}
      />
      <div className={v.stack}>
        <IntegrationOwnership kind="connectors" rows={connectors.data?.connectors ?? []} />
        <Card flush title="Catalog">
          <Table<Connector>
            columns={[
              { key: "name", header: "Name", sort: (c) => c.name, render: (c) => c.name },
              { key: "kind", header: "Kind", sort: (c) => c.kind, render: (c) => c.kind },
              {
                key: "providerKind",
                header: "Adapter",
                render: (c) =>
                  c.providerKind ? <Badge tone="info">{c.providerKind}</Badge> : <Badge>governance-only</Badge>,
              },
              {
                key: "price",
                header: "$/call",
                align: "right",
                render: (c) => (c.pricePerCallUsd == null ? "—" : fmtUsd(c.pricePerCallUsd)),
              },
              { key: "baseUrl", header: "Base URL", render: (c) => c.baseUrl ?? "—" },
              { key: "ownership", header: "Ownership", render: (c) => c.ownership ?? "Not reported" },
            ]}
            rows={connectors.data?.connectors ?? []}
            rowKey={(c) => c.id}
            loading={connectors.isLoading}
            error={connectors.error}
            onRetry={() => void connectors.refetch()}
            empty={<EmptyState title="No connectors" body="Create the first connector below." />}
          />
        </Card>

        <CreateConnectorCard />
        <CredentialCard connectors={connectors.data?.connectors ?? []} />

        <Card title="Grant — mode + data scope">
          <GrantForm connectors={connectors.data?.connectors ?? []} users={users} />
        </Card>

        <EntitlementCard users={users} />
      </div>
    </>
  );
}

function CreateConnectorCard() {
  const act = useAction();
  const [f, setF] = useState({ name: "", kind: "", providerKind: "", baseUrl: "", pricePerCallUsd: "" });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  return (
    <Card title="Create a connector">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post("/v1/connectors", {
                  name: f.name,
                  kind: f.kind,
                  ...(f.providerKind ? { providerKind: f.providerKind } : {}),
                  ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
                  ...(f.pricePerCallUsd ? { pricePerCallUsd: Number(f.pricePerCallUsd) } : {}),
                }),
              "Connector created",
            )
            .then((ok) => ok && setF({ name: "", kind: "", providerKind: "", baseUrl: "", pricePerCallUsd: "" }));
        }}
      >
        <Field label="Name">
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. salesforce" />
        </Field>
        <Field label="Kind (display category)">
          <Input required value={f.kind} onChange={(e) => set("kind", e.target.value)} placeholder="e.g. crm" />
        </Field>
        <Field label="Execution adapter">
          <Select value={f.providerKind} onChange={(e) => set("providerKind", e.target.value)}>
            {PROVIDER_KINDS.map((p) => (
              <option key={p} value={p}>
                {p || "— governance-only —"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base URL (optional)">
          <Input value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Price per call USD (optional)">
          <Input type="number" step="any" value={f.pricePerCallUsd} onChange={(e) => set("pricePerCallUsd", e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Create
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
    </Card>
  );
}

// ---- platform credential (write-only; snowflake structured JSON) ----------

function CredentialCard(props: { connectors: Connector[] }) {
  const act = useAction();
  const [connectorId, setConnectorId] = useState("");
  const selected = props.connectors.find((c) => c.id === connectorId) ?? null;
  const isSnowflake = selected?.providerKind === "snowflake";
  const jsonTemplate = credentialJsonTemplate(selected?.providerKind);

  const cred = useQuery({
    queryKey: ["admin", "connector-credential", connectorId],
    queryFn: () => api.get<ConnectorCredentialInfo>(`/v1/connectors/${connectorId}/credential`),
    enabled: Boolean(connectorId),
  });

  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sf, setSf] = useState({ account: "", user: "", privateKey: "", passphrase: "" });
  const setSfF = (k: keyof typeof sf, val: string) => setSf((s) => ({ ...s, [k]: val }));
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <Card title="Platform credential — write-only, per connector">
      <div className={a.formRow}>
        <Field label="Connector" grow>
          <Select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            {optionEls(connectorOpts(props.connectors), "— select a connector —")}
          </Select>
        </Field>
      </div>
      {selected && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          <div className={v.row}>
            {cred.data?.credential ? (
              <>
                <Badge tone="ok">credential configured</Badge>
                <span className={v.dim}>
                  since {ago(cred.data.credential.createdAt)} · base URL{" "}
                  {cred.data.credential.baseUrl ?? "provider default"}
                </span>
                <span className={v.grow} />
                <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)}>
                  remove
                </Button>
              </>
            ) : (
              <Badge tone="warn">no credential — governed invokes that need one will fail</Badge>
            )}
          </div>
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              const body = isSnowflake
                ? JSON.stringify({
                    account: sf.account,
                    user: sf.user,
                    privateKey: sf.privateKey,
                    ...(sf.passphrase ? { passphrase: sf.passphrase } : {}),
                  })
                : token;
              void act
                .run(
                  () =>
                    api.post(`/v1/connectors/${connectorId}/credential`, {
                      token: body,
                      ...(baseUrl ? { baseUrl } : {}),
                    }),
                  "Credential saved (encrypted at rest, never returned)",
                )
                .then((ok) => {
                  if (ok) {
                    setToken("");
                    setSf({ account: "", user: "", privateKey: "", passphrase: "" });
                  }
                });
            }}
          >
            {isSnowflake ? (
              <>
                <div className={a.formRow}>
                  <Field label="Account">
                    <Input required value={sf.account} onChange={(e) => setSfF("account", e.target.value)} placeholder="xy12345.eu-west-1" />
                  </Field>
                  <Field label="User">
                    <Input required value={sf.user} onChange={(e) => setSfF("user", e.target.value)} />
                  </Field>
                  <Field label="Key passphrase (optional)">
                    <Input type="password" value={sf.passphrase} onChange={(e) => setSfF("passphrase", e.target.value)} autoComplete="off" />
                  </Field>
                </div>
                <Field label="Private key (PEM)">
                  <Textarea
                    required
                    rows={5}
                    value={sf.privateKey}
                    onChange={(e) => setSfF("privateKey", e.target.value)}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                  />
                </Field>
                <p className={v.faint}>
                  Snowflake credentials are multi-field: this form assembles the {"{account, user, privateKey, passphrase?}"}{" "}
                  structured JSON the adapter expects and the server validates the shape at save time — a
                  malformed credential 400s here with an actionable message instead of failing opaquely at
                  first invoke.
                </p>
              </>
            ) : jsonTemplate ? (
              <>
                <Field label="Credential (JSON — never shown again)">
                  <Textarea
                    required
                    rows={6}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={jsonTemplate}
                    autoComplete="off"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                  />
                </Field>
                <p className={v.faint}>{credentialJsonHint(selected?.providerKind)}</p>
              </>
            ) : (
              <Field label="Token / API key">
                <Input
                  required
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="never shown again"
                  autoComplete="off"
                />
              </Field>
            )}
            <div className={a.formRow}>
              <Field label="Base URL (optional)" grow>
                <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </Field>
              <Button type="submit" variant="primary" disabled={act.busy}>
                {cred.data?.credential ? "Rotate credential" : "Save credential"}
              </Button>
            </div>
            {act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )}
          </form>
        </div>
      )}
      <ConfirmModal
        open={confirmRemove}
        title="Remove this connector's credential?"
        body="Governed invokes that need it start failing until a new one is saved."
        danger
        confirmLabel="Remove"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void act.run(() => api.del(`/v1/connectors/${connectorId}/credential`), "Credential removed");
        }}
      />
    </Card>
  );
}

function GrantForm(props: { connectors: Connector[]; users: ReturnType<typeof useUsers> }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [connectorId, setConnectorId] = useState("");
  const [mode, setMode] = useState("read");
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(
          () => api.post("/v1/grants/connectors", { userId, connectorId, mode }),
          "Connector granted",
        );
      }}
    >
      <Field label="User">
        <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          {optionEls(userOpts(props.users.data?.users), "— select —")}
        </Select>
      </Field>
      <Field label="Connector">
        <Select required value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
          {optionEls(connectorOpts(props.connectors), "— select —")}
        </Select>
      </Field>
      <Field label="Mode">
        <Select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="read">read</option>
          <option value="readwrite">readwrite</option>
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Grant
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

function EntitlementCard(props: { users: ReturnType<typeof useUsers> }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [rows, setRows] = useState<Array<Record<string, unknown>> | null>(null);
  return (
    <Card title="Per-user entitlement">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.get<{ connectors: Array<Record<string, unknown>> }>(
              `/v1/users/${userId}/connectors`,
            );
            setRows(r.connectors);
          }, null);
        }}
      >
        <Field label="User" grow>
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            {optionEls(userOpts(props.users.data?.users), "— select —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          View
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {rows && (
        <Table
          columns={[
            { key: "name", header: "Connector", render: (r: Record<string, unknown>) => String(r.name ?? "—") },
            { key: "kind", header: "Kind", render: (r) => String(r.kind ?? "—") },
            { key: "mode", header: "Mode", render: (r) => String(r.mode ?? "—") },
            {
              key: "objects",
              header: "Objects",
              render: (r) => (Array.isArray(r.allowedObjects) ? r.allowedObjects.join(", ") : "all"),
            },
            {
              key: "source",
              header: "Via",
              render: (r) =>
                r.source === "role" ? (
                  <Badge tone="info">
                    role{Array.isArray(r.roles) && r.roles.length ? `: ${r.roles.join(", ")}` : ""}
                  </Badge>
                ) : (
                  <Badge tone="ok">direct</Badge>
                ),
            },
            {
              key: "revoked",
              header: "",
              render: (r) => (r.revoked ? <Badge tone="danger">revoked</Badge> : null),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              render: (r) => (
                <RemoveButton
                  what={`${String(r.name ?? "connector")} from this user`}
                  disabledReason={
                    r.source === "role"
                      ? `granted by role ${Array.isArray(r.roles) ? r.roles.join(", ") : ""} — remove it there, or add a per-user revocation on the Users page`
                      : undefined
                  }
                  consequence={
                    <p>
                      The direct grant is deleted, so the next call this user makes through{" "}
                      <strong>{String(r.name ?? "this connector")}</strong> is refused by
                      default-deny. Nothing already audited changes, and the removal is itself
                      audited.
                    </p>
                  }
                  onRemove={() => api.del(`/v1/grants/connectors/${String(r.grantId)}`)}
                  onDone={() => {
                    void act.run(async () => {
                      const again = await api.get<{ connectors: Array<Record<string, unknown>> }>(
                        `/v1/users/${userId}/connectors`,
                      );
                      setRows(again.connectors);
                    }, null);
                  }}
                />
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => String(r.connectorId ?? r.name)}
          empty={<EmptyState title="No entitled connectors" />}
        />
      )}
    </Card>
  );
}
