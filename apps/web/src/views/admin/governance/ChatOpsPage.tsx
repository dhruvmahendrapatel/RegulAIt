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
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, useAction, useConnectors } from "../adminKit";
import v from "../../views.module.css";

interface Connection {
  id: string;
  name: string;
  provider: string;
  connectorId: string;
  defaultChannel: string;
  allowFencedDecide: boolean;
  enabled: boolean;
  createdAt: string;
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
                  key: "fenced",
                  header: "Sensitive approvals",
                  render: (r) =>
                    r.allowFencedDecide ? (
                      <Badge tone="warn">chat-decidable (opted in)</Badge>
                    ) : (
                      <Badge tone="ok">in-app only</Badge>
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
            <option value="slack">slack</option>
            <option value="teams">teams (inbound only — no outbound adapter yet)</option>
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
        <Field label="Signing secret (write-only — never displayed again)">
          <Input type="password" value={signingSecret} onChange={(e) => setSigningSecret(e.target.value)} />
        </Field>
        <Field label="Default channel">
          <Input value={defaultChannel} onChange={(e) => setDefaultChannel(e.target.value)} placeholder="C0123456789" />
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
                    api.post("/v1/chatops/connections", {
                      name,
                      provider,
                      connectorId,
                      signingSecret,
                      defaultChannel,
                      allowFencedDecide,
                    }),
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
