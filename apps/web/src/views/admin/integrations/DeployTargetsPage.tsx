/**
 * Deploy targets — the governed destinations a deployment/rollback stage acts
 * on. Per-provider fields adapt: mock needs nothing; aws needs a role ARN +
 * region; azure/gcp reuse the role/account field for their subscription /
 * project; kubernetes needs a kubeconfig credential. Credentials are
 * encrypted at rest and never returned.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { DeployTarget } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const PROVIDER_FIELDS: Record<
  string,
  { role?: { label: string; ph: string; required?: boolean }; region?: string; credential?: { label: string; required?: boolean } }
> = {
  mock: {},
  aws: {
    role: { label: "IAM role ARN", ph: "arn:aws:iam::123456789012:role/regulait-deploy", required: true },
    region: "e.g. us-east-1",
  },
  azure: { role: { label: "Subscription id", ph: "00000000-…" }, region: "e.g. westeurope", credential: { label: "Service-principal credential (optional)" } },
  gcp: { role: { label: "Project id", ph: "my-project" }, region: "e.g. europe-west1", credential: { label: "Service-account key JSON (optional)" } },
  kubernetes: { region: "namespace (optional)", credential: { label: "kubeconfig (required)", required: true } },
};

export default function DeployTargetsPage() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "deploy-targets"],
    queryFn: () => api.get<{ targets: DeployTarget[] }>("/v1/deploy/targets"),
  });

  const [f, setF] = useState({
    name: "",
    provider: "mock",
    mode: "hosted",
    environment: "",
    baseUrl: "",
    roleArn: "",
    region: "",
    credential: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const [deleteTarget, setDeleteTarget] = useState<DeployTarget | null>(null);
  const fields = PROVIDER_FIELDS[f.provider] ?? {};

  return (
    <>
      <PageHeader
        title="Deploy targets"
        sub="Where a deployment or rollback stage acts. Every non-mock kind is a dry-run shape, and a dry run can never satisfy a production deploy gate."
        info={<p>Where a deployment/rollback stage acts. mock runs everywhere with no credential; aws/azure/gcp/kubernetes execute as deterministic dry-run shapes — a dry-run deploy is recorded and badged as such, and it can never satisfy a production deploy gate.</p>}
      />
      <div className={v.stack}>
        <Card title="Add a target">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post("/v1/deploy/targets", {
                      name: f.name,
                      provider: f.provider,
                      mode: f.mode,
                      ...(f.environment ? { environment: f.environment } : {}),
                      ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
                      ...(f.roleArn ? { roleArn: f.roleArn } : {}),
                      ...(f.region ? { region: f.region } : {}),
                      ...(f.credential ? { credential: f.credential } : {}),
                    }),
                  "Deploy target added",
                )
                .then((ok) => {
                  if (ok)
                    setF({ name: "", provider: "mock", mode: "hosted", environment: "", baseUrl: "", roleArn: "", region: "", credential: "" });
                });
            }}
          >
            <Field label="Name">
              <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. staging-us" />
            </Field>
            <Field label="Provider">
              <Select value={f.provider} onChange={(e) => set("provider", e.target.value)}>
                {["mock", "aws", "azure", "gcp", "kubernetes"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mode">
              <Select value={f.mode} onChange={(e) => set("mode", e.target.value)}>
                <option value="hosted">hosted</option>
                <option value="byoc">byoc</option>
                <option value="air_gapped">air_gapped</option>
              </Select>
            </Field>
            <Field label="Environment (optional)">
              <Input value={f.environment} onChange={(e) => set("environment", e.target.value)} placeholder="e.g. production" />
            </Field>
            <Field label="Base URL (optional)">
              <Input value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} />
            </Field>
            {fields.role && (
              <Field label={fields.role.label}>
                <Input
                  required={fields.role.required}
                  value={f.roleArn}
                  onChange={(e) => set("roleArn", e.target.value)}
                  placeholder={fields.role.ph}
                />
              </Field>
            )}
            {fields.region && (
              <Field label="Region / namespace">
                <Input value={f.region} onChange={(e) => set("region", e.target.value)} placeholder={fields.region} />
              </Field>
            )}
            {fields.credential && (
              <Field label={fields.credential.label} grow>
                <Textarea
                  required={fields.credential.required}
                  rows={3}
                  value={f.credential}
                  onChange={(e) => set("credential", e.target.value)}
                  placeholder="never shown again"
                  style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                />
              </Field>
            )}
            <Button type="submit" variant="primary" disabled={act.busy}>
              Add target
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <p className={v.faint}>
            Credentials are AES-256-GCM encrypted at rest and never returned. An aws target needs a role
            ARN (arn:aws:iam::&lt;acct&gt;:role/&lt;name&gt;) and region; azure/gcp reuse the role/account
            field for their subscription/project; kubernetes needs a kubeconfig credential.
          </p>
        </Card>

        <Card flush title="Targets">
          <Table<DeployTarget>
            columns={[
              { key: "name", header: "Name", sort: (t) => t.name, render: (t) => t.name },
              {
                key: "provider",
                header: "Provider",
                render: (t) => <Badge tone={t.provider === "mock" ? "neutral" : "info"}>{t.provider}</Badge>,
              },
              { key: "mode", header: "Mode", render: (t) => t.mode },
              { key: "environment", header: "Environment", render: (t) => t.environment ?? "—" },
              {
                key: "role",
                header: "Role / account",
                render: (t) => (t.roleArn ? <span className={v.mono}>{t.roleArn}</span> : "—"),
              },
              { key: "region", header: "Region", render: (t) => t.region ?? "—" },
              { key: "created", header: "Created", render: (t) => ago(t.createdAt) },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (t) => (
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(t)}>
                    delete
                  </Button>
                ),
              },
            ]}
            rows={q.data?.targets ?? []}
            rowKey={(t) => t.name}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={
              <EmptyState
                title="No deploy targets"
                body="A deployment stage naming a target that doesn't exist parks at a manual handoff."
              />
            }
          />
        </Card>
      </div>
      <ConfirmModal
        open={deleteTarget !== null}
        title={`Delete target “${deleteTarget?.name}”?`}
        body="Deployment stages naming it will park at a manual handoff."
        danger
        confirmLabel="Delete target"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const t = deleteTarget;
          setDeleteTarget(null);
          if (t)
            void act.run(
              () => api.del(`/v1/deploy/targets/${encodeURIComponent(t.name)}`),
              "Target deleted",
            );
        }}
      />
    </>
  );
}
