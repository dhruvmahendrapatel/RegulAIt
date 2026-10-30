/**
 * Git connections — what git_operation stages execute against. Tokens are
 * AES-256-GCM encrypted at rest and never returned. Every listed kind has a
 * real adapter; per-provider credential hints tell the admin exactly which
 * token to mint.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../../../api/client";
import type { GitConnection } from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import { useToast } from "../../../ui/toast";
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
  const [deleting, setDeleting] = useState<GitConnection | null>(null);
  // #453 prototype: replace the token in place, edit the base URL (the name is referenced by stages)
  const [replacing, setReplacing] = useState<GitConnection | null>(null);
  const [editing, setEditing] = useState<GitConnection | null>(null);

  return (
    <>
      <PageHeader
        title="Git connections"
        info={<p>What git_operation stages execute against. Templates reference a connection by name. Every listed kind has a real adapter — a kind without one is refused at creation, never discovered mid-workflow. The demo runs entirely on the mock provider — no external service is touched.</p>}
      />
      <div className={v.stack}>
        <Card
          title="Add a connection"
          infoLabel="secrets handling"
          info={<p>Tokens are AES-256-GCM encrypted at rest and never returned by any endpoint.</p>}
        >
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
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="for example demo-git" />
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
          {act.guidance ? (
            <RefusalNotice guidance={act.guidance} />
          ) : (
            act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )
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
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (c) => (
                  <RowActions
                    slot="8rem"
                    primary={
                      <Button size="sm" variant="primary" aria-label={`Replace token: ${c.name}`} disabled={act.busy} onClick={() => setReplacing(c)}>
                        Replace token
                      </Button>
                    }
                    secondary={
                      <Button size="sm" aria-label={`Edit ${c.name}`} disabled={act.busy} onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                    }
                    rest={
                      <Button size="sm" variant="danger" disabled={act.busy} onClick={() => setDeleting(c)}>
                        Delete connection
                      </Button>
                    }
                  />
                ),
              },
            ]}
            rows={q.data?.connections ?? []}
            rowKey={(c) => c.name}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={
              <EmptyState
                title="No git connections"
                body="Workflow build/PR stages need one. A mock connection exercises the flow but touches no repository."
              />
            }
          />
        </Card>
      </div>
      <ConfirmModal
        open={deleting !== null}
        title={`Delete git connection “${deleting?.name}”?`}
        body="Its stored token is destroyed. Workflow git stages naming this connection stop until a connection with the same name is added again. The removal is recorded in the audit log."
        danger
        confirmLabel="Delete connection"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const c = deleting;
          setDeleting(null);
          if (c)
            void act.run(
              () => api.del(`/v1/git/connections/${encodeURIComponent(c.name)}`),
              `Git connection “${c.name}” deleted`,
            );
        }}
      />
      {replacing && <ReplaceTokenDialog connection={replacing} onClose={() => setReplacing(null)} />}
      {editing && <EditGitDialog connection={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ReplaceTokenDialog(props: { connection: GitConnection; onClose: () => void }) {
  const act = useAction();
  const [token, setToken] = useState("");
  const c = props.connection;
  const save = () =>
    void act
      .run(
        () => api.post(`/v1/git/connections/${encodeURIComponent(c.name)}/token`, { token }),
        "Token replaced. Revoke the old token on the git host.",
      )
      .then((ok) => ok && props.onClose());
  return (
    <Modal
      open
      title={`Replace the token for “${c.name}”?`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy || !token} onClick={save}>
            Replace token
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <p className={v.flush}>
          The stored token is overwritten and the old one is destroyed here. Git stages use the new token from their next step. The old token
          still works on the git host until you revoke it there. The change is recorded in the audit log.
        </p>
        <Field label="New token">
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="never shown again"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && token) save();
            }}
          />
        </Field>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function EditGitDialog(props: { connection: GitConnection; onClose: () => void }) {
  const act = useAction();
  const c = props.connection;
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const { toast } = useToast();
  const save = () => {
    setRefusal(null);
    let saved = false;
    void act
      .run(async () => {
        try {
          await api.patch(`/v1/git/connections/${encodeURIComponent(c.name)}`, { baseUrl: baseUrl || null });
          saved = true;
        } catch (e) {
          // the egress refusal is answered in the dialog, where the URL is
          if (e instanceof ApiError && e.status === 422 && e.payload?.error === "egress_blocked") {
            setRefusal("That host isn't on the egress allow-list.");
            return;
          }
          throw e;
        }
      }, null)
      .then(() => {
        if (!saved) return;
        toast(`Git connection “${c.name}” updated`, "success");
        props.onClose();
      });
  };
  return (
    <Modal
      open
      title={`Edit git connection “${c.name}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={act.busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <Field label="Name">
          <Input value={c.name} readOnly aria-readonly />
        </Field>
        <Field label="Provider">
          <Input value={c.provider} readOnly aria-readonly />
        </Field>
        <p className={`${v.faint} ${v.flush}`}>
          The name can't change: workflow stages refer to it.
        </p>
        <Field label="Base URL (empty for the provider default)">
          <Input autoFocus value={baseUrl} onChange={(e) => (setBaseUrl(e.target.value), setRefusal(null))} placeholder="https://…" />
        </Field>
        {refusal ? (
          <div className={v.errLine} role="alert" data-testid="edit-refusal">
            {refusal}
          </div>
        ) : (
          act.error && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
