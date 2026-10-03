/**
 * SSO & sessions (ADR-0025 / ADR-0036) — OIDC *and* SAML provider CRUD
 * (secrets write-only, default-deny JIT) plus the browser sign-in / session
 * policy (the org password, session, MFA, SSO-only and lockout dials).
 *
 * The two federated families are co-equal cards on ONE page on purpose: the
 * sso_only switch below counts them together, so an admin who could only see
 * one of them would be reasoning about the lockout guard with half the facts.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { OidcProvider, OrgSettingsResponse, SamlProvider } from "../../../api/adminTypes";
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
  Modal,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import { QueryGate, optionEls, roleOpts, useAction, useRoles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function SsoPage() {
  return (
    <>
      <PageHeader
        title="SSO & sessions"
        sub="OIDC and SAML sign-on, and the browser session policy."
        info={<p>OIDC and SAML 2.0 single sign-on providers (secrets write-only, signatures verified against pinned certificates) and the browser sign-in / session policy. API keys and the bootstrap token are machine credentials — none of this touches them.</p>}
      />
      <div className={v.stack}>
        <OidcCard />
        <SamlCard />
        <SessionsPolicyCard />
      </div>
    </>
  );
}

function OidcCard() {
  const roles = useRoles();
  const act = useAction();
  const providers = useQuery({
    queryKey: ["admin", "oidc-providers"],
    queryFn: () => api.get<{ providers: OidcProvider[] }>("/v1/auth/oidc-providers"),
  });

  const [name, setName] = useState("");
  const [issuerUrl, setIssuerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [defaultRoleId, setDefaultRoleId] = useState("");
  const [jit, setJit] = useState("false");
  const [groupsClaim, setGroupsClaim] = useState("");
  const [deleteProvider, setDeleteProvider] = useState<OidcProvider | null>(null);

  return (
    <Card title="Single sign-on — OIDC providers">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post("/v1/auth/oidc-providers", {
                  name,
                  issuerUrl,
                  clientId,
                  clientSecret,
                  jitProvisioning: jit === "true",
                  ...(domains
                    ? { allowedEmailDomains: domains.split(",").map((s) => s.trim()).filter(Boolean) }
                    : {}),
                  ...(defaultRoleId ? { defaultRoleId } : {}),
                  ...(groupsClaim ? { groupsClaim } : {}),
                }),
              "Provider added",
            )
            .then((ok) => {
              if (ok) {
                setName("");
                setIssuerUrl("");
                setClientId("");
                setClientSecret("");
                setDomains("");
                setDefaultRoleId("");
                setJit("false");
                setGroupsClaim("");
              }
            });
        }}
      >
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="okta-prod" />
        </Field>
        <Field label="Issuer URL" grow>
          <Input
            required
            value={issuerUrl}
            onChange={(e) => setIssuerUrl(e.target.value)}
            placeholder="https://idp.example.com"
          />
        </Field>
        <Field label="Client id">
          <Input required value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label="Client secret">
          <Input
            required
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>
        <Field label="Allowed email domains (comma, empty = any)">
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>
        <Field label="Groups claim (blank = no group signal from this IdP)">
          <Input
            value={groupsClaim}
            onChange={(e) => setGroupsClaim(e.target.value)}
            placeholder="groups"
          />
        </Field>
        <Field label="JIT default role">
          <Select value={defaultRoleId} onChange={(e) => setDefaultRoleId(e.target.value)}>
            {optionEls(roleOpts(roles.data?.roles), "— none —")}
          </Select>
        </Field>
        <Field label="JIT provisioning">
          <Select value={jit} onChange={(e) => setJit(e.target.value)}>
            <option value="false">off — unknown users are refused (default)</option>
            <option value="true">on — first login creates the user (never admin)</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Add provider
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <Table<OidcProvider>
        columns={[
          { key: "name", header: "Name", render: (p) => p.name },
          { key: "issuer", header: "Issuer", render: (p) => <span className={v.mono}>{p.issuerUrl}</span> },
          { key: "clientId", header: "Client id", render: (p) => <span className={v.mono}>{p.clientId}</span> },
          {
            key: "domains",
            header: "Domains",
            render: (p) => (p.allowedEmailDomains ?? []).join(", ") || "any",
          },
          { key: "jit", header: "JIT", render: (p) => (p.jitProvisioning ? "on" : "off") },
          {
            key: "groups",
            header: "Groups",
            render: (p) =>
              p.groupsClaim ? (
                <span className={v.mono}>{p.groupsClaim}</span>
              ) : (
                <span className={v.faint} title="no group signal — logins here never reconcile roles">
                  none
                </span>
              ),
          },
          {
            key: "status",
            header: "Status",
            render: (p) => (p.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (p) => (
              <span className={v.rowTight}>
                <Button
                  size="sm"
                  onClick={() =>
                    void act.run(
                      () => api.patch(`/v1/auth/oidc-providers/${p.id}`, { enabled: !p.enabled }),
                      p.enabled ? "Provider disabled" : "Provider enabled",
                    )
                  }
                >
                  {p.enabled ? "disable" : "enable"}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleteProvider(p)}>
                  delete
                </Button>
              </span>
            ),
          },
        ]}
        rows={providers.data?.providers ?? []}
        rowKey={(p) => p.id}
        loading={providers.isLoading}
        error={providers.error}
        onRetry={() => void providers.refetch()}
        empty={
          <EmptyState
            title="No OIDC providers"
            body="Password sign-in is the only browser path until a provider is added and enabled."
          />
        }
      />
      <p className={v.faint}>
        Authorization-code + PKCE; state and nonce are validated server-side and the client secret is
        stored encrypted, write-only — it is never returned by any endpoint. Sign-in maps the VERIFIED
        email claim to an existing user; with JIT off (the default-deny default) an unknown identity is
        refused and audited. JIT-provisioned users are never admins and get at most the default role picked
        here. The “SSO only” switch below refuses to engage while no SSO provider — OIDC{" "}
        <em>or</em> SAML — is enabled anywhere on this page.
      </p>
      <ConfirmModal
        open={deleteProvider !== null}
        title={`Delete provider “${deleteProvider?.name}”?`}
        body="Users who signed in through it keep their accounts; the sign-in path disappears immediately."
        danger
        confirmLabel="Delete provider"
        onCancel={() => setDeleteProvider(null)}
        onConfirm={() => {
          const p = deleteProvider;
          setDeleteProvider(null);
          if (p) void act.run(() => api.del(`/v1/auth/oidc-providers/${p.id}`), "Provider deleted");
        }}
      />
    </Card>
  );
}

// ---- SAML 2.0 (ADR-0036) --------------------------------------------------

/**
 * The SAML twin of OidcCard. Two things here are load-bearing rather than
 * cosmetic:
 *
 *  - the **metadata URL** is surfaced per provider, because a SAML integration
 *    is set up by hand at the IdP end (there is no `.well-known` discovery) and
 *    this is the document the IdP administrator has to consume;
 *  - an **empty allowed-domain list is warned about in the row itself**. The
 *    ADR requires it to be a conscious choice: with no domains pinned, the
 *    deployment trusts every email address that IdP asserts, and a governance
 *    product must not let that happen quietly.
 */
function SamlCard() {
  const roles = useRoles();
  const act = useAction();
  const providers = useQuery({
    queryKey: ["admin", "saml-providers"],
    queryFn: () => api.get<{ providers: SamlProvider[] }>("/v1/auth/saml-providers"),
  });

  const [name, setName] = useState("");
  const [entityId, setEntityId] = useState("");
  const [idpSsoUrl, setIdpSsoUrl] = useState("");
  const [certs, setCerts] = useState("");
  const [domains, setDomains] = useState("");
  const [emailAttribute, setEmailAttribute] = useState("");
  const [groupsAttribute, setGroupsAttribute] = useState("");
  const [defaultRoleId, setDefaultRoleId] = useState("");
  const [jit, setJit] = useState("false");
  const [idpInitiated, setIdpInitiated] = useState("false");
  const [deleteProvider, setDeleteProvider] = useState<SamlProvider | null>(null);
  const [metadataFor, setMetadataFor] = useState<SamlProvider | null>(null);

  /** several PEM blocks may be pasted at once — a cert ROLLOVER is exactly the
   * case where an operator holds two at the same time. */
  const splitCerts = (raw: string): string[] =>
    raw
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

  return (
    <Card title="Single sign-on — SAML 2.0 providers">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post("/v1/auth/saml-providers", {
                  name,
                  entityId,
                  idpSsoUrl,
                  idpSigningCerts: splitCerts(certs),
                  jitProvisioning: jit === "true",
                  allowIdpInitiated: idpInitiated === "true",
                  ...(emailAttribute ? { emailAttribute } : {}),
                  ...(groupsAttribute ? { groupsAttribute } : {}),
                  ...(domains
                    ? { allowedEmailDomains: domains.split(",").map((x) => x.trim()).filter(Boolean) }
                    : {}),
                  ...(defaultRoleId ? { defaultRoleId } : {}),
                }),
              "SAML provider added",
            )
            .then((ok) => {
              if (ok) {
                setName("");
                setEntityId("");
                setIdpSsoUrl("");
                setCerts("");
                setDomains("");
                setEmailAttribute("");
                setGroupsAttribute("");
                setDefaultRoleId("");
                setJit("false");
                setIdpInitiated("false");
              }
            });
        }}
      >
        <Field label="Name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="adfs-prod" />
        </Field>
        <Field label="IdP entity id (Issuer)" grow>
          <Input
            required
            value={entityId}
            onChange={(e) => setEntityId(e.target.value)}
            placeholder="http://idp.example.com/adfs/services/trust"
          />
        </Field>
        <Field label="IdP sign-on URL" grow>
          <Input
            required
            value={idpSsoUrl}
            onChange={(e) => setIdpSsoUrl(e.target.value)}
            placeholder="https://idp.example.com/adfs/ls/"
          />
        </Field>
        <Field label="IdP signing certificate(s), PEM — paste both during a rollover" grow>
          <Textarea
            required
            rows={4}
            value={certs}
            onChange={(e) => setCerts(e.target.value)}
            placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
          />
        </Field>
        <Field label="Allowed email domains (comma, empty = any — see warning)">
          <Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />
        </Field>
        <Field label="Email attribute (blank = NameID when it is an emailAddress)">
          <Input
            value={emailAttribute}
            onChange={(e) => setEmailAttribute(e.target.value)}
            placeholder="http://schemas.xmlsoap.org/…/emailaddress"
          />
        </Field>
        <Field label="Group attribute (blank = no group signal from this IdP)">
          <Input
            value={groupsAttribute}
            onChange={(e) => setGroupsAttribute(e.target.value)}
            placeholder="memberOf"
          />
        </Field>
        <Field label="JIT default role">
          <Select value={defaultRoleId} onChange={(e) => setDefaultRoleId(e.target.value)}>
            {optionEls(roleOpts(roles.data?.roles), "— none —")}
          </Select>
        </Field>
        <Field label="JIT provisioning">
          <Select value={jit} onChange={(e) => setJit(e.target.value)}>
            <option value="false">off — unknown users are refused (default)</option>
            <option value="true">on — first login creates the user (never admin)</option>
          </Select>
        </Field>
        <Field label="IdP-initiated sign-in">
          <Select value={idpInitiated} onChange={(e) => setIdpInitiated(e.target.value)}>
            <option value="false">off — only sign-ins we started (default)</option>
            <option value="true">on — accept unsolicited assertions</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Add provider
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {!domains && (
        <p className={v.faint}>
          Leaving the domain list empty means this deployment will accept <strong>any</strong> email
          address the IdP asserts. That is a deliberate choice, not a default — pin the domains you
          actually own unless you have a reason not to.
        </p>
      )}
      <Table<SamlProvider>
        columns={[
          { key: "name", header: "Name", render: (p) => p.name },
          { key: "entity", header: "IdP entity id", render: (p) => <span className={v.mono}>{p.entityId}</span> },
          {
            key: "certs",
            header: "Certs",
            render: (p) =>
              p.idpSigningCerts.length > 1 ? (
                <Badge tone="warn" title="a rollover is staged: either certificate verifies">
                  {p.idpSigningCerts.length} pinned
                </Badge>
              ) : (
                "1 pinned"
              ),
          },
          {
            key: "domains",
            header: "Domains",
            render: (p) =>
              p.allowedEmailDomains && p.allowedEmailDomains.length > 0 ? (
                p.allowedEmailDomains.join(", ")
              ) : (
                <Badge tone="warn" title="every email this IdP asserts is trusted">
                  any
                </Badge>
              ),
          },
          { key: "jit", header: "JIT", render: (p) => (p.jitProvisioning ? "on" : "off") },
          {
            key: "groups",
            header: "Groups",
            render: (p) =>
              p.groupsAttribute ? (
                <span className={v.mono}>{p.groupsAttribute}</span>
              ) : (
                <span className={v.faint} title="no group signal — logins here never reconcile roles">
                  none
                </span>
              ),
          },
          {
            key: "idpInit",
            header: "IdP-initiated",
            render: (p) =>
              p.allowIdpInitiated ? <Badge tone="warn">on</Badge> : <span className={v.faint}>off</span>,
          },
          {
            key: "status",
            header: "Status",
            render: (p) => (p.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>),
          },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (p) => (
              <span className={v.rowTight}>
                <Button size="sm" onClick={() => setMetadataFor(p)}>
                  metadata
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void act.run(
                      () => api.patch(`/v1/auth/saml-providers/${p.id}`, { enabled: !p.enabled }),
                      p.enabled ? "Provider disabled" : "Provider enabled",
                    )
                  }
                >
                  {p.enabled ? "disable" : "enable"}
                </Button>
                <Button size="sm" variant="danger" onClick={() => setDeleteProvider(p)}>
                  delete
                </Button>
              </span>
            ),
          },
        ]}
        rows={providers.data?.providers ?? []}
        rowKey={(p) => p.id}
        loading={providers.isLoading}
        error={providers.error}
        onRetry={() => void providers.refetch()}
        empty={
          <EmptyState
            title="No SAML providers"
            body="SAML 2.0 sits beside OIDC, not instead of it — add a provider here if your IdP is configured for SAML."
          />
        }
      />
      <p className={v.faint}>
        Assertions are verified against the certificate(s) pinned here and never against a certificate
        embedded in the document — that pinning is what defeats signature-wrapping. Audience, Recipient
        and the NotBefore/NotOnOrAfter window are all enforced, with a small bounded clock skew, and an
        assertion id is refused if it is presented twice. Sign-in maps the asserted email to an existing
        user — never to a username; with JIT off (the default-deny default) an unknown identity is
        refused and audited, and JIT-provisioned users are never admins. An expired pinned certificate
        fails closed: sign-ins stop rather than being accepted unverified, so stage the incoming
        certificate here before your IdP cuts over.
      </p>
      <Modal
        open={metadataFor !== null}
        title={`Service-provider metadata — “${metadataFor?.name}”`}
        onClose={() => setMetadataFor(null)}
      >
        <p className={v.faint}>
          Give this URL to your IdP administrator. It publishes our entity id, this provider&rsquo;s
          Assertion Consumer Service URL and (when configured) our public certificate — nothing secret.
        </p>
        <CodeBlock>
          {metadataFor ? `${window.location.origin}/auth/saml/${metadataFor.id}/metadata` : ""}
        </CodeBlock>
        <p className={v.faint}>
          Sign-in entry point (what the login page uses):{" "}
          <span className={v.mono}>/auth/saml/{metadataFor?.id}/start</span>
        </p>
      </Modal>
      <ConfirmModal
        open={deleteProvider !== null}
        title={`Delete provider “${deleteProvider?.name}”?`}
        body="Users who signed in through it keep their accounts; the sign-in path disappears immediately."
        danger
        confirmLabel="Delete provider"
        onCancel={() => setDeleteProvider(null)}
        onConfirm={() => {
          const p = deleteProvider;
          setDeleteProvider(null);
          if (p) void act.run(() => api.del(`/v1/auth/saml-providers/${p.id}`), "Provider deleted");
        }}
      />
    </Card>
  );
}

// ---- sessions policy (org sign-in settings) -------------------------------

const AUTH_KEYS = [
  "passwordMinLength",
  "passwordRequireClasses",
  "sessionLifetimeHours",
  "sessionIdleMinutes",
  "mfaRequired",
  "ssoOnly",
  "loginLockoutThreshold",
  "loginLockoutWindowMinutes",
  "loginLockoutMinutes",
] as const;

function SessionsPolicyCard() {
  const q = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings"),
  });
  return (
    <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
      {q.data && <SessionsPolicyForm settings={q.data.settings} />}
    </QueryGate>
  );
}

function SessionsPolicyForm(props: { settings: Record<string, unknown> }) {
  const act = useAction();
  const init = Object.fromEntries(
    AUTH_KEYS.map((k) => [k, props.settings[k] != null ? String(props.settings[k]) : ""]),
  ) as Record<(typeof AUTH_KEYS)[number], string>;
  const [f, setF] = useState(init);
  const set = (k: (typeof AUTH_KEYS)[number], val: string) => setF((s) => ({ ...s, [k]: val }));
  const num = (label: string, k: (typeof AUTH_KEYS)[number]) => (
    <Field label={label}>
      <Input type="number" required value={f[k]} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  return (
    <Card title="Sessions policy — browser sign-in">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(
            () =>
              api.put("/v1/org/settings", {
                passwordMinLength: Number(f.passwordMinLength),
                passwordRequireClasses: Number(f.passwordRequireClasses),
                sessionLifetimeHours: Number(f.sessionLifetimeHours),
                sessionIdleMinutes: Number(f.sessionIdleMinutes),
                mfaRequired: f.mfaRequired,
                ssoOnly: f.ssoOnly === "true",
                loginLockoutThreshold: Number(f.loginLockoutThreshold),
                loginLockoutWindowMinutes: Number(f.loginLockoutWindowMinutes),
                loginLockoutMinutes: Number(f.loginLockoutMinutes),
              }),
            "Sign-in policy saved (audited)",
          );
        }}
      >
        <div className={v.grid3}>
          {num("Password min length", "passwordMinLength")}
          {num("Character classes required (1–4)", "passwordRequireClasses")}
          {num("Session lifetime (hours)", "sessionLifetimeHours")}
          {num("Idle timeout (minutes)", "sessionIdleMinutes")}
          <Field label="Require TOTP MFA">
            <Select value={f.mfaRequired} onChange={(e) => set("mfaRequired", e.target.value)}>
              <option value="off">off (self-service — default)</option>
              <option value="admins">admins must enroll</option>
              <option value="all">everyone must enroll</option>
            </Select>
          </Field>
          <Field label="SSO only">
            <Select value={f.ssoOnly} onChange={(e) => set("ssoOnly", e.target.value)}>
              <option value="false">off — password login allowed (default)</option>
              <option value="true">on — password login refused</option>
            </Select>
          </Field>
          {num("Lock after N failed logins", "loginLockoutThreshold")}
          {num("Failure window (minutes)", "loginLockoutWindowMinutes")}
          {num("Lockout duration (minutes)", "loginLockoutMinutes")}
        </div>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Save sign-in policy
          </Button>
          {act.error && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </div>
        <p className={v.faint}>
          Defaults: 12+ characters using 2 of 4 character classes; sessions live at most 24h with a 2h idle
          wall (any use slides the idle wall, never the lifetime); 5 failures inside 15 minutes lock the
          account for 15 minutes — audited, and the login answer stays the same uniform 401 so lockout
          leaks nothing. “SSO only” will not engage while zero enabled SSO providers exist — OIDC and
          SAML are counted together, and the last enabled provider of either family cannot be disabled
          or deleted while it is on. No self-lockouts.
        </p>
      </form>
    </Card>
  );
}
