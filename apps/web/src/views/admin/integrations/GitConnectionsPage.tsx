/**
 * Git connections — what git_operation stages execute against. Tokens are
 * AES-256-GCM encrypted at rest and never returned. Every listed kind has a
 * real adapter; per-provider credential hints tell the admin exactly which
 * token to mint.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { GitConnection } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table } from "../../../ui/kit";
import { useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const PROVIDERS: Array<{ v: string; l: string; hint: string; needsBase?: string }> = [
  { v: "mock", l: "mock (demo — touches nothing real)", hint: "No token semantics — any placeholder works. Exercises the full flow against an in-memory repo." },
  { v: "github", l: "GitHub / GitHub Enterprise", hint: "Fine-grained personal access token (or classic with repo scope). Needs Contents read/write + Pull requests read/write on the target repos. For GHE set the base URL (https://ghe.example.com/api/v3)." },
  { v: "gitlab", l: "GitLab", hint: "Project or group access token with the api scope (Developer role or above). Self-managed instances set the base URL (https://gitlab.example.com)." },
  { v: "bitbucket", l: "Bitbucket Cloud", hint: "App password (or workspace access token) with Repositories read/write and Pull requests read/write." },
  { v: "azure_devops", l: "Azure DevOps", hint: "Personal access token with Code (Read & Write) scope. Base URL is your org URL (https://dev.azure.com/<org>).", needsBase: "https://dev.azure.com/<org>" },
];

export default function GitConnectionsPage() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "git-connections"],
    queryFn: () => api.get<{ connections: GitConnection[] }>("/v1/git/connections"),
  });

  const [name, setName] = useState("");
  const [provider, setProvider] = useState("mock");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const selected = PROVIDERS.find((p) => p.v === provider)!;

  return (
    <>
      <PageHeader
        title="Git connections"
        sub="What git_operation stages execute against. Templates reference a connection by name. Every listed kind has a real adapter — a kind without one is refused at creation, never discovered mid-workflow."
      />
      <div className={v.stack}>
        <Card title="Add a connection">
          <form
            className={a.formRow}
            onSubmit={(e) => {
              e.preventDefault();
              void act
                .run(
                  () =>
                    api.post("/v1/git/connections", {
                      name,
                      provider,
                      ...(baseUrl ? { baseUrl } : {}),
                      token,
                    }),
                  "Git connection added",
                )
                .then((ok) => {
                  if (ok) {
                    setName("");
                    setToken("");
                    setBaseUrl("");
                  }
                });
            }}
          >
            <Field label="Name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. demo-git" />
            </Field>
            <Field label="Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => (
                  <option key={p.v} value={p.v}>
                    {p.l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Base URL${selected.needsBase ? ` (${selected.needsBase})` : " (optional, e.g. GHE)"}`}>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field label="Token" grow>
              <Input
                required
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="never shown again"
                autoComplete="off"
              />
            </Field>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Add connection
            </Button>
          </form>
          {act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <p className={v.dim} style={{ marginTop: "var(--s1)" }}>
            <strong>{selected.l}:</strong> {selected.hint}
          </p>
        </Card>

        <Card flush title="Connections">
          <Table<GitConnection>
            columns={[
              { key: "name", header: "Name", sort: (c) => c.name, render: (c) => c.name },
              {
                key: "provider",
                header: "Provider",
                sort: (c) => c.provider,
                render: (c) => (
                  <Badge tone={c.provider === "mock" ? "neutral" : "info"}>{c.provider}</Badge>
                ),
              },
              { key: "baseUrl", header: "Base URL", render: (c) => c.baseUrl ?? "provider default" },
              { key: "created", header: "Created", sort: (c) => c.createdAt, render: (c) => ago(c.createdAt) },
            ]}
            rows={q.data?.connections ?? []}
            rowKey={(c) => c.name}
            loading={q.isLoading}
            empty={
              <EmptyState
                title="No git connections"
                body="Workflow build/PR stages need one. A mock connection exercises the flow but touches no repository."
              />
            }
          />
        </Card>
        <p className={v.faint}>
          Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint. The demo runs
          entirely on the mock provider — no external service is touched.
        </p>
      </div>
    </>
  );
}
