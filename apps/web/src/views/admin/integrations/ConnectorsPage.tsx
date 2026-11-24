/**
 * Connectors — catalog CRUD (display kind + execution providerKind + per-call
 * price), platform credentials per connector (write-only, with Snowflake's
 * structured-JSON multi-field convention validated at save time), grants
 * (mode + data scope), and the per-user entitlement view.
 */
import { useState } from "react";
import { IntegrationOwnership } from "./IntegrationOwnership";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import type { Connector, ConnectorCredentialInfo } from "../../../api/adminTypes";
import { ago, errorText, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, ErrorState, Field, Input, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import {
  RemoveButton,
  connectorOpts,
  optionEls,
  useAction,
  useConnectors,
  useUsers,
  userOpts,
} from "../adminKit";
import { DisabledBadge, countsText, useLifecycle } from "./LifecycleActions";
import a from "../admin.module.css";
import v from "../../views.module.css";

/**
 * The execution adapters an admin can pick; "" is governance-only (no adapter).
 * A hand-maintained mirror of connector-provider's `CONNECTOR_PROVIDER_KINDS`
 * — the gateway's adr0121 suite pins it against that union AND against the
 * strict egress posture, so a kind this list offers is always one the egress
 * guard can name (AER-015: teams and outlook used to be creatable only by API).
 */
// ADR-0255: the piece_* kinds are the curated connector-catalogue pieces; creating one needs the piece enabled first,
// on the connector catalogue page (ConnectorCataloguePage, linked from this page's header)
export const PROVIDER_KINDS = [
  "", "http", "webhook", "slack", "teams", "outlook", "resend", "github", "jira", "snowflake", "generic", "mock",
  "piece_slack", "piece_jira_cloud", "piece_github", "piece_google_sheets", "piece_gmail",
];

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
  resend: { required: ["apiKey", "from"], optional: ["fromName"] },
  // ADR-0255 catalogue pieces whose credential is a document (connector-provider pieces.ts jira/google schemas);
  // piece_slack and piece_github take a bare token
  piece_jira_cloud: { required: ["siteUrl", "email", "apiToken"], optional: [] },
  piece_google_sheets: { required: ["clientId", "clientSecret", "refreshToken"], optional: [] },
  piece_gmail: { required: ["clientId", "clientSecret", "refreshToken"], optional: [] },
};

/**
 * A curated catalogue piece (ADR-0255): it reaches only its vendor's API, and the gateway refuses every call that
 * carries a base URL override (`piece_base_url_refused`), so its form offers none and sends none.
 */
export const isPieceKind = (kind: string | null | undefined): boolean => Boolean(kind?.startsWith("piece_"));

/** a hint for a bare-token adapter whose token has a fixed shape; null when the token is opaque */
export function credentialTokenHint(kind: string | null | undefined): string | null {
  if (kind === "jira") return "The jira credential is email:api_token (the account email, a colon, then the API token).";
  return null;
}

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
  // ADR-0207 (G3): Disable (reason) → Delete; Enable is stepped up
  const life = useLifecycle({
    noun: "connector",
    disable: (id, reason) => api.post(`/v1/connectors/${encodeURIComponent(id)}/enabled`, { enabled: false, reason }),
    enable: (id, h) => stepUpApi.post(`/v1/connectors/${encodeURIComponent(id)}/enabled`, { enabled: true }, h),
    remove: (id) => api.del(`/v1/connectors/${encodeURIComponent(id)}`),
    disableBody:
      "Every governed call to this connector is refused from now on, including calls already waiting for approval. Grants and history are kept. You can enable it again.",
    enableBody: "Governed calls to this connector are allowed again under its grants. You will be asked to confirm it's you.",
    deleteBody:
      "Its grants, revocations and stored credential are destroyed. Usage and audit history are kept. The removal is recorded in the audit log.",
    inUseCode: "connector_in_use",
    inUseText: (p) =>
      `It can't be deleted while ${countsText([
        [p.approvals as number, "approval", "approvals"],
        [p.chatopsConnections as number, "chat connection", "chat connections"],
      ])} refer to it. Approvals are audit evidence.`,
  });

  return (
    <>
      <PageHeader
        title="Connectors"
        sub="The connector catalog, decoupled from entitlement — registering one grants nobody anything."
        info={<p>The catalogue is separate from entitlement: listing a connector grants nobody anything. Kind is the category shown here; the adapter decides how calls run, and a connector without one is governance-only. The per-call price feeds the cost meters.</p>}
        actions={<Link to="/admin/connectors/catalogue">Connector catalogue</Link>}
      />
      <div className={v.stack}>
        <IntegrationOwnership kind="connectors" rows={connectors.data?.connectors ?? []} />
        <Card flush title="Catalog">
          <Table<Connector>
            columns={[
              {
                key: "name",
                header: "Name",
                sort: (c) => c.name,
                render: (c) => (
                  <span className={v.row} style={{ gap: "var(--s1)" }}>
                    {c.name}
                    <DisabledBadge row={c} noun="connector" />
                  </span>
                ),
              },
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
              { key: "actions", header: "", srHeader: "Actions", render: (c) => life.actions(c) },
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
      {life.dialogs}
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
          <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="for example salesforce" />
        </Field>
        <Field label="Kind (display category)">
          <Input required value={f.kind} onChange={(e) => set("kind", e.target.value)} placeholder="for example crm" />
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

/**
 * What "no credential stored" means for an adapter (INT-003). Most adapters refuse a governed invoke without one, but
 * a governance-only connector runs no adapter, mock is keyless, and the generic HTTP family sends a token only if one
 * is stored. The badge says which, instead of warning that every one of them will fail.
 */
export function noCredentialStatus(kind: string | null | undefined): { tone?: "warn" | "info"; text: string } {
  if (!kind) return { text: "no credential needed: governance-only, no adapter runs calls for this connector" };
  if (kind === "mock") return { tone: "info", text: "no credential needed: the mock adapter is keyless" };
  if (kind === "http" || kind === "generic" || kind === "webhook") {
    return { tone: "info", text: "no credential: calls are sent without one. Save a token if the endpoint needs it" };
  }
  return { tone: "warn", text: "no credential — governed invokes that need one will fail" };
}

/**
 * The base URL a save sends (INT-004). The gateway stores an omitted baseUrl as null, so the field starts with the
 * stored override and a rotation that leaves it alone keeps it. Clearing the override is its own explicit choice; an
 * emptied field without that choice is refused here rather than silently dropping the override.
 */
export function credentialBaseUrlChoice(
  stored: string | null | undefined,
  draft: string,
  clearOverride: boolean,
): { baseUrl?: string } | { error: string } {
  if (stored && clearOverride) return {};
  const typed = draft.trim();
  if (typed) return { baseUrl: typed };
  if (stored) {
    return { error: "The base URL override is empty. Choose “Clear the override” to remove it, or enter a URL." };
  }
  return {};
}

function CredentialCard(props: { connectors: Connector[] }) {
  const act = useAction();
  const [connectorId, setConnectorId] = useState("");
  const selected = props.connectors.find((c) => c.id === connectorId) ?? null;

  const cred = useQuery({
    queryKey: ["admin", "connector-credential", connectorId],
    queryFn: () => api.get<ConnectorCredentialInfo>(`/v1/connectors/${encodeURIComponent(connectorId)}/credential`),
    enabled: Boolean(connectorId),
  });
  // the connector the remove dialog was opened for, so a later selection change cannot retarget it
  const [removeFor, setRemoveFor] = useState<string | null>(null);
  const stored = cred.data?.credential ?? null;
  const none = noCredentialStatus(selected?.providerKind);

  return (
    <Card title="Platform credential — write-only, per connector">
      <div className={a.formRow}>
        <Field label="Connector" grow>
          <Select
            value={connectorId}
            onChange={(e) => {
              setConnectorId(e.target.value);
              act.setError(null);
            }}
          >
            {optionEls(connectorOpts(props.connectors), "— select a connector —")}
          </Select>
        </Field>
      </div>
      {selected && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          {cred.isPending ? (
            <SkeletonBlock lines={2} />
          ) : cred.isError ? (
            // INT-003: a failed read is not "no credential", and no save form is offered until it is known which
            // credential and base URL override are stored
            <ErrorState
              title="Couldn't read this connector's credential"
              message={`${errorText(cred.error)}. Whether a credential is stored is unknown, so nothing can be saved until it loads.`}
              onRetry={() => void cred.refetch()}
            />
          ) : (
            <>
              <div className={v.row}>
                {stored ? (
                  <>
                    <Badge tone="ok">credential configured</Badge>
                    <span className={v.dim}>
                      since {ago(stored.createdAt)} · base URL {stored.baseUrl ?? "provider default"}
                    </span>
                    <span className={v.grow} />
                    <Button size="sm" variant="danger" disabled={act.busy} onClick={() => setRemoveFor(connectorId)}>
                      remove
                    </Button>
                  </>
                ) : (
                  <Badge tone={none.tone}>{none.text}</Badge>
                )}
              </div>
              {act.error && (
                <div className={v.errLine} role="alert">
                  {act.error}
                </div>
              )}
              {/* INT-002: keyed on the connector and what is stored, so each connector's form starts clean and a
                  saved or removed credential re-seeds the base URL from the server */}
              <CredentialForm
                key={`${selected.id}:${stored?.id ?? "none"}:${stored?.baseUrl ?? ""}`}
                connector={selected}
                stored={stored}
              />
            </>
          )}
        </div>
      )}
      <ConfirmModal
        open={removeFor !== null}
        title="Remove this connector's credential?"
        body="Governed invokes that need it start failing until a new one is saved."
        danger
        confirmLabel="Remove"
        onCancel={() => setRemoveFor(null)}
        onConfirm={() => {
          const id = removeFor;
          setRemoveFor(null);
          if (id) void act.run(() => api.del(`/v1/connectors/${encodeURIComponent(id)}/credential`), "Credential removed");
        }}
      />
    </Card>
  );
}

const EMPTY_SF = { account: "", user: "", privateKey: "", passphrase: "" };

function CredentialForm(props: { connector: Connector; stored: ConnectorCredentialInfo["credential"] }) {
  const act = useAction();
  const { connector, stored } = props;
  const isSnowflake = connector.providerKind === "snowflake";
  const jsonTemplate = credentialJsonTemplate(connector.providerKind);
  const [token, setToken] = useState("");
  // INT-004: starts at the stored override, so a token-only rotation keeps it
  const [baseUrl, setBaseUrl] = useState(stored?.baseUrl ?? "");
  const [clearOverride, setClearOverride] = useState(false);
  const [sf, setSf] = useState(EMPTY_SF);
  const setSfF = (k: keyof typeof sf, val: string) => setSf((s) => ({ ...s, [k]: val }));
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const overrideStored = Boolean(stored?.baseUrl);
  const piece = isPieceKind(connector.providerKind);
  const tokenHint = credentialTokenHint(connector.providerKind);

  return (
    <form
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        // a piece takes no base URL: send none (the gateway stores null), whatever was stored before
        const choice = piece ? {} : credentialBaseUrlChoice(stored?.baseUrl, baseUrl, clearOverride);
        if ("error" in choice) {
          setBaseUrlError(choice.error);
          return;
        }
        setBaseUrlError(null);
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
            () => api.post(`/v1/connectors/${encodeURIComponent(connector.id)}/credential`, { token: body, ...choice }),
            "Credential saved (encrypted at rest, never returned)",
          )
          .then((ok) => {
            if (ok) {
              setToken("");
              setSf(EMPTY_SF);
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
              autoComplete="off"
              spellCheck={false}
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
              spellCheck={false}
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
            />
          </Field>
          <p className={v.faint}>{credentialJsonHint(connector.providerKind)}</p>
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
      {!isSnowflake && !jsonTemplate && tokenHint && <p className={v.faint}>{tokenHint}</p>}
      <div className={a.formRow}>
        {piece ? (
          <p className={`${v.faint} ${v.grow}`}>
            A catalogue connector reaches only its vendor&apos;s API, so it takes no base URL override.
          </p>
        ) : (
          <Field label="Base URL (optional)" grow error={baseUrlError}>
            <Input
              value={clearOverride ? "" : baseUrl}
              disabled={clearOverride}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setBaseUrlError(null);
              }}
              placeholder={connector.baseUrl ?? "provider default"}
            />
          </Field>
        )}
        <Button type="submit" variant="primary" disabled={act.busy}>
          {stored ? "Rotate credential" : "Save credential"}
        </Button>
      </div>
      {overrideStored && !piece && (
        <label className={v.row}>
          <input
            type="checkbox"
            checked={clearOverride}
            onChange={(e) => {
              setClearOverride(e.target.checked);
              setBaseUrlError(null);
            }}
          />
          <span>Clear the override and use the connector's own base URL ({connector.baseUrl ?? "provider default"})</span>
        </label>
      )}
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
    </form>
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
          () => withStepUp((h) => stepUpApi.post("/v1/grants/connectors", { userId, connectorId, mode }, h)),
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
  // INT-005: the rows carry the user they were read for, and are shown (and removable) only while that user is still
  // the one selected, so a Remove can never act on the previous subject's grant
  const [loaded, setLoaded] = useState<{ userId: string; rows: Array<Record<string, unknown>> } | null>(null);
  const rows = loaded && loaded.userId === userId ? loaded.rows : null;
  const load = (forUser: string) =>
    act.run(async () => {
      const r = await api.get<{ connectors: Array<Record<string, unknown>> }>(
        `/v1/users/${encodeURIComponent(forUser)}/connectors`,
      );
      setLoaded({ userId: forUser, rows: r.connectors });
    }, null);
  return (
    <Card title="Per-user entitlement">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          setLoaded(null);
          void load(userId);
        }}
      >
        <Field label="User" grow>
          <Select
            required
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setLoaded(null);
            }}
          >
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
              srHeader: "Status",
              render: (r) => (r.revoked ? <Badge tone="danger">revoked</Badge> : null),
            },
            {
              key: "actions",
              header: "",
              srHeader: "Actions",
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
                  onDone={() => void load(userId)}
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
