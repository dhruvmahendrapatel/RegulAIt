/**
 * ChatOps approvals (ADR-0061).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **The bot is a courier.** The posture sentence from the API is printed at
 *    the top: every chat decision goes through the same decide function the
 *    portal calls, recorded against the mapped human.
 *  - **The identity link is the trust artifact.** It is created here, by an
 *    admin, against an EXISTING user's email — and each row shows how the email
 *    was verified. `admin_asserted` is displayed as the weaker thing it is
 *    rather than dressed up as `idp`.
 *  - **The signing secret is write-only.** The field accepts it; nothing ever
 *    renders it back, because a reader who could see it could forge callbacks.
 *  - **Chat is not a re-authenticated session.** `allowFencedDecide` is shown
 *    per workspace with its consequence spelled out, defaulting off.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, useAction, useConnectors } from "../adminKit";
import v from "../../views.module.css";

/**
 * The ChatOps providers a workspace can be registered for. A hand-maintained
 * mirror of shared's `CHATOPS_PROVIDERS` (the web package depends on no
 * workspace package); the gateway's adr0121 suite reads this literal as source
 * and fails if the two drift — AER-015: outlook was accepted by the API and
 * could not be picked here.
 */
export const CHATOPS_PROVIDERS = ["slack", "teams", "outlook"];
/** Mirror of the gateway's `CHATOPS_OUTBOUND_PROVIDERS` (ADR-0113): the ones
 * the courier can post a card to. Pinned by the same suite. */
export const CHATOPS_OUTBOUND_PROVIDERS = ["slack", "teams"];
/** Providers with NO inbound path by decision (ADR-0121): registered with no
 * signing secret, and the API refuses one. Pinned by the same suite against
 * shared's `verifyChatSignature` (`inbound_unsupported_by_design`). */
export const CHATOPS_SEND_ONLY_PROVIDERS = ["outlook"];

/** the option label, saying only what is true of the provider today */
export function chatOpsProviderLabel(provider: string): string {
  const notes: string[] = [];
  if (CHATOPS_SEND_ONLY_PROVIDERS.includes(provider)) {
    notes.push("send-only by design — no signing secret; approvers decide from the portal link");
  }
  if (!CHATOPS_OUTBOUND_PROVIDERS.includes(provider)) {
    notes.push("the courier cannot post to it yet");
  }
  return notes.length > 0 ? `${provider} (${notes.join("; ")})` : provider;
}

/** the POST /v1/chatops/connections body: a send-only provider carries no
 * signing secret (the API answers 400 signing_secret_not_applicable if it does).
 * ADR-0173 batch 2b: a teams workspace may register its Bot Framework bot (app
 * id, optional tenant and OpenID metadata URL); one reached only through its
 * bot needs no signing secret. */
export function chatOpsConnectionBody(input: {
  name: string;
  provider: string;
  connectorId: string;
  signingSecret: string;
  defaultChannel: string;
  allowFencedDecide: boolean;
  botAppId?: string;
  botTenantId?: string;
  botOpenidMetadataUrl?: string;
}): Record<string, unknown> {
  const { signingSecret, botAppId, botTenantId, botOpenidMetadataUrl, ...rest } = input;
  if (CHATOPS_SEND_ONLY_PROVIDERS.includes(input.provider)) return rest;
  const appId = input.provider === "teams" ? botAppId?.trim() ?? "" : "";
  const bot: Record<string, string> = appId
    ? {
        botAppId: appId,
        ...(botTenantId?.trim() ? { botTenantId: botTenantId.trim() } : {}),
        ...(botOpenidMetadataUrl?.trim() ? { botOpenidMetadataUrl: botOpenidMetadataUrl.trim() } : {}),
      }
    : {};
  return { ...rest, ...(signingSecret || !appId ? { signingSecret } : {}), ...bot };
}

interface Connection {
  id: string;
  name: string;
  provider: string;
  connectorId: string;
  defaultChannel: string;
  allowFencedDecide: boolean;
  notifyAlertMinSeverity?: "medium" | "high" | null;
  enabled: boolean;
  createdAt: string;
  /** ADR-0173 batch 2b — the Teams Bot Framework endpoint, when a bot is registered */
  botAppId?: string | null;
  botTenantId?: string | null;
  botEndpoint?: string | null;
}
interface ConnectionsResponse {
  connections: Connection[];
  posture: string;
}
interface IdentityLink {
  id: string;
  connectionId: string;
  chatUserId: string;
  chatUserEmail: string;
  userId: string;
  emailVerifiedSource: string;
  createdAt: string;
}
interface LinksResponse {
  links: IdentityLink[];
  posture: string;
}

export default function ChatOpsPage() {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: ["chatops", "connections"],
    queryFn: () => api.get<ConnectionsResponse>("/v1/chatops/connections"),
  });
  const links = useQuery({ queryKey: ["chatops", "links"], queryFn: () => api.get<LinksResponse>("/v1/chatops/identity-links") });
  const connectors = useConnectors();
  const act = useAction();

  const [name, setName] = useState("");
  const [provider, setProvider] = useState("slack");
  const [connectorId, setConnectorId] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [defaultChannel, setDefaultChannel] = useState("");
  const [allowFencedDecide, setAllowFencedDecide] = useState(false);
  const [botAppId, setBotAppId] = useState("");
  const [botTenantId, setBotTenantId] = useState("");
  const [botOpenidMetadataUrl, setBotOpenidMetadataUrl] = useState("");
  const sendOnly = CHATOPS_SEND_ONLY_PROVIDERS.includes(provider);

  const [linkConnection, setLinkConnection] = useState("");
  const [chatUserId, setChatUserId] = useState("");
  const [linkEmail, setLinkEmail] = useState("");

  const refresh = () => {
    void connections.refetch();
    void links.refetch();
  };

  return (
    <>
      <PageHeader title="ChatOps approvals" sub="The Approvals Queue in Slack/Teams — bound to the real human, never the bot." />

      <Card title="How this is safe">
        <p className={v.dim}>{connections.data?.posture ?? "Loading…"}</p>
        <p className={v.faint}>
          A chat tap is not a re-authenticated session. Inbound callbacks are verified against the workspace signing
          secret over the exact raw body, inside a replay window, before anything else happens; the chat user id is then
          mapped to a regulAIt human and the one decide path re-checks entitlement server-side.
        </p>
      </Card>

      <Card title="Workspaces">
        <QueryGate loading={connections.isLoading} error={connections.error} onRetry={refresh}>
          {(connections.data?.connections.length ?? 0) === 0 ? (
            <EmptyState title="No chat workspace connected" body="Register one below. The bot token comes from an existing connector." />
          ) : (
            <Table<Connection>
              rows={connections.data?.connections ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "name", header: "Name", render: (r) => r.name },
                { key: "provider", header: "Provider", render: (r) => <code>{r.provider}</code> },
                { key: "channel", header: "Default channel", render: (r) => r.defaultChannel },
                {
                  key: "alerts",
                  header: "Governance alerts",
                  render: (r) => (
                    <Select
                      aria-label={`Governance alerts for ${r.name}`}
                      value={r.notifyAlertMinSeverity ?? "off"}
                      disabled={act.busy}
                      onChange={(event) => {
                        const next = event.target.value === "off" ? null : event.target.value as "medium" | "high";
                        void act.run(async () => {
                          const updated = await api.patch<{ notifyAlertMinSeverity: "medium" | "high" | null }>(`/v1/chatops/connections/${r.id}`, { notifyAlertMinSeverity: next });
                          queryClient.setQueryData<ConnectionsResponse>(["chatops", "connections"], (current) => current ? ({
                            ...current,
                            connections: current.connections.map((connection) => connection.id === r.id
                              ? { ...connection, notifyAlertMinSeverity: updated.notifyAlertMinSeverity }
                              : connection),
                          }) : current);
                        }, "Governance alert delivery updated");
                      }}
                    >
                      <option value="off">Off</option>
                      <option value="high">High only</option>
                      <option value="medium">Medium and above</option>
                    </Select>
                  ),
                },
                {
                  key: "fenced",
                  header: "Sensitive approvals",
                  render: (r) =>
                    r.allowFencedDecide ? (
                      <Badge tone="warn">chat-decidable (opted in)</Badge>
                    ) : (
                      <Badge tone="ok">in-app only</Badge>
                    ),
                },
                {
                  key: "bot",
                  header: "Bot endpoint",
                  render: (r) =>
                    r.botEndpoint ? (
                      <span title={r.botTenantId ? `tenant ${r.botTenantId}` : "any tenant"}><code>{r.botEndpoint}</code></span>
                    ) : (
                      <span className={v.faint}>—</span>
                    ),
                },
                { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
                { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
                {
                  key: "remove",
                  header: "",
                  render: (r) => (
                    <Button
                      disabled={act.busy}
                      onClick={() => void act.run(() => api.del(`/v1/chatops/connections/${r.id}`), "Workspace removed").then((ok) => ok && refresh())}
                    >
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </QueryGate>
      </Card>

      <Card title="Connect a workspace">
        <p className={v.faint}>
          The outbound bot token is NOT stored here — it stays in the connector you choose, in the same encrypted,
          write-only credential store as every other secret. Only the inbound signing secret is new, because it is a
          secret we verify with rather than one we present.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-slack" />
        </Field>
        <Field label="Provider">
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {CHATOPS_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {chatOpsProviderLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Connector (holds the bot token)">
          <Select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            <option value="">select…</option>
            {(connectors.data?.connectors ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {sendOnly ? (
          <p className={v.faint}>
            {provider} has no inbound path, so there is no signing secret to set: an email is an unauthenticated
            assertion, not a signed callback, and approvals are decided from the portal link the message carries.
          </p>
        ) : (
          <Field label="Signing secret (write-only — never displayed again)">
            <Input type="password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} />
          </Field>
        )}
        {provider === "teams" ? (
          <>
            <p className={v.faint}>
              Optional: register the workspace's Bot Framework bot. Its activities are verified against the platform's
              signed tokens (audience = the app id), so a workspace reached only through its bot needs no signing secret.
            </p>
            <Field label="Bot app id (turns on the bot endpoint)">
              <Input value={botAppId} onChange={(e) => setBotAppId(e.target.value)} />
            </Field>
            <Field label="Bot tenant id (optional — accept this tenant only)">
              <Input value={botTenantId} onChange={(e) => setBotTenantId(e.target.value)} />
            </Field>
            <Field label="OpenID metadata URL (optional — the platform's published document by default)">
              <Input value={botOpenidMetadataUrl} onChange={(e) => setBotOpenidMetadataUrl(e.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label={sendOnly ? "Default recipient mailbox" : "Default channel"}>
          <Input
            value={defaultChannel}
            onChange={(e) => setDefaultChannel(e.target.value)}
            placeholder={sendOnly ? "approvers@acme.com" : "C0123456789"}
          />
        </Field>
        <Field label="Allow deciding SENSITIVE (compliance-fenced) approvals from chat">
          <Select value={allowFencedDecide ? "yes" : "no"} onChange={(e) => setAllowFencedDecide(e.target.value === "yes")}>
            <option value="no">no — sensitive approvals are in-app only (recommended)</option>
            <option value="yes">yes — a chat tap may decide them</option>
          </Select>
        </Field>
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
        <div className={v.row}>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  () =>
                    api.post(
                      "/v1/chatops/connections",
                      chatOpsConnectionBody({
                        name, provider, connectorId, signingSecret, defaultChannel, allowFencedDecide,
                        botAppId, botTenantId, botOpenidMetadataUrl,
                      }),
                    ),
                  "Workspace connected",
                )
                .then((ok) => {
                  if (ok) {
                    setSigningSecret("");
                    refresh();
                  }
                })
            }
          >
            Connect
          </Button>
        </div>
      </Card>

      <Card title="Chat ↔ regulAIt identity links">
        <p className={v.faint}>{links.data?.posture ?? ""}</p>
        <QueryGate loading={links.isLoading} error={links.error} onRetry={refresh}>
          <Table<IdentityLink>
            rows={links.data?.links ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "chatuser", header: "Chat identity", render: (r) => <code>{r.chatUserId}</code> },
              { key: "email", header: "Bound to", render: (r) => r.chatUserEmail },
              {
                key: "verified",
                header: "Email verification",
                render: (r) => (
                  <Badge tone={r.emailVerifiedSource === "admin_asserted" ? "warn" : "ok"}>{r.emailVerifiedSource}</Badge>
                ),
              },
              { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              {
                key: "remove",
                header: "",
                render: (r) => (
                  <Button
                    disabled={act.busy}
                    onClick={() => void act.run(() => api.del(`/v1/chatops/identity-links/${r.id}`), "Link removed").then((ok) => ok && refresh())}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        </QueryGate>

        <Field label="Workspace">
          <Select value={linkConnection} onChange={(e) => setLinkConnection(e.target.value)}>
            <option value="">select…</option>
            {(connections.data?.connections ?? []).map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Chat user id">
          <Input value={chatUserId} onChange={(e) => setChatUserId(e.target.value)} placeholder="U0123456789" />
        </Field>
        <Field label="regulAIt user email (must already exist)">
          <Input value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} />
        </Field>
        <div className={v.row}>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  () => api.post("/v1/chatops/identity-links", { connectionName: linkConnection, chatUserId, email: linkEmail }),
                  "Identity linked",
                )
                .then((ok) => ok && refresh())
            }
          >
            Link identity
          </Button>
        </div>
      </Card>
    </>
  );
}
