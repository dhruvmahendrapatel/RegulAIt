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
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { ListPreview } from "../../../ui/ListPreview";
import type { IdentityLink } from "./ChatIdentityLinksPage";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, Table, Tabs, Textarea, tabIds } from "../../../ui/kit";
import { QueryGate, reconfirmNeeded, StaleAfterWrite, useAction, useConnectors, useSettleAfterWrite, useSingleFlight } from "../adminKit";
import v from "../../views.module.css";
import { BuilderRoutesCard, PostApprovalCard } from "./ChatOpsPostAndRoutes";

/**
 * The ChatOps providers a workspace can be registered for. A hand-maintained
 * mirror of shared's `CHATOPS_PROVIDERS` (the web package depends on no
 * workspace package); the gateway's adr0121 suite reads this literal as source
 * and fails if the two drift — AER-015: outlook was accepted by the API and
 * could not be picked here.
 */
export const CHATOPS_PROVIDERS = ["slack", "teams", "outlook", "resend"];
/** Mirror of the gateway's `CHATOPS_OUTBOUND_PROVIDERS` (ADR-0113): the ones
 * the courier can post a card to — outlook since ADR-0183 batch 2.6 (a Graph
 * sendMail courier). Pinned by the same suite. */
export const CHATOPS_OUTBOUND_PROVIDERS = ["slack", "teams", "outlook", "resend"];
/** Providers with NO inbound path by decision (ADR-0121): registered with no
 * signing secret, and the API refuses one. Pinned by the same suite against
 * shared's `verifyChatSignature` (`inbound_unsupported_by_design`). */
export const CHATOPS_SEND_ONLY_PROVIDERS = ["outlook", "resend"];
/** ADR-0202 lane E: a resend workspace mails each approval's named approver,
 * so it takes no recipient; the gateway requires this marker instead */
export const RESEND_RECIPIENT_MODE = "named-approvers";

/** ADR-0179 (AER-015): a provider the courier cannot post to cannot be
 * registered — the API answers 422 `outbound_provider_unavailable` — so its
 * option is shown, disabled, with the reason. Derived from the outbound mirror,
 * so outlook's option came back the day its sender landed (ADR-0183 2.6). */
export function chatOpsProviderRegistrable(provider: string): boolean {
  return CHATOPS_OUTBOUND_PROVIDERS.includes(provider);
}

/** why a provider cannot be registered, or null when it can */
export function chatOpsProviderUnavailableReason(provider: string): string | null {
  if (chatOpsProviderRegistrable(provider)) return null;
  const inbound = CHATOPS_SEND_ONLY_PROVIDERS.includes(provider) ? ` Inbound ${provider} stays refused by design.` : "";
  return `${provider} can't be registered for approval cards yet: there is no outbound sender for it, so a workspace would never deliver a card.${inbound}`;
}

/** the option label, saying only what is true of the provider today */
export function chatOpsProviderLabel(provider: string): string {
  const notes: string[] = [];
  if (!chatOpsProviderRegistrable(provider)) {
    notes.push("unavailable: no outbound sender yet");
  }
  if (CHATOPS_SEND_ONLY_PROVIDERS.includes(provider)) {
    notes.push("send-only by design, no signing secret");
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
  // an empty secret is omitted, so a workspace that needs one gets the API's
  // `signing_secret_required` refusal rather than a field-length error
  return { ...rest, ...(signingSecret ? { signingSecret } : {}), ...bot };
}

/** A workspace posts through a connector of its own provider kind (the API
 * refuses any other with `connector_kind_mismatch`), so only those are offered:
 * picking another would first overwrite that connector's stored credential. */
export function chatOpsConnectorsFor<C extends { providerKind?: string | null }>(connectors: C[], provider: string): C[] {
  return connectors.filter((c) => c.providerKind === provider);
}

/**
 * ADR-0183 2.6 — the four fields of an outlook app registration, as the
 * connector credential the gateway stores encrypted (ADR-0023 structured JSON,
 * the same store and shape as the Teams credential): client id → `appId`,
 * client secret → `appPassword`, tenant → `tenantId`, sender mailbox →
 * `senderUpn`. All four or none: none means the chosen connector already holds
 * its credential; some is refused here rather than half-written.
 */
export interface OutlookAppFields {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  senderMailbox: string;
}
export function outlookCredentialToken(f: OutlookAppFields): { token: string | null } | { error: string } {
  const v = { tenantId: f.tenantId.trim(), clientId: f.clientId.trim(), clientSecret: f.clientSecret, senderMailbox: f.senderMailbox.trim() };
  const filled = [v.tenantId, v.clientId, v.clientSecret, v.senderMailbox].filter((x) => x !== "").length;
  if (filled === 0) return { token: null };
  if (filled < 4) {
    return { error: "Fill in all four app registration fields (tenant ID, client ID, client secret, sender mailbox), or none to use the connector's stored credential." };
  }
  return { token: JSON.stringify({ appId: v.clientId, appPassword: v.clientSecret, tenantId: v.tenantId, senderUpn: v.senderMailbox }) };
}

/** ADR-0202 lane E — the Resend API key and sender as the connector
 * credential (stored encrypted, never shown again): both or none */
export function resendCredentialToken(apiKey: string, from: string): { token: string | null } | { error: string } {
  const f = from.trim();
  if (!apiKey && !f) return { token: null };
  if (!apiKey || !f) return { error: "Fill in both the API key and the sender address, or neither to use the connector's stored credential." };
  return { token: JSON.stringify({ apiKey, from: f }) };
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
  /** ADR-0179 — false for a workspace the courier cannot post a card to (an
   * outlook row registered before registration was refused) */
  outboundSupported?: boolean;
  outlookRecipientAllowList?: string[];
}
interface ConnectionsResponse {
  connections: Connection[];
  posture: string;
}

export default function ChatOpsPage() {
  const queryClient = useQueryClient();
  const connections = useQuery({
    queryKey: ["chatops", "connections"],
    queryFn: () => api.get<ConnectionsResponse>("/v1/chatops/connections"),
  });
  const [tab, setTab] = useState("workspaces");
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
  const [outlookApp, setOutlookApp] = useState<OutlookAppFields>({ tenantId: "", clientId: "", clientSecret: "", senderMailbox: "" });
  const setApp = (k: keyof OutlookAppFields) => (e: { target: { value: string } }) => setOutlookApp((a) => ({ ...a, [k]: e.target.value }));
  const sendOnly = CHATOPS_SEND_ONLY_PROVIDERS.includes(provider);
  const resend = provider === "resend";
  const [resendKey, setResendKey] = useState("");
  const [resendFrom, setResendFrom] = useState("");


  const refresh = () => {
    void connections.refetch();
    void queryClient.invalidateQueries({ queryKey: ["chatops", "links"] });
  };

  return (
    <>
      <PageHeader title="ChatOps approvals" sub="The Approvals Queue in Slack, Teams or Outlook — bound to the real human, never the bot." />

      <Card
        title="How this is safe"
        info={
          <>
            <p>{connections.data?.posture ?? "Loading…"}</p>
            <p>
              Outlook only delivers: the email carries the request summary (withheld when the approval is sensitive) and a
              link to the approval in regulAIt. It is decided there, after signing in, never by replying to the email.
            </p>
          </>
        }
      >
        <div className={v.row}>
          <Badge
            tone="warn"
            info={
              <p>
                A chat tap is not a re-authenticated session. Inbound callbacks are verified against the workspace signing
                secret over the exact raw body, inside a replay window, before anything else happens; the chat user id is then
                mapped to a regulAIt human and the one decide path re-checks entitlement server-side.
              </p>
            }
          >
            Not re-authenticated
          </Badge>
        </div>
      </Card>

      {/* P3: the growing list is a preview; the full list and the link form have their own page */}
      <ListPreview<IdentityLink>
        title="Chat ↔ regulAIt identity links"
        noun="identity links"
        endpoint="/v1/chatops/identity-links"
        legacyKey="links"
        queryKey={["chatops", "links"]}
        sort={{ key: "created", dir: "desc" }}
        attention={[{ label: "admin-asserted", filters: { verification: "admin_asserted" } }]}
        note={
          <div className={v.row}>
            <Badge tone="warn">Unverified identity</Badge>
          </div>
        }
        columns={[
          { key: "chatuser", header: "Chat identity", render: (r) => <code>{r.chatUserId}</code> },
          { key: "email", header: "Bound to", render: (r) => r.chatUserEmail },
          {
            key: "verified",
            header: "Email verification",
            render: (r) => <Badge tone={r.emailVerifiedSource === "admin_asserted" ? "warn" : "ok"}>{r.emailVerifiedSource}</Badge>,
          },
          { key: "workspace", header: "Workspace", render: (r) => r.connectionName ?? "—" },
          { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
        ]}
        rowKey={(r) => r.id}
        viewAll="/admin/chatops/identity-links"
        empty={<EmptyState title="No identity links yet" body="A chat user acts as a regulAIt person only through a link an administrator makes." />}
      />

      {/* P3: the workspaces and the posting settings are settings, in tabs; workspaces (and their warnings) open first */}
      <Tabs
        tabs={[
          { id: "workspaces", label: "Workspaces" },
          { id: "routes", label: "Posting & routes" },
        ]}
        active={tab}
        onChange={setTab}
        idPrefix="chatops"
        label="ChatOps settings"
      />
      <div role="tabpanel" id={tabIds("chatops", tab).panel} aria-labelledby={tabIds("chatops", tab).tab} className={v.stack}>
        {tab === "workspaces" ? (
          <>
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
                {
                  key: "provider",
                  header: "Provider",
                  render: (r) =>
                    r.outboundSupported === false ? (
                      <span className={v.row}>
                        <code>{r.provider}</code>
                        <Badge tone="warn" info={<p>There is no outbound sender for this provider, so approval cards posted here are refused. Decide in the portal.</p>}>
                          cannot send cards
                        </Badge>
                      </span>
                    ) : (
                      <code>{r.provider}</code>
                    ),
                },
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
                  srHeader: "Actions",
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

      {(connections.data?.connections ?? []).filter((row) => row.provider === "outlook").map((row) =>
        <OutlookRecipients key={`${row.id}:${JSON.stringify(row.outlookRecipientAllowList)}`} connection={row} />)}

      <Card
        title="Connect a workspace"
        info={
          <p>
            The outbound bot token is NOT stored here — it stays in the connector you choose, in the same encrypted,
            write-only credential store as every other secret. Only the inbound signing secret is new, because it is a
            secret we verify with rather than one we present.
          </p>
        }
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-slack" />
        </Field>
        <Field label="Provider">
          <Select value={provider} onChange={(e) => { setProvider(e.target.value); setConnectorId(""); }}>
            {CHATOPS_PROVIDERS.map((p) => (
              <option key={p} value={p} disabled={!chatOpsProviderRegistrable(p)}>
                {chatOpsProviderLabel(p)}
              </option>
            ))}
          </Select>
        </Field>
        {CHATOPS_PROVIDERS.filter((p) => !chatOpsProviderRegistrable(p)).map((p) => (
          <p key={p} className={v.faint} data-testid={`chatops-unavailable-${p}`}>
            {chatOpsProviderUnavailableReason(p)}
          </p>
        ))}
        <Field label={sendOnly ? "Connector (holds the app registration)" : "Connector (holds the bot token)"}>
          <Select value={connectorId} onChange={(e) => setConnectorId(e.target.value)}>
            <option value="">select…</option>
            {chatOpsConnectorsFor(connectors.data?.connectors ?? [], provider).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {connectors.data && chatOpsConnectorsFor(connectors.data.connectors ?? [], provider).length === 0 ? (
          <p className={v.faint} data-testid="chatops-no-connector">
            No connector has provider kind {provider} yet. Add one on the Connectors page first.
          </p>
        ) : null}
        {sendOnly ? (
          <>
            <p className={v.faint}>
              {provider} has no inbound path, so there is no signing secret to set: an email is an unauthenticated
              assertion, not a signed callback, and approvals are decided from the portal link the message carries.
            </p>
            <p className={v.faint}>
              The credential that sends the mail is stored encrypted on the connector above, like every other
              credential, and is never displayed again. Leave these empty if the connector already holds it.
            </p>
            <p className={v.faint}>
              The link in each email uses only the gateway&apos;s configured public URL (REGULAIT_PUBLIC_URL); a mail
              workspace cannot be registered until it is set.
            </p>
            {resend ? (
              <>
                <p className={v.faint}>Mail goes to each approval&apos;s named approver only.</p>
                <Field label="API key (write-only — never displayed again)">
                  <Input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Sender, on a domain verified in Resend">
                  <Input value={resendFrom} onChange={(e) => setResendFrom(e.target.value)} placeholder="approvals@mail.example.com" autoComplete="off" />
                </Field>
              </>
            ) : (
              <>
            <Field label="Tenant ID">
              <Input value={outlookApp.tenantId} onChange={setApp("tenantId")} placeholder="contoso.onmicrosoft.com" autoComplete="off" />
            </Field>
            <Field label="Client ID">
              <Input value={outlookApp.clientId} onChange={setApp("clientId")} autoComplete="off" />
            </Field>
            <Field label="Client secret (write-only — never displayed again)">
              <Input type="password" value={outlookApp.clientSecret} onChange={setApp("clientSecret")} autoComplete="new-password" />
            </Field>
            <Field label="Sender mailbox">
              <Input value={outlookApp.senderMailbox} onChange={setApp("senderMailbox")} placeholder="regulait-approvals@acme.com" autoComplete="off" />
            </Field>
              </>
            )}
          </>
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
        {resend ? null : (
          <Field label={sendOnly ? "Default recipient mailbox" : "Default channel"}>
            <Input
              value={defaultChannel}
              onChange={(e) => setDefaultChannel(e.target.value)}
              placeholder={sendOnly ? "approvers@acme.com" : "C0123456789"}
            />
          </Field>
        )}
        {sendOnly ? null : (
          <Field label="Allow deciding SENSITIVE (compliance-fenced) approvals from chat">
            <Select value={allowFencedDecide ? "yes" : "no"} onChange={(e) => setAllowFencedDecide(e.target.value === "yes")}>
              <option value="no">no — sensitive approvals are in-app only (recommended)</option>
              <option value="yes">yes — a chat tap may decide them</option>
            </Select>
          </Field>
        )}
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
        <div className={v.row}>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  async () => {
                    if (sendOnly) {
                      const cred = resend ? resendCredentialToken(resendKey, resendFrom) : outlookCredentialToken(outlookApp);
                      if ("error" in cred) throw new Error(cred.error);
                      // the app registration goes to the connector's own encrypted
                      // credential store first; registration then checks it parses
                      if (cred.token) await api.post(`/v1/connectors/${connectorId}/credential`, { token: cred.token });
                    }
                    await api.post(
                      "/v1/chatops/connections",
                      chatOpsConnectionBody({
                        name, provider, connectorId, signingSecret,
                        defaultChannel: resend ? RESEND_RECIPIENT_MODE : defaultChannel,
                        allowFencedDecide: sendOnly ? false : allowFencedDecide,
                        botAppId, botTenantId, botOpenidMetadataUrl,
                      }),
                    );
                  },
                  "Workspace connected",
                )
                .then((ok) => {
                  setOutlookApp((a) => ({ ...a, clientSecret: "" }));
                  setResendKey("");
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

          </>
        ) : (
          <>
      {/* mirror one approval into a channel; which channel each builder agent answers on */}
      <PostApprovalCard connections={connections.data?.connections ?? []} />
      <BuilderRoutesCard />
          </>
        )}
      </div>

    </>
  );
}

/**
 * Mirrors `OUTLOOK_RECIPIENT_ALLOW_LIST_MAX` and the canonical form in
 * `outlookRecipientAllowListProblem` (packages/shared/src/batch3.ts): trimmed,
 * lower-cased, de-duplicated — the SPA depends on no workspace package, and
 * ChatOpsPage.test.ts runs both against the same inputs. Blank lines are not
 * entries. The limit and the confirmation count the canonical list, the one
 * the gateway stores.
 */
export const OUTLOOK_RECIPIENT_ALLOW_LIST_MAX = 50;
export function canonicalOutlookRecipients(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean))];
}

/**
 * What a save of the Outlook allow-list would do. The list is whole, so the
 * form never sends it as loaded: this admin's delta (added and removed
 * mailboxes, canonical, against `loaded`, the list the form opened with) is
 * applied to `current`, the list re-read just before saving, so a recipient
 * another admin added or removed meanwhile survives. Unchanged (no delta, or
 * the merge equals what is stored) sends nothing; an unreadable `current`
 * refuses rather than overwrite with a stale list. `adds` is decided on the
 * merged list against `current`; `added` lists the mailboxes it newly allows.
 */
export function outlookRecipientChange(loaded: readonly string[], text: string, current: readonly string[] | null):
  | { kind: "error"; error: string }
  | { kind: "unchanged" }
  | { kind: "save"; recipients: string[]; adds: boolean; added: string[] } {
  const local = canonicalOutlookRecipients(text);
  const before = canonicalOutlookRecipients(loaded.join("\n"));
  const added = local.filter((mailbox) => !before.includes(mailbox));
  const removed = before.filter((mailbox) => !local.includes(mailbox));
  if (added.length === 0 && removed.length === 0) return { kind: "unchanged" };
  if (current === null) return { kind: "error", error: "Could not load the current recipients, so nothing was saved. Retry." };
  const now = canonicalOutlookRecipients(current.join("\n"));
  const recipients = [...new Set([...now.filter((mailbox) => !removed.includes(mailbox)), ...added])];
  if (recipients.length === now.length && recipients.every((mailbox) => now.includes(mailbox))) return { kind: "unchanged" };
  if (recipients.length > OUTLOOK_RECIPIENT_ALLOW_LIST_MAX) return { kind: "error", error: `Allow at most ${OUTLOOK_RECIPIENT_ALLOW_LIST_MAX} additional recipient mailboxes (including any added meanwhile).` };
  const newlyAllowed = recipients.filter((mailbox) => !now.includes(mailbox));
  return { kind: "save", recipients, adds: newlyAllowed.length > 0, added: newlyAllowed };
}

function OutlookRecipients({ connection }: { connection: Connection }) {
  const act = useAction();
  const flight = useSingleFlight();
  // after a save the form stays locked until the connections query has the server's list
  const baseline = useSettleAfterWrite(["chatops", "connections"]);
  const [text, setText] = useState((connection.outlookRecipientAllowList ?? []).join("\n"));
  // the dialog keeps this admin's INTENT (the text, read against the load-time
  // list), not the merged list: confirming re-reads and re-merges
  type Shown = Extract<ReturnType<typeof outlookRecipientChange>, { kind: "save" }>;
  const [pending, setPending] = useState<{ text: string; shown: Shown; changedWhileOpen: boolean } | null>(null);
  // ADR-0186 A: adding a mailbox is a settings_relax the gateway binds to this workspace and the added mailboxes, so
  // it answers step_up_required; the step-up dialog opens inside the held flight, and a cancelled step-up writes
  // nothing and frees the form (removing a mailbox needs no step-up and is sent once)
  const save = async (recipients: string[]) => {
    const write = () => withStepUp((h) => stepUpApi.patch(`/v1/chatops/connections/${connection.id}`, { outlookRecipientAllowList: recipients }, h));
    if (await act.run(write, "Outlook recipients saved")) await baseline.settle();
  };
  const loaded = connection.outlookRecipientAllowList ?? [];
  const readCurrent = () => api.get<ConnectionsResponse>("/v1/chatops/connections").then(
    (response) => response.connections.find((row) => row.id === connection.id)?.outlookRecipientAllowList ?? null,
    () => null,
  );
  const confirm = async () => {
    const intent = pending;
    setPending(null);
    let confirming = false;
    try {
      if (!intent) return;
      // the dialog may have been open for minutes: merge into what is stored NOW
      const change = outlookRecipientChange(loaded, intent.text, await readCurrent());
      if (change.kind === "error") { act.setError(change.error); return; }
      if (change.kind === "unchanged") { act.setError("The stored recipients already match your change; nothing was saved."); return; }
      if (reconfirmNeeded(intent.shown.added, change)) { confirming = true; setPending({ ...intent, shown: change, changedWhileOpen: true }); return; }
      await save(change.recipients);
    } finally {
      if (!confirming) flight.leave();
    }
  };
  const submit = async () => {
    // busy BEFORE the re-read: a second submit meanwhile is ignored
    if (baseline.stale || !flight.enter()) return;
    let confirming = false;
    try {
      const edited = outlookRecipientChange(loaded, text, loaded);
      if (edited.kind === "error") { act.setError(edited.error); return; }
      if (edited.kind === "unchanged") { act.setError("No recipient changed; nothing was saved."); return; }
      // merge into, and classify against, the list stored now
      const change = outlookRecipientChange(loaded, text, await readCurrent());
      if (change.kind === "error") { act.setError(change.error); return; }
      if (change.kind === "unchanged") { act.setError("The stored recipients already match your change; nothing was saved."); return; }
      if (change.adds) { confirming = true; setPending({ text, shown: change, changedWhileOpen: false }); return; }
      await save(change.recipients);
    } finally {
      // a confirmation keeps the flight until it is cancelled or saved
      if (!confirming) flight.leave();
    }
  };
  const busy = act.busy || flight.busy || baseline.stale;
  return <Card title={`Outlook recipients: ${connection.name}`}><form className={v.stack} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field label={`Additional recipients for ${connection.name}`}><Textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy} rows={4} /></Field>
    <p>One exact mailbox per line, at most 50. No display names or wildcards. The registered mailbox remains allowed. Adding recipients relaxes who may receive approval summaries and is audited; all changes are audited.</p>
    <Button type="submit" disabled={busy}>Save Outlook recipients</Button>
    {act.error && <p role="alert">{act.error}</p>}
    {baseline.stale && <StaleAfterWrite onRetry={() => void baseline.settle()} />}
    <ConfirmModal open={pending !== null} title="Allow more Outlook recipients?" body={<p>{pending?.changedWhileOpen && <>The stored list changed while this was open; review the result again. </>}Newly allowed: {pending?.shown.added.join(", ")}. The resulting allow-list will contain {pending?.shown.recipients.length ?? 0} exact mailboxes. Additional recipients may receive approval summaries; this relaxation is audited.</p>}
      confirmLabel="Save audited recipients" onCancel={() => { setPending(null); flight.leave(); }}
      onConfirm={() => void confirm()} />
  </form></Card>;
}
