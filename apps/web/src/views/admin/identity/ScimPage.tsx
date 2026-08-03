/**
 * Provisioning (SCIM 2.0) — ADR-0037.
 *
 * Two things this screen exists to make honest rather than merely possible:
 *
 *  - a SCIM token is a **provisioning-power credential** on its own trust path.
 *    It can create, update and DEACTIVATE users without being any user, so it
 *    is issued, rotated and revoked here — with the plaintext shown exactly
 *    once, the same contract as an API key or a one-time password — rather than
 *    being some invisible deployment secret nobody can rotate.
 *  - a **synced group grants nothing**. The status card says so in as many
 *    words, because the natural assumption on seeing "12 groups synced" is that
 *    something was granted. Mapping a group to a role is ADR-0038 and does not
 *    exist yet; until it does, group membership is a recorded fact and nothing
 *    more.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { ScimStatus, ScimToken } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Table,
} from "../../../ui/kit";
import { KV, QueryGate, RevealCard, useAction, type RevealedSecret } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function ScimPage() {
  const q = useQuery({
    queryKey: ["admin", "scim-status"],
    queryFn: () => api.get<ScimStatus>("/v1/scim/status"),
  });
  const act = useAction();
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);
  const [name, setName] = useState("");
  const [revokeToken, setRevokeToken] = useState<ScimToken | null>(null);
  const [rotateToken, setRotateToken] = useState<ScimToken | null>(null);

  const issue = async () => {
    await act.run(async () => {
      const issued = await api.post<{ token: string; name: string }>("/v1/scim/tokens", { name });
      setReveal({
        title: `SCIM token for “${issued.name}”`,
        secret: issued.token,
        note: "Paste it into the IdP's provisioning configuration now — it is never shown again. It can create, update and deactivate accounts, so treat it like a directory admin credential; if it leaks, rotate it here and the old value stops working immediately.",
      });
      setName("");
    }, "SCIM token issued");
  };

  return (
    <>
      <PageHeader
        title="Provisioning (SCIM 2.0)"
        sub="Your IdP pushes accounts and group membership here, and — the part that matters — deprovisions them. Offboarding through SCIM deactivates: sessions die at once, API keys stop authenticating, and nothing is deleted, so the audit trail of everything the account ever did survives and reactivation restores it unchanged."
      />
      <div className={v.stack}>
        {reveal && <RevealCard reveal={reveal} onDismiss={() => setReveal(null)} />}

        <Card title="Issue a SCIM token — plaintext returned exactly once, sha256 at rest">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void issue();
            }}
          >
            <Field label="Integration name (named as the actor in every audit row it writes)" grow>
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="okta-prod"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Issue token
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <Table<ScimToken>
            columns={[
              { key: "name", header: "Integration", render: (t) => t.name },
              { key: "created", header: "Created", sort: (t) => t.createdAt, render: (t) => ago(t.createdAt) },
              {
                key: "used",
                header: "Last sync",
                render: (t) =>
                  t.lastUsedAt ? (
                    ago(t.lastUsedAt)
                  ) : (
                    <span className={v.faint} title="no SCIM request has ever presented this token">
                      never
                    </span>
                  ),
              },
              {
                key: "status",
                header: "Status",
                render: (t) =>
                  t.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="ok">active</Badge>,
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (t) =>
                  t.revokedAt ? null : (
                    <span className={v.rowTight}>
                      <Button size="sm" onClick={() => setRotateToken(t)}>
                        rotate
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setRevokeToken(t)}>
                        revoke
                      </Button>
                    </span>
                  ),
              },
            ]}
            rows={q.data?.tokens ?? []}
            rowKey={(t) => t.id}
            loading={q.isLoading}
            empty={
              <EmptyState
                title="No SCIM tokens"
                body="No IdP can provision into this deployment until a token is issued and configured at the IdP end."
              />
            }
          />
          <p className={v.faint}>
            SCIM authenticates on this token and on nothing else — a browser session or a user API key
            is refused at <span className={v.mono}>/scim/v2</span>, because provisioning is a separate
            trust path from being a person. Requests are rate-limited per token and answer{" "}
            <span className={v.mono}>429</span> with <span className={v.mono}>Retry-After</span> when a
            connector runs away. Every create, update, deactivate, reactivate and membership change is
            audited with this integration named as the actor.
          </p>
        </Card>

        <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data && <StatusCard status={q.data} />}
        </QueryGate>

        <Card title="Point your IdP at this deployment">
          <p className={v.faint}>Base URL for the provisioning connector:</p>
          <CodeBlock>{`${window.location.origin}/scim/v2`}</CodeBlock>
          <p className={v.faint}>
            Authentication is an OAuth bearer token — paste the value shown once above. Supported:{" "}
            <span className={v.mono}>/Users</span> (create, read, filter by{" "}
            <span className={v.mono}>userName eq</span> / <span className={v.mono}>emails eq</span> /{" "}
            <span className={v.mono}>externalId eq</span>, PATCH, PUT, DELETE) and{" "}
            <span className={v.mono}>/Groups</span> (full CRUD with membership reconciliation). Not
            supported, deliberately: password provisioning (accounts arrive with no password and sign in
            via SSO, or get an admin one-time password), admin rights (never an IdP-assertable attribute),
            the local username identifier, and the full RFC 7644 filter grammar — an unsupported filter is
            refused with a SCIM error rather than answered with the wrong result set.
          </p>
        </Card>
      </div>

      <ConfirmModal
        open={rotateToken !== null}
        title={`Rotate the token for “${rotateToken?.name}”?`}
        body="A new secret is minted and shown once. The current secret stops working the moment you confirm, so the IdP will fail to sync until you paste the new value into it."
        confirmLabel="Rotate token"
        onCancel={() => setRotateToken(null)}
        onConfirm={() => {
          const t = rotateToken;
          setRotateToken(null);
          if (!t) return;
          void act.run(async () => {
            const rotated = await api.post<{ token: string }>(`/v1/scim/tokens/${t.id}/rotate`, {});
            setReveal({
              title: `Rotated SCIM token for “${t.name}”`,
              secret: rotated.token,
              note: "The previous secret is already dead. Paste this into the IdP now — it is never shown again.",
            });
          }, "SCIM token rotated");
        }}
      />
      <ConfirmModal
        open={revokeToken !== null}
        title={`Revoke the token for “${revokeToken?.name}”?`}
        body={`Provisioning from “${revokeToken?.name}” stops immediately and cannot be resumed with this secret — issue a new token instead. Accounts and groups it already synced are untouched; nobody is deactivated by this.`}
        danger
        confirmLabel="Revoke token"
        onCancel={() => setRevokeToken(null)}
        onConfirm={() => {
          const t = revokeToken;
          setRevokeToken(null);
          if (t) void act.run(() => api.post(`/v1/scim/tokens/${t.id}/revoke`, {}), "SCIM token revoked");
        }}
      />
    </>
  );
}

function StatusCard(props: { status: ScimStatus }) {
  const s = props.status;
  return (
    <Card title="Sync status">
      <KV
        rows={[
          ["Active tokens", String(s.activeTokens)],
          [
            "Last SCIM request",
            s.lastUsedAt ? (
              ago(s.lastUsedAt)
            ) : (
              <span className={v.faint} key="never">
                never — no IdP has called this deployment yet
              </span>
            ),
          ],
          ["Users provisioned by an IdP", String(s.counts.provisionedUsers)],
          [
            "…of which deactivated",
            <span key="deact" className={v.rowTight}>
              {String(s.counts.deactivatedUsers)}
              <span className={v.faint}>
                (disabled, not deleted — reactivating restores the account and its keys)
              </span>
            </span>,
          ],
          ["Groups synced", String(s.counts.groups)],
          ["Membership records", String(s.counts.memberships)],
          [
            "…of which mapped to a role",
            <span key="mapped" className={v.rowTight}>
              {String(s.counts.mappedGroups)}
              <span className={v.faint}>
                (the rest are inert — see Group → role mapping)
              </span>
            </span>,
          ],
        ]}
      />
      <p className={v.faint}>
        <strong>An unmapped group grants nothing.</strong> Membership is recorded here as the IdP
        asserts it, and on its own that is all it does. It becomes entitlement only where an admin
        has explicitly mapped that group to a role on the{" "}
        <Link to="/admin/group-mappings">Group → role mapping</Link> screen — default-deny, with no
        “default role for unmapped groups” setting anywhere. And no mapping, of any group, can
        confer the platform admin bit: <code>isAdmin</code> is not a role, so an IdP cannot become a
        privilege-escalation path by asserting that someone is in a group called “admins”.
      </p>
    </Card>
  );
}
