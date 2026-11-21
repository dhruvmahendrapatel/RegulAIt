/**
 * ADR-0315 (G7) — Agent credentials: the registry of audiences that accept RegulAIt's portable agent credential.
 *
 *  - The list shows each audience's URI, pinned algorithm, binding (DPoP or bearer), longest lifetime, its scope map
 *    (which grant scope becomes which scope string at the receiver) and whether it is still issued to.
 *  - Registering an audience always asks the admin to confirm it is them (a `settings_relax` step-up bound to the whole
 *    registration). The confirmation names what the registration loosens beyond the defaults (bearer, a longer life).
 *  - Disabling an audience is a tightening: confirmed, no step-up, audited. A disabled audience is never re-enabled;
 *    register it again instead.
 *  - The issuer's discovery document is linked so the receiver's verifier can be pointed at it.
 *
 * The rules are in `agentCredentialAudiencesModel.ts`. Issuance is the token endpoint's; this page never mints.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Fieldset, Input, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction, useAgents, useConnectors, useServers } from "../adminKit";
import { withRefusalCopy } from "../governance/refusalCopy";
import {
  ALGORITHMS,
  AUDIENCE_REFUSALS,
  BINDING_LABEL,
  BINDINGS,
  createBody,
  draftProblems,
  EMPTY_AUDIENCE,
  EMPTY_SCOPE,
  hasProblems,
  relaxations,
  SCOPE_TYPE_LABEL,
  scopeResource,
  TTL,
  type Audience,
  type AudienceDraft,
  type ScopeDraft,
  type ScopeType,
} from "./agentCredentialAudiencesModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "agent-credential-audiences"] as const;
const DISCOVERY = "/agent-credentials/.well-known/openid-configuration";

export default function AgentCredentialsPage() {
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<{ audiences: Audience[] }>("/v1/agent-credentials/audiences") });
  const servers = useServers();
  const connectors = useConnectors();
  const agents = useAgents();
  const act = useAction();
  const [draft, setDraft] = useState<AudienceDraft>(EMPTY_AUDIENCE);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [disableFor, setDisableFor] = useState<Audience | null>(null);
  const problems = draftProblems(draft);
  const shown = tried ? problems : { rows: [] as Array<string | null> };
  const refetch = () => list.refetch();

  const options = useMemo(
    () => ({
      mcp_tool: (servers.data?.servers ?? []).map((s) => ({ id: s.id, name: s.name })),
      connector: (connectors.data?.connectors ?? []).map((c) => ({ id: c.id, name: c.name })),
      agent: (agents.data?.agents ?? []).map((g) => ({ id: g.id, name: g.name })),
    }),
    [servers.data, connectors.data, agents.data],
  );
  const nameOf = (type: ScopeType) => (id: string) => options[type].find((o) => o.id === id)?.name ?? id;

  const setRow = (i: number, next: Partial<ScopeDraft>) => setDraft({ ...draft, scopes: draft.scopes.map((s, j) => (j === i ? { ...s, ...next } : s)) });
  const submit = () => {
    setTried(true);
    if (!hasProblems(problems) && !act.busy) setConfirming(true);
  };
  const register = () => {
    setConfirming(false);
    const body = createBody(draft);
    void act
      .run(
        () => withRefusalCopy(() => withStepUp((h) => stepUpApi.post("/v1/agent-credentials/audiences", body, h)), AUDIENCE_REFUSALS),
        `Audience ${body.name} registered. Agents may now get a credential for it, within their grants.`,
      )
      .then((done) => {
        if (!done) return;
        setDraft(EMPTY_AUDIENCE);
        setTried(false);
        void refetch();
      });
  };
  const disable = (d: Audience) =>
    void act
      .run(() => withRefusalCopy(() => api.post(`/v1/agent-credentials/audiences/${d.id}/disable`, {}), AUDIENCE_REFUSALS), `${d.name} is disabled. No new credential is issued to it.`)
      .then((done) => done && void refetch());
  const loosens = relaxations(draft);

  return (
    <>
      <PageHeader
        title="Agent credentials"
        sub="The receivers outside RegulAIt that accept an agent's credential, and what each one is allowed to see."
        info={
          <p>
            An agent can carry a short-lived, signed credential to an API gateway or resource server you register here. It
            never holds more than its grant: the scope it gets is the grant's scope mapped through the audience's scope
            map. Nothing is issued to an audience that is not registered. Point the receiver's verifier at{" "}
            <a href={DISCOVERY} target="_blank" rel="noreferrer">
              the issuer's discovery document
            </a>
            .
          </p>
        }
      />
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />

        <Card title="Audiences" count={list.data?.audiences.length}>
          <Table<Audience>
            rows={list.data?.audiences}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void refetch()}
            rowKey={(d) => d.id}
            empty={<EmptyState title="No audience yet" body="Register one below. Until then, no agent credential is issued to anyone." />}
            columns={[
              {
                key: "name",
                header: "Audience",
                render: (d) => (
                  <>
                    <div>{d.name}</div>
                    <div className={v.faint}>{d.audience}</div>
                  </>
                ),
              },
              {
                key: "how",
                header: "Credential",
                render: (d) => (
                  <>
                    <div>
                      {d.algorithm} · {d.binding === "dpop" ? "DPoP" : "Bearer"}
                    </div>
                    <div className={v.faint}>up to {d.maxTtlSeconds} s</div>
                  </>
                ),
              },
              {
                key: "scopes",
                header: "Scope map",
                render: (d) => (
                  <div>
                    {d.scopes.map((s, i) => (
                      <div key={i}>
                        {SCOPE_TYPE_LABEL[s.type]} {scopeResource(s, { server: nameOf("mcp_tool"), connector: nameOf("connector"), agent: nameOf("agent") })} ({s.kind}) →{" "}
                        <code>{s.scope}</code>
                      </div>
                    ))}
                  </div>
                ),
              },
              {
                key: "state",
                header: "State",
                render: (d) => (
                  <>
                    <Badge tone={d.enabled ? "ok" : "neutral"}>{d.enabled ? "Issued to" : "Disabled"}</Badge>
                    <div className={v.faint}>{d.disabledAt ? `disabled ${ago(d.disabledAt)}` : `added ${ago(d.createdAt)}`}</div>
                  </>
                ),
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (d) => (
                  <RowActions
                    primary={
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Disable ${d.name}`}
                        disabled={!d.enabled || act.busy}
                        title={d.enabled ? undefined : "Already disabled. Register the audience again to issue to it."}
                        onClick={() => setDisableFor(d)}
                      >
                        Disable
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
        </Card>

        <Card title="Register an audience">
          <form
            className={v.stack}
            aria-label="Register an audience"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className={a.formRow}>
              <Field label="Name" error={shown.name}>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="payments-api" />
              </Field>
              <Field label="Audience URI" grow error={shown.audience} help="The exact `aud` the receiver checks: https, no query or fragment.">
                <Input value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })} placeholder="https://api.example.internal/payments" />
              </Field>
            </div>
            <div className={a.formRow}>
              <Field label="Algorithm">
                <Select value={draft.algorithm} onChange={(e) => setDraft({ ...draft, algorithm: e.target.value as AudienceDraft["algorithm"] })}>
                  {ALGORITHMS.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Binding" help="DPoP ties the credential to the agent's key, so a copy is useless. Bearer is weaker.">
                <Select value={draft.binding} onChange={(e) => setDraft({ ...draft, binding: e.target.value as AudienceDraft["binding"] })}>
                  {BINDINGS.map((x) => (
                    <option key={x} value={x}>
                      {BINDING_LABEL[x]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Longest life (seconds)" error={shown.maxTtlSeconds} help={`${TTL.min} to ${TTL.max}; the default is ${TTL.default}.`}>
                <Input inputMode="numeric" value={draft.maxTtlSeconds} onChange={(e) => setDraft({ ...draft, maxTtlSeconds: e.target.value })} />
              </Field>
            </div>

            {draft.scopes.map((s, i) => (
              <Fieldset key={i} legend={`Scope ${i + 1}`}>
                <div className={a.formRow}>
                  <Field label="Grants on">
                    <Select value={s.type} onChange={(e) => setRow(i, { type: e.target.value as ScopeType, resourceId: "", toolName: "" })}>
                      {(Object.keys(SCOPE_TYPE_LABEL) as ScopeType[]).map((t) => (
                        <option key={t} value={t}>
                          {SCOPE_TYPE_LABEL[t]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={s.type === "mcp_tool" ? "MCP server" : SCOPE_TYPE_LABEL[s.type]}>
                    <Select value={s.resourceId} onChange={(e) => setRow(i, { resourceId: e.target.value })}>
                      <option value="">Choose…</option>
                      {options[s.type].map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {s.type === "mcp_tool" ? (
                    <Field label="Tool name">
                      <Input value={s.toolName} onChange={(e) => setRow(i, { toolName: e.target.value })} placeholder="create_refund" />
                    </Field>
                  ) : null}
                  <Field label="Access">
                    <Select value={s.kind} onChange={(e) => setRow(i, { kind: e.target.value as ScopeDraft["kind"] })}>
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                    </Select>
                  </Field>
                  <Field label="Scope at the receiver" grow error={shown.rows[i]}>
                    <Input value={s.scope} onChange={(e) => setRow(i, { scope: e.target.value })} placeholder="payments:refund" />
                  </Field>
                  <Field label="&nbsp;">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove scope ${i + 1}`}
                      disabled={draft.scopes.length === 1}
                      onClick={() => setDraft({ ...draft, scopes: draft.scopes.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </Button>
                  </Field>
                </div>
              </Fieldset>
            ))}
            {shown.scopes ? <div className={v.errLine}>{shown.scopes}</div> : null}
            <div className={v.row}>
              <Button size="sm" disabled={draft.scopes.length >= 200} onClick={() => setDraft({ ...draft, scopes: [...draft.scopes, EMPTY_SCOPE] })}>
                Add a scope
              </Button>
              <Button type="submit" variant="primary" disabled={act.busy}>
                Register audience
              </Button>
              <span className={v.faint}>You will be asked to confirm it is you.</span>
            </div>
          </form>
        </Card>
      </div>

      <ConfirmModal
        open={confirming}
        title={`Register ${draft.name.trim() || "this audience"}?`}
        body={
          <>
            <p>
              Agents may then get a credential for {draft.audience.trim()}, within their grants and this scope map. This is
              recorded in the audit trail, and you will be asked to confirm it is you.
            </p>
            {loosens.length > 0 ? (
              <>
                <p>Beyond the defaults, this audience:</p>
                <ul>
                  {loosens.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        }
        confirmLabel="Register and confirm it's me"
        onConfirm={register}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmModal
        open={disableFor !== null}
        danger
        title={disableFor ? `Disable ${disableFor.name}?` : "Disable this audience?"}
        body={<p>No new credential is issued to it. Credentials already issued expire within their short life. It cannot be turned back on; register it again instead.</p>}
        confirmLabel="Disable"
        onConfirm={() => {
          const d = disableFor;
          setDisableFor(null);
          if (d) disable(d);
        }}
        onCancel={() => setDisableFor(null)}
      />
    </>
  );
}
