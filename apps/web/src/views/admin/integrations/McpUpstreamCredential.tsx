/**
 * ADR-0204 — the upstream credential card on a selected MCP server: set, rotate or clear the one secret the gateway
 * sends to that server (`PUT`/`DELETE /v1/servers/:id/upstream-credential`). Each write is a relaxation the gateway
 * confirms with a step-up, so it goes through `withStepUp`. The secret is write-only: the card shows whether one is
 * set, how it is sent, its last four characters, and who set it and when. A refusal is shown inline next to the form;
 * Clear sits in the secondary slot behind a confirmation.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import type { McpServer } from "../../../api/adminTypes";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Badge, Button, Card, ConfirmModal, Field, Input, RowActions, Select } from "../../../ui/kit";
import { QueryGate, useAction, useUsers } from "../adminKit";
import {
  UPSTREAM_CREDENTIAL_SCHEME_OPTIONS,
  headerNameProblem,
  secretProblem,
  sentAs,
  type UpstreamCredentialScheme,
  type UpstreamCredentialView,
} from "./mcpUpstreamCredentialModel";
import v from "../../views.module.css";

export function McpUpstreamCredentialCard(props: { server: McpServer | undefined }) {
  const { server } = props;
  if (!server) return null;
  if (server.transport === "stdio") {
    return (
      <Card title="Upstream credential">
        <p>A stdio server has no HTTP request to carry a credential.</p>
      </Card>
    );
  }
  return <CredentialCard key={server.id} server={server} />;
}

function CredentialCard(props: { server: McpServer }) {
  const { server } = props;
  const url = `/v1/servers/${server.id}/upstream-credential`;
  const q = useQuery({
    queryKey: ["admin", "mcp-upstream-credential", server.id],
    queryFn: () => api.get<{ credential: UpstreamCredentialView }>(url),
  });
  const users = useUsers();
  const act = useAction();
  const [scheme, setScheme] = useState<UpstreamCredentialScheme>("bearer");
  const [headerName, setHeaderName] = useState("");
  const [secret, setSecret] = useState("");
  // the checks show once a field has been left or the form submitted (on blur, never on every keystroke)
  const [checked, setChecked] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const view = q.data?.credential;
  const isSet = view?.set === true;
  const headerError = checked && scheme === "header" ? headerNameProblem(headerName) : null;
  const secretError = checked ? secretProblem(secret) : null;
  const setter = (users.data?.users ?? []).find((u) => u.id === view?.setBy)?.displayName;

  const save = () => {
    setChecked(true);
    if ((scheme === "header" && headerNameProblem(headerName)) || secretProblem(secret)) return;
    const body = { scheme, ...(scheme === "header" ? { headerName: headerName.trim() } : {}), secret, rotate: isSet };
    void act
      .run(() => withStepUp((h) => stepUpApi.put(url, body, h)), isSet ? `Credential for ${server.name} rotated` : `Credential for ${server.name} saved`)
      .then((ok) => {
        // the secret is never kept in the page once it has been sent, saved or not
        setSecret("");
        setChecked(false);
        if (ok) setHeaderName("");
      });
  };
  const clear = () => {
    setConfirmClear(false);
    void act.run(() => withStepUp((h) => stepUpApi.del(url, undefined, h)), `Credential for ${server.name} cleared`);
  };

  if (!view) return <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>{null}</QueryGate>;
  return (
    <Card
      title="Upstream credential"
      actions={<Badge tone={view.set ? "warn" : "ok"}>{view.set ? "Credential set" : "Nothing sent (default)"}</Badge>}
    >
      <p>
        {view.set
          ? `${sentAs(view)} Only to this server's address. Set by ${setter ?? "an admin"}${view.setAt ? ` on ${fmtAt(view.setAt)}` : ""}.`
          : "Nothing is sent to this server. Set a key if it checks one; you will be asked to confirm it's you."}
      </p>
      <p className={v.dim}>The key is never shown again. A change of the server&apos;s URL clears it.</p>
      <form
        aria-label={`Upstream credential for ${server.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className={v.row}>
          <Field label="Sent as">
            <Select value={scheme} onChange={(e) => setScheme(e.target.value === "header" ? "header" : "bearer")}>
              {UPSTREAM_CREDENTIAL_SCHEME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          {scheme === "header" && (
            <Field label="Header name" error={headerError}>
              <Input
                value={headerName}
                placeholder="X-API-Key"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setHeaderName(e.target.value)}
                onBlur={() => setChecked(true)}
              />
            </Field>
          )}
          <Field label={view.set ? "New key or token" : "Key or token"} error={secretError} grow>
            <Input
              type="password"
              value={secret}
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setSecret(e.target.value)}
              onBlur={() => setChecked(true)}
            />
          </Field>
        </div>
        <RowActions
          primary={
            <Button type="submit" variant="primary" disabled={act.busy}>
              {view.set ? "Rotate credential" : "Save credential"}
            </Button>
          }
          secondary={
            view.set ? (
              <Button type="button" variant="danger" disabled={act.busy} onClick={() => setConfirmClear(true)}>
                Clear credential
              </Button>
            ) : null
          }
        />
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
        <RefusalNotice guidance={act.guidance} />
      </form>
      <ConfirmModal
        open={confirmClear}
        danger
        title={`Clear the credential for ${server.name}?`}
        confirmLabel="Clear credential"
        body={
          <p>The stored key is destroyed. If {server.name} needs a key, its calls fail until a new one is set.</p>
        }
        onCancel={() => setConfirmClear(false)}
        onConfirm={clear}
      />
    </Card>
  );
}
