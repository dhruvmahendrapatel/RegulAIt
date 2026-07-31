/**
 * SSO & sessions (ADR-0025) — OIDC provider CRUD (secrets write-only,
 * default-deny JIT) plus the browser sign-in / session policy (the org
 * password, session, MFA, SSO-only and lockout dials).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { OidcProvider, OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
} from "../../../ui/kit";
import { QueryGate, optionEls, roleOpts, useAction, useRoles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export default function SsoPage() {
  return (
    <>
      <PageHeader
        title="SSO & sessions"
        sub="OIDC single sign-on providers (authorization-code + PKCE, secrets write-only) and the browser sign-in / session policy. API keys and the bootstrap token are machine credentials — none of this touches them."
      />
      <div className={v.stack}>
        <OidcCard />
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
        here. The “SSO only” switch below refuses to engage while no provider here is enabled.
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
          leaks nothing. “SSO only” will not engage while zero enabled OIDC providers exist — no
          self-lockouts.
        </p>
      </form>
    </Card>
  );
}
