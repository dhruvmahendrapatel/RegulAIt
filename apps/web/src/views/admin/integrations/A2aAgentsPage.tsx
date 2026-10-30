/**
 * ADR-0219 (P10) — Remote agents (A2A): the registry of remote agents the gateway may call over the agent-to-agent
 * protocol, each one's write-only credential, and who may call it. It sits beside Agents and MCP servers because it
 * does the same job for a third kind of callable: register, credential, grant per person.
 *
 * Off by default: while the organisation setting is off the page says so and the registration form is refused inline
 * with the reason and a link to the setting. Registration reads the agent's card; a private-network address needs the
 * opt-in, which you are asked to confirm (step-up). Nobody may call a registered agent until they are given access.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Badge, Button, Card, EmptyState, Field, Input, RowActions, Select, Table } from "../../../ui/kit";
import { QueryGate, RemoveButton, optionEls, useAction, useUsers, userOpts } from "../adminKit";
import { StaticCredentialCard } from "./McpUpstreamCredential";
import type { UpstreamCredentialView } from "./mcpUpstreamCredentialModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface A2aSkill {
  id: string;
  name: string;
  description: string;
}
interface A2aAgent {
  id: string;
  name: string;
  url: string;
  cardName: string;
  cardDescription: string;
  cardVersion: string;
  skills: A2aSkill[];
  cardFetchedAt: string;
  allowPrivateRanges: boolean | null;
  pricePerCallUsd: number | null;
  enabled: boolean;
  credential: UpstreamCredentialView;
}
interface A2aGrant {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  skillId: string | null;
  createdAt: string;
}

const LIST_KEY = ["admin", "a2a-agents"] as const;
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export default function A2aAgentsPage() {
  const q = useQuery({ queryKey: LIST_KEY, queryFn: () => api.get<{ enabled: boolean; agents: A2aAgent[] }>("/v1/a2a/agents") });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = q.data?.agents ?? [];
  const selected = agents.find((x) => x.id === selectedId);
  return (
    <>
      <PageHeader
        title="Remote agents (A2A)"
        info={
          <p>
            Register agents run by other teams or vendors that speak the agent-to-agent (A2A) protocol. Every call is
            checked against the caller&apos;s own access, sent under the same network rules as MCP servers, costed to the
            project and recorded in the audit trail. A worker agent calls only as the person who started its run.
          </p>
        }
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        <div className={v.stack}>
          <Card
            title="Registry"
            actions={<Badge tone={q.data?.enabled ? "warn" : "ok"}>{q.data?.enabled ? "Calls to remote agents on" : "Off (default)"}</Badge>}
          >
            {!q.data?.enabled && (
              <p role="status">
                Calls to remote agents are off for this organisation, so none can be registered or called. An admin can turn
                them on in <Link to="/admin/organization" style={{ textDecoration: "underline" }}>Organisation settings</Link>.
              </p>
            )}
            <RegisterForm enabled={q.data?.enabled === true} />
            <Table<A2aAgent>
              columns={[
                { key: "name", header: "Name", sort: (x) => x.name, render: (x) => x.name },
                { key: "url", header: "Address", render: (x) => <span className={v.mono}>{x.url}</span> },
                { key: "skills", header: "Skills", render: (x) => (x.skills.length === 0 ? <span className={v.dim}>None listed</span> : x.skills.map((s) => s.name).join(", ")) },
                {
                  key: "price",
                  header: "Price / call",
                  sort: (x) => x.pricePerCallUsd ?? -1,
                  render: (x) => (x.pricePerCallUsd == null ? <span className={v.dim}>Unpriced</span> : <span className={v.mono}>{fmtUsd(x.pricePerCallUsd)}</span>),
                },
                { key: "credential", header: "Credential", render: (x) => (x.credential.set ? `Set (…${x.credential.last4 ?? ""})` : "None") },
                { key: "state", header: "Status", render: (x) => <Badge tone={x.enabled ? "ok" : "neutral"}>{x.enabled ? "On" : "Off"}</Badge> },
                { key: "actions", header: "Actions", render: (x) => <AgentRowActions agent={x} selected={x.id === selectedId} onManage={() => setSelectedId(x.id === selectedId ? null : x.id)} /> },
              ]}
              rows={agents}
              rowKey={(x) => x.id}
              empty={<EmptyState title="No remote agents registered" body={q.data?.enabled ? "Register the first remote agent above." : "Turn on calls to remote agents first."} />}
            />
          </Card>
          {selected && <AgentDetail key={selected.id} agent={selected} />}
        </div>
      </QueryGate>
    </>
  );
}

function RegisterForm(props: { enabled: boolean }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [privateRanges, setPrivateRanges] = useState<"inherit" | "allow">("inherit");
  const [price, setPrice] = useState("");
  const [checked, setChecked] = useState(false);
  const nameError = checked && !NAME_SHAPE.test(name) ? "Use lower-case letters, digits and hyphens, starting with a letter or digit (at most 63)." : null;
  const priceError = checked && price.trim() !== "" && !(Number(price) >= 0 && Number(price) <= 1000) ? "A price is a number from 0 to 1000 (US dollars per call)." : null;
  const submit = () => {
    setChecked(true);
    if (!NAME_SHAPE.test(name) || url.trim() === "" || (price.trim() !== "" && !(Number(price) >= 0 && Number(price) <= 1000))) return;
    const body = { name, url: url.trim(), ...(privateRanges === "allow" ? { allowPrivateRanges: true } : {}), ...(price.trim() !== "" ? { pricePerCallUsd: Number(price) } : {}) };
    void act.run(() => withStepUp((h) => stepUpApi.post("/v1/a2a/agents", body, h)), `Remote agent ${name} registered`).then((ok) => {
      if (!ok) return;
      setName("");
      setUrl("");
      setPrice("");
      setPrivateRanges("inherit");
      setChecked(false);
    });
  };
  return (
    <form
      className={a.formRow}
      aria-label="Register a remote agent"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Name" error={nameError}>
        <Input value={name} placeholder="claims-triage" autoComplete="off" spellCheck={false} disabled={!props.enabled} onChange={(e) => setName(e.target.value)} onBlur={() => setChecked(true)} />
      </Field>
      <Field label="Agent address (its card is read from here)" grow>
        <Input value={url} type="url" placeholder="https://agents.regulait.example" autoComplete="off" spellCheck={false} disabled={!props.enabled} onChange={(e) => setUrl(e.target.value)} />
      </Field>
      <Field label="Private network address">
        <Select value={privateRanges} disabled={!props.enabled} onChange={(e) => setPrivateRanges(e.target.value === "allow" ? "allow" : "inherit")}>
          <option value="inherit">follow the organisation default (default)</option>
          <option value="allow">allow (you will be asked to confirm)</option>
        </Select>
      </Field>
      <Field label="Price per call (USD, optional)" error={priceError}>
        <Input value={price} inputMode="decimal" placeholder="0.01" disabled={!props.enabled} onChange={(e) => setPrice(e.target.value)} onBlur={() => setChecked(true)} />
      </Field>
      <Button type="submit" variant="primary" disabled={!props.enabled || act.busy}>
        Register agent
      </Button>
      <p className={v.dim}>
        The address must be on the network allow-list, like an MCP server&apos;s. The agent&apos;s card must offer a JSON-RPC
        interface on this same address; a card that points elsewhere is refused.
      </p>
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <RefusalNotice guidance={act.guidance} />
    </form>
  );
}

function AgentRowActions(props: { agent: A2aAgent; selected: boolean; onManage: () => void }) {
  const { agent } = props;
  const act = useAction();
  return (
    <span>
      <RowActions
        slot="8rem"
        primary={
          <Button size="sm" variant={props.selected ? "primary" : "default"} aria-expanded={props.selected} aria-label={`Manage ${agent.name}`} onClick={props.onManage}>
            {props.selected ? "Close" : "Manage"}
          </Button>
        }
        secondary={
          <Button size="sm" variant="ghost" disabled={act.busy} aria-label={`Refresh the card of ${agent.name}`} onClick={() => void act.run(() => api.post(`/v1/a2a/agents/${agent.id}/card`), `Card of ${agent.name} refreshed`)}>
            Refresh card
          </Button>
        }
        rest={
          <>
            <Button size="sm" variant="ghost" disabled={act.busy} aria-label={`${agent.enabled ? "Turn off" : "Turn on"} ${agent.name}`} onClick={() => void act.run(() => api.patch(`/v1/a2a/agents/${agent.id}`, { enabled: !agent.enabled }), `${agent.name} turned ${agent.enabled ? "off" : "on"}`)}>
              {agent.enabled ? "Turn off" : "Turn on"}
            </Button>
            <RemoveButton
              what={`remote agent ${agent.name}`}
              consequence={<p>Its credential is destroyed and everyone&apos;s access to it is removed. Past calls stay in the audit trail.</p>}
              onRemove={() => api.del(`/v1/a2a/agents/${agent.id}`)}
            />
          </>
        }
      />
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </span>
  );
}

function AgentDetail(props: { agent: A2aAgent }) {
  const { agent } = props;
  return (
    <>
      <Card title={`${agent.cardName || agent.name}${agent.cardVersion ? ` · ${agent.cardVersion}` : ""}`}>
        {agent.cardDescription && <p>{agent.cardDescription}</p>}
        <p className={v.dim}>Card read on {fmtAt(agent.cardFetchedAt)}. Refresh it after the agent changes its skills.</p>
        <Table<A2aSkill>
          columns={[
            { key: "name", header: "Skill", render: (s) => s.name },
            { key: "description", header: "What it does", render: (s) => s.description || <span className={v.dim}>No description</span> },
          ]}
          rows={agent.skills}
          rowKey={(s) => s.id}
          empty={<EmptyState title="The card lists no skills" body="People can still be given access to the whole agent." />}
        />
      </Card>
      <StaticCredentialCard
        load={() => api.get<{ credential: UpstreamCredentialView }>(`/v1/a2a/agents/${agent.id}/credential`)}
        save={(body, h) => stepUpApi.put(`/v1/a2a/agents/${agent.id}/credential`, body, h)}
        clear={(h) => stepUpApi.del(`/v1/a2a/agents/${agent.id}/credential`, undefined, h)}
        queryKey={["admin", "a2a-credential", agent.id]}
        name={agent.name}
        title="Credential"
        target="this agent"
        footnote="The key is never shown again. It is sent only to this agent's own address."
      />
      <AccessCard agent={agent} />
    </>
  );
}

function AccessCard(props: { agent: A2aAgent }) {
  const { agent } = props;
  const url = `/v1/a2a/agents/${agent.id}/grants`;
  const q = useQuery({ queryKey: ["admin", "a2a-grants", agent.id], queryFn: () => api.get<{ grants: A2aGrant[] }>(url) });
  const users = useUsers();
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [skillId, setSkillId] = useState("");
  const skillName = (id: string | null) => (id === null ? "Every skill" : (agent.skills.find((s) => s.id === id)?.name ?? id));
  return (
    <Card title="Who may call it">
      <p>Nobody may call this agent until they are given access here. A worker agent never has access of its own: it calls as the person who started its run, and only where its lead allows.</p>
      <form
        className={a.formRow}
        aria-label={`Give access to ${agent.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!userId) return;
          void act.run(() => api.post(url, { userId, ...(skillId ? { skillId } : {}) }), "Access given").then((ok) => {
            if (ok) setUserId("");
          });
        }}
      >
        <Field label="Person">
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "Choose a person")}
          </Select>
        </Field>
        <Field label="Skill">
          <Select value={skillId} onChange={(e) => setSkillId(e.target.value)}>
            <option value="">Every skill</option>
            {agent.skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy || !userId}>
          Give access
        </Button>
      </form>
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <Table<A2aGrant>
        columns={[
          { key: "person", header: "Person", sort: (g) => g.email, render: (g) => `${g.displayName} · ${g.email}` },
          { key: "skill", header: "Skill", render: (g) => skillName(g.skillId) },
          { key: "since", header: "Since", render: (g) => fmtAt(g.createdAt) },
          {
            key: "actions",
            header: "Actions",
            render: (g) => (
              <RowActions
                slot="6rem"
                rest={<RemoveButton what={`${g.displayName}'s access to ${agent.name}`} consequence={<p>{g.displayName} can no longer call {skillName(g.skillId).toLowerCase()} on this agent.</p>} onRemove={() => api.del(`${url}/${g.id}`)} />}
              />
            ),
          },
        ]}
        rows={q.data?.grants ?? []}
        rowKey={(g) => g.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="Nobody has access" body="Give a person access above." />}
      />
    </Card>
  );
}
