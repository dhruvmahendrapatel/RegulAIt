/**
 * Model credentials — write-only by construction: one platform credential per
 * provider, AES-256-GCM encrypted at rest, never returned by any endpoint.
 * Shows provider status (platform credential OR env-var presence), the agents
 * still waiting on a credential, and per-user BYO keys (view / remove).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { ModelCredential, OrgSettingsResponse } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { optionEls, useAction, useAgents, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const PROVIDERS = ["anthropic", "openai", "google", "xai"];

export default function ModelCredentialsPage() {
  const agents = useAgents();
  const act = useAction();
  const creds = useQuery({
    queryKey: ["admin", "model-credentials"],
    queryFn: () => api.get<{ credentials: ModelCredential[] }>("/v1/model-credentials"),
  });
  const status = useQuery({
    queryKey: ["admin", "provider-status"],
    queryFn: () => api.get<{ providers: Record<string, { configured: boolean }> }>("/v1/model-providers/status"),
  });
  const org = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings"),
  });

  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [removeCred, setRemoveCred] = useState<string | null>(null);

  const configured = new Set((creds.data?.credentials ?? []).map((c) => c.provider));
  const waiting = (agents.data?.agents ?? []).filter(
    (x) => x.provider !== "mock" && !(status.data?.providers[x.provider]?.configured ?? false),
  );
  const envKeys = org.data?.envKeys ?? [];
  const settings = org.data?.settings ?? {};

  return (
    <>
      <PageHeader
        title="Model credentials"
        sub="One platform credential per provider, encrypted at rest. Re-adding a provider rotates its key in place; nothing here ever reads a stored secret back."
      />
      <div className={v.stack}>
        <Card title="Add or rotate a platform credential">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post("/v1/model-credentials", {
                      provider,
                      apiKey,
                      ...(baseUrl ? { baseUrl } : {}),
                    }),
                  configured.has(provider) ? "Credential rotated in place" : "Credential saved",
                )
                .then((ok) => {
                  if (ok) {
                    setApiKey("");
                    setBaseUrl("");
                  }
                });
            }}
          >
            <Field label="Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="API key" grow>
              <Input
                required
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
            </Field>
            <Field label="Base URL (optional override)">
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Save credential
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <p className={v.faint}>
            Sent once, stored AES-256-GCM encrypted, never returned by any endpoint — not to this page, not
            to anyone.
          </p>
        </Card>

        <Card title="Configured providers">
          <Table<ModelCredential>
            columns={[
              { key: "provider", header: "Provider", render: (c) => c.provider },
              { key: "baseUrl", header: "Base URL", render: (c) => c.baseUrl ?? "provider default" },
              { key: "configured", header: "Configured", render: (c) => ago(c.createdAt) },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (c) => (
                  <Button size="sm" variant="danger" onClick={() => setRemoveCred(c.provider)}>
                    remove
                  </Button>
                ),
              },
            ]}
            rows={creds.data?.credentials ?? []}
            rowKey={(c) => c.provider}
            loading={creds.isLoading}
            empty={
              <EmptyState
                title="No platform credentials yet"
                body="Until a real key is configured every dispatch runs on the MOCK provider — answers are simulated and spend is $0."
              />
            }
          />
        </Card>

        <Card title="Env keys present on this server">
          <Table
            columns={[
              { key: "provider", header: "Provider", render: (k: NonNullable<OrgSettingsResponse["envKeys"]>[number]) => k.provider },
              { key: "envVar", header: "Env var", render: (k) => <span className={v.mono}>{k.envVar}</span> },
              {
                key: "present",
                header: "Present",
                render: (k) => (k.present ? <Badge tone="ok">present</Badge> : <Badge>not set</Badge>),
              },
              {
                key: "allowed",
                header: "Fallback",
                render: (k) =>
                  Boolean(settings.envKeyFallbackEnabled) &&
                  ((settings.envFallbackProviders as string[] | undefined) ?? []).includes(k.provider) ? (
                    <Badge tone="ok">fallback allowed</Badge>
                  ) : (
                    <Badge tone="warn">fallback blocked</Badge>
                  ),
              },
            ]}
            rows={envKeys}
            rowKey={(k) => k.provider}
            loading={org.isLoading}
            empty={<EmptyState title="No env vars surfaced" />}
          />
          <p className={v.faint}>
            Names and presence only — a key's value is never read back by any endpoint. “Fallback blocked”
            means the var may exist but dispatches will not use it (Settings → Organization owns the
            toggle).
          </p>
        </Card>

        <Card title="Agents waiting on a credential">
          {waiting.length === 0 ? (
            <EmptyState title="Every non-mock agent has a live provider" />
          ) : (
            <Table
              columns={[
                { key: "agent", header: "Agent", render: (x: (typeof waiting)[number]) => x.name },
                { key: "provider", header: "Provider", render: (x) => x.provider },
                { key: "model", header: "Model", render: (x) => x.model ?? "—" },
                {
                  key: "status",
                  header: "Status",
                  render: () => <Badge tone="warn">no credential — dispatch returns 409</Badge>,
                },
              ]}
              rows={waiting}
              rowKey={(x) => x.id}
            />
          )}
        </Card>

        <ByoKeysCard />
      </div>

      <ConfirmModal
        open={removeCred !== null}
        title={`Remove the ${removeCred} platform credential?`}
        body="Dispatches to this provider fall back to the env var (if allowed) or start answering 409."
        danger
        confirmLabel="Remove"
        onCancel={() => setRemoveCred(null)}
        onConfirm={() => {
          const p = removeCred;
          setRemoveCred(null);
          if (p)
            void act.run(
              () => api.del(`/v1/model-credentials/${encodeURIComponent(p)}`),
              "Credential removed",
            );
        }}
      />
    </>
  );
}

function ByoKeysCard() {
  const users = useUsers();
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [rows, setRows] = useState<ModelCredential[] | null>(null);
  const [removeByo, setRemoveByo] = useState<string | null>(null);

  const load = async (uid: string) => {
    const r = await api.get<{ credentials: ModelCredential[] }>(`/v1/users/${uid}/model-credentials`);
    setRows(r.credentials);
  };

  return (
    <Card title="Per-user BYO keys">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(() => load(userId), null);
        }}
      >
        <Field label="User" grow>
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select —")}
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
      {rows &&
        (rows.length === 0 ? (
          <EmptyState
            title="This user has no keys of their own"
            body="Their dispatches use the platform credential."
          />
        ) : (
          <Table<ModelCredential>
            columns={[
              { key: "provider", header: "Provider", render: (c) => c.provider },
              { key: "baseUrl", header: "Base URL", render: (c) => c.baseUrl ?? "provider default" },
              { key: "added", header: "Added", render: (c) => ago(c.createdAt) },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (c) => (
                  <Button size="sm" variant="danger" onClick={() => setRemoveByo(c.provider)}>
                    remove
                  </Button>
                ),
              },
            ]}
            rows={rows}
            rowKey={(c) => c.provider}
          />
        ))}
      <p className={v.faint}>
        Users add their own keys from the workspace → Account. A user's own key wins over the platform's
        for their dispatches — unless key custody is enforced (Client access), which keeps these rows
        inert.
      </p>
      <ConfirmModal
        open={removeByo !== null}
        title={`Remove this user's ${removeByo} key?`}
        danger
        confirmLabel="Remove key"
        onCancel={() => setRemoveByo(null)}
        onConfirm={() => {
          const p = removeByo;
          setRemoveByo(null);
          if (p)
            void act
              .run(
                () => api.del(`/v1/users/${userId}/model-credentials/${encodeURIComponent(p)}`),
                "Key removed",
              )
              .then((ok) => ok && void load(userId));
        }}
      />
    </Card>
  );
}
