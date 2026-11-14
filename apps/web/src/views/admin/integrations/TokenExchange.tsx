/**
 * Upstream token exchange — one card for a selected MCP server and for a connector: the gateway trades a short-lived
 * token that speaks for the calling person for one audienced to this upstream and scoped to the one tool or operation
 * just allowed. Reads never carry the client secret, only its last four characters. Every write (save, clear) is a
 * relaxation the gateway confirms with a step-up, so it goes through `withStepUp`; a refusal is shown next to the form.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt } from "../../../api/format";
import type { Connector, McpServer } from "../../../api/adminTypes";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Badge, Button, Card, ConfirmModal, Field, Input, RowActions, Select } from "../../../ui/kit";
import { QueryGate, connectorOpts, optionEls, useAction, useServerTools, useUsers } from "../adminKit";
import { TTL_CEILING, TTL_FLOOR, bodyOf, formOf, formProblems, refusalWords, type TokenExchangeForm, type TokenExchangeView } from "./tokenExchangeModel";
import v from "../../views.module.css";

type Read = { tokenExchange: TokenExchangeView };
/** the text fields, in order; the secret's label depends on whether one is stored */
const FIELDS = [
  ["tokenEndpoint", "Token endpoint (https)"],
  ["subjectTokenAudience", "Subject token audience"],
  ["audience", "Audience (pinned)"],
  ["resource", "Resource, https (optional)"],
  ["clientId", "Client id"],
  ["clientSecret", ""],
  ["ttl", `Token lifetime ceiling, seconds (${TTL_FLOOR}–${TTL_CEILING})`],
] as const;
/** a 24 px target (WCAG 2.5.8), from the spacing scale */
const BOX = { width: "var(--s3)", height: "var(--s3)", margin: "var(--s0) 0" } as const;
type Write = (h: Record<string, string>, body?: Record<string, unknown>) => Promise<unknown>;
interface Target {
  /** which gateway object the id names; part of the query key so a server and a connector never share a cache entry */
  kind: "server" | "connector";
  id: string;
  name: string;
  load: () => Promise<Read>;
  save: Write;
  clear: Write;
  suggest: string[];
  unit: string;
}

export function McpTokenExchangeCard(props: { server: McpServer | undefined }) {
  const s = props.server;
  const tools = useServerTools(s?.transport === "stdio" ? null : s?.id);
  if (!s || s.transport === "stdio") return null;
  return (
    <Card title="Token exchange">
      <TokenExchange
        key={s.id}
        t={{
          kind: "server",
          id: s.id,
          name: s.name,
          load: () => api.get<Read>(`/v1/servers/${s.id}/token-exchange`),
          save: (h, b) => stepUpApi.put(`/v1/servers/${s.id}/token-exchange`, b, h),
          clear: (h) => stepUpApi.del(`/v1/servers/${s.id}/token-exchange`, undefined, h),
          suggest: (tools.data?.tools ?? []).map((x) => x.name),
          unit: "tool",
        }}
      />
    </Card>
  );
}

export function ConnectorTokenExchangeCard(props: { connectors: Connector[] }) {
  const [id, setId] = useState("");
  const c = props.connectors.find((x) => x.id === id);
  return (
    <Card title="Token exchange">
      <Field label="Connector for token exchange">
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {optionEls(connectorOpts(props.connectors), "Select a connector")}
        </Select>
      </Field>
      {c && (
        <TokenExchange
          key={c.id}
          t={{
            kind: "connector",
            id: c.id,
            name: c.name,
            load: () => api.get<Read>(`/v1/connectors/${c.id}/token-exchange`),
            save: (h, b) => stepUpApi.put(`/v1/connectors/${c.id}/token-exchange`, b, h),
            clear: (h) => stepUpApi.del(`/v1/connectors/${c.id}/token-exchange`, undefined, h),
            suggest: ["read", "write"],
            unit: "operation",
          }}
        />
      )}
    </Card>
  );
}

function TokenExchange({ t }: { t: Target }) {
  const q = useQuery({ queryKey: ["admin", "token-exchange", t.kind, t.id], queryFn: t.load });
  const users = useUsers();
  const act = useAction();
  const view = q.data?.tokenExchange;
  const [f, setF] = useState<TokenExchangeForm>(() => formOf(view));
  const [checked, setChecked] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  // prefilled when the read lands and after each save; the secret stays empty and the switch off
  useEffect(() => setF(formOf(view)), [view]);
  const set = (patch: Partial<TokenExchangeForm>) => setF((x) => ({ ...x, ...patch }));
  const setRow = (i: number, patch: Partial<TokenExchangeForm["rows"][number]>) =>
    setF((x) => ({ ...x, rows: x.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  // a refused write is rethrown in words; anything else (a step-up refusal) keeps the client's own message
  const send = (fn: Write, body?: Record<string, unknown>) =>
    withStepUp((h) => fn(h, body)).catch((e: unknown) => {
      const words = refusalWords(e);
      throw words ? new Error(words) : e;
    });

  if (!view) return <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>{null}</QueryGate>;
  const configured = view.configured;
  const problems = checked ? formProblems(f, configured) : {};
  const setter = (users.data?.users ?? []).find((u) => u.id === view.setBy)?.displayName;
  const list = `tx-${t.id}`;
  const save = (turnOffConfirmed = false) => {
    setChecked(true);
    if (Object.keys(formProblems(f, configured)).length) return;
    // saving an "on" config without the box ticked turns exchange off: say so before it happens
    if (view.enabled && !f.enabled && !turnOffConfirmed) return setConfirmOff(true);
    void act.run(() => send(t.save, bodyOf(f)), `Token exchange for ${t.name} saved`).then(() => {
      // the secret is never kept in the page once it has been sent, saved or not
      set({ clientSecret: "" });
      setChecked(false);
    });
  };

  return (
    <>
      <p>
        <Badge tone={view.enabled ? "warn" : "ok"}>{view.enabled ? "Exchange on" : configured ? "Exchange off" : "Not configured (default)"}</Badge>{" "}
        {configured
          ? `Client secret ending ${view.clientSecretLast4 ?? "—"}, set by ${setter ?? "an admin"}${view.secretSetAt ? ` on ${fmtAt(view.secretSetAt)}` : ""}. Tokens live at most ${view.maxTokenTtlSeconds ?? TTL_CEILING} seconds.`
          : `Nothing is exchanged for ${t.name}. Set it up to send a token scoped to each ${t.unit} instead of a standing credential.`}
      </p>
      <p className={v.dim}>
        The token endpoint's host must be on Egress Allow Hosts, over https. Changing the {t.unit === "tool" ? "server" : "connector"}'s address turns the
        exchange off, and turning it back on asks you to confirm it's you.
      </p>
      <form
        aria-label={`Token exchange for ${t.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className={v.row}>
          {FIELDS.map(([k, label]) => (
            <Field key={k} label={k === "clientSecret" ? (configured ? "Rotate secret (optional)" : "Client secret") : label} error={problems[k]} grow>
              <Input
                type={k === "clientSecret" ? "password" : "text"}
                inputMode={k === "ttl" ? "numeric" : undefined}
                value={f[k]}
                autoComplete={k === "clientSecret" ? "new-password" : "off"}
                spellCheck={false}
                onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
                onBlur={() => setChecked(true)}
              />
            </Field>
          ))}
        </div>
        <p className={v.dim}>{t.unit === "tool" ? "A tool" : "An operation"} with no scopes here is refused while exchange is on.</p>
        <datalist id={list}>
          {t.suggest.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {f.rows.map((r, i) => (
          <div className={v.row} key={i}>
            <Field label={`Action ${i + 1}`} error={problems[`row${i}`]} grow>
              <Input value={r.action} list={list} spellCheck={false} onChange={(e) => setRow(i, { action: e.target.value })} />
            </Field>
            <Field label={`Scopes for action ${i + 1}, separated by spaces`} grow>
              <Input value={r.scopes} spellCheck={false} onChange={(e) => setRow(i, { scopes: e.target.value })} />
            </Field>
            <Button type="button" size="sm" variant="ghost" aria-label={`Remove action ${i + 1}`} onClick={() => set({ rows: f.rows.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="ghost" onClick={() => set({ rows: [...f.rows, { action: "", scopes: "" }] })}>
          Add an action
        </Button>
        <label className={v.row}>
          <input type="checkbox" style={BOX} checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Turn token exchange on{view.enabled ? " (it is on now: tick to keep it on)" : ""}
        </label>
        <RowActions
          primary={
            <Button type="submit" variant="primary" disabled={act.busy}>
              Save token exchange
            </Button>
          }
          secondary={
            configured ? (
              <Button type="button" variant="danger" disabled={act.busy} onClick={() => setConfirmClear(true)}>
                Clear token exchange
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
        open={confirmOff}
        danger
        title={`Turn token exchange off for ${t.name}?`}
        confirmLabel="Save and turn off"
        body={<p>The box to keep it on is not ticked, so saving turns token exchange off. Calls stop receiving an exchanged token until it is turned on again.</p>}
        onCancel={() => setConfirmOff(false)}
        onConfirm={() => {
          setConfirmOff(false);
          save(true);
        }}
      />
      <ConfirmModal
        open={confirmClear}
        danger
        title={`Clear token exchange for ${t.name}?`}
        confirmLabel="Clear token exchange"
        body={<p>The configuration and its stored client secret are destroyed. Calls no longer receive an exchanged token.</p>}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          void act.run(() => send(t.clear), `Token exchange for ${t.name} cleared`);
        }}
      />
    </>
  );
}
