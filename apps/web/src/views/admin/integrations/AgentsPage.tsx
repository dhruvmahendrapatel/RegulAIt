/**
 * Agents — the global agent catalog (create with provider/tier/model/pricing,
 * enable/disable), the ADR-0023 admin-authored BASE system prompt, per-user
 * agent grants, the per-user agent policy (default, cost ceiling, routing,
 * run budget), and the per-user entitlement view.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { AdminAgent, UserAgentPolicyView } from "../../../api/adminTypes";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import {
  KV,
  agentOpts,
  optionEls,
  useAction,
  useAgents,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const CLEAR = "__clear__";

export default function AgentsPage() {
  const agents = useAgents();
  const users = useUsers();
  const act = useAction();

  const aOpts = agentOpts(agents.data?.agents);
  const uOpts = userOpts(users.data?.users);

  return (
    <>
      <PageHeader
        title="Agents"
        sub="The global catalog is decoupled from entitlement: registering an agent grants nobody anything. Pricing feeds pillar 5's meters; the tier feeds pillar 6's routing."
      />
      <div className={v.stack}>
        <Card flush title="Catalog">
          <Table<AdminAgent>
            columns={[
              { key: "name", header: "Name", sort: (x) => x.name, render: (x) => x.name },
              { key: "provider", header: "Provider", sort: (x) => x.provider, render: (x) => x.provider },
              { key: "tier", header: "Tier", align: "right", sort: (x) => x.tier, render: (x) => x.tier },
              {
                key: "model",
                header: "Model",
                render: (x) => (x.model ? <span className={v.mono}>{x.model}</span> : "—"),
              },
              {
                key: "price",
                header: "$/MTok in → out",
                align: "right",
                render: (x) =>
                  x.costPerMTokIn == null && x.costPerMTokOut == null
                    ? "—"
                    : `${fmtUsd(x.costPerMTokIn)} → ${fmtUsd(x.costPerMTokOut)}`,
              },
              {
                key: "prompt",
                header: "System prompt",
                render: (x) => (x.systemPrompt ? `set (${x.systemPrompt.length} chars)` : "—"),
              },
              {
                key: "enabled",
                header: "Status",
                sort: (x) => (x.enabled ? 0 : 1),
                render: (x) => (x.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="danger">disabled</Badge>),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (x) => (
                  <Button
                    size="sm"
                    onClick={() =>
                      void act.run(
                        () => api.post(`/v1/agents/${x.id}/enabled`, { enabled: !x.enabled }),
                        x.enabled ? "Agent disabled" : "Agent enabled",
                      )
                    }
                  >
                    {x.enabled ? "disable" : "enable"}
                  </Button>
                ),
              },
            ]}
            rows={agents.data?.agents ?? []}
            rowKey={(x) => x.id}
            loading={agents.isLoading}
            empty={<EmptyState title="No agents registered" body="Register the first agent below." />}
          />
        </Card>

        <RegisterAgentCard />
        <SystemPromptCard agents={agents.data?.agents ?? []} />

        <Card title="Grant an agent">
          <GrantForm uOpts={uOpts} aOpts={aOpts} />
        </Card>

        <PolicyCard uOpts={uOpts} aOpts={aOpts} />
        <EntitlementCard uOpts={uOpts} agents={agents.data?.agents ?? []} />
      </div>
    </>
  );
}

function RegisterAgentCard() {
  const act = useAction();
  const [f, setF] = useState({
    name: "",
    provider: "anthropic",
    tier: "1",
    model: "",
    costPerMTokIn: "",
    costPerMTokOut: "",
    systemPrompt: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  return (
    <Card title="Register an agent">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post("/v1/agents", {
                  name: f.name,
                  provider: f.provider,
                  tier: Number(f.tier),
                  ...(f.model ? { model: f.model } : {}),
                  ...(f.costPerMTokIn ? { costPerMTokIn: Number(f.costPerMTokIn) } : {}),
                  ...(f.costPerMTokOut ? { costPerMTokOut: Number(f.costPerMTokOut) } : {}),
                  ...(f.systemPrompt ? { systemPrompt: f.systemPrompt } : {}),
                }),
              "Agent registered",
            )
            .then((ok) => ok && setF({ name: "", provider: "anthropic", tier: "1", model: "", costPerMTokIn: "", costPerMTokOut: "", systemPrompt: "" }));
        }}
      >
        <div className={a.formRow}>
          <Field label="Name">
            <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. claude-opus" />
          </Field>
          <Field label="Provider">
            <Select value={f.provider} onChange={(e) => set("provider", e.target.value)}>
              {["anthropic", "openai", "google", "xai", "mock"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tier (0 = cheapest)">
            <Input required type="number" min={0} value={f.tier} onChange={(e) => set("tier", e.target.value)} />
          </Field>
          <Field label="Model id (blank = not dispatchable)">
            <Input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. claude-opus-5" />
          </Field>
          <Field label="$/MTok in">
            <Input type="number" step="any" value={f.costPerMTokIn} onChange={(e) => set("costPerMTokIn", e.target.value)} />
          </Field>
          <Field label="$/MTok out">
            <Input type="number" step="any" value={f.costPerMTokOut} onChange={(e) => set("costPerMTokOut", e.target.value)} />
          </Field>
        </div>
        <Field label="System prompt — admin base (governance artifact, optional)">
          <Textarea
            rows={4}
            value={f.systemPrompt}
            onChange={(e) => set("systemPrompt", e.target.value)}
            placeholder="e.g. You are the billing-support agent. Never quote raw account numbers."
          />
        </Field>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Register agent
          </Button>
          {act.error && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

function SystemPromptCard(props: { agents: AdminAgent[] }) {
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  return (
    <Card title="System prompt — admin base (governance artifact)">
      <form
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(
            () => api.post(`/v1/agents/${agentId}/system-prompt`, { systemPrompt: prompt || null }),
            prompt ? "System prompt saved" : "System prompt cleared",
          );
        }}
      >
        <div className={a.formRow}>
          <Field label="Agent" grow>
            <Select
              required
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setPrompt(props.agents.find((x) => x.id === e.target.value)?.systemPrompt ?? "");
              }}
            >
              {optionEls(agentOpts(props.agents), "— select an agent —")}
            </Select>
          </Field>
          <Button type="submit" disabled={act.busy || !agentId}>
            Save prompt
          </Button>
        </div>
        <Field label="System prompt (empty = clear)">
          <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <p className={v.faint}>
          Applied as the system BASE on every governed dispatch of this agent — direct invokes,
          orchestration workers, and intercepted IDE calls alike. A caller-supplied system prompt is
          appended after it and can never replace it. Saving with an empty box clears the prompt.
        </p>
      </form>
    </Card>
  );
}

function GrantForm(props: { uOpts: Array<{ v: string; l: string }>; aOpts: Array<{ v: string; l: string }> }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [agentId, setAgentId] = useState("");
  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act.run(() => api.post("/v1/grants/agents", { userId, agentId }), "Agent granted");
      }}
    >
      <Field label="User">
        <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
          {optionEls(props.uOpts, "— select —")}
        </Select>
      </Field>
      <Field label="Agent">
        <Select required value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {optionEls(props.aOpts, "— select —")}
        </Select>
      </Field>
      <Button type="submit" size="sm" disabled={act.busy}>
        Grant
      </Button>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

function PolicyCard(props: { uOpts: Array<{ v: string; l: string }>; aOpts: Array<{ v: string; l: string }> }) {
  const act = useAction();
  const [f, setF] = useState({
    userId: "",
    defaultAgentId: "",
    ceilingAgentId: "",
    routingMode: "",
    runBudgetUsd: "",
    runBudgetBreachAction: "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const clearable = [{ v: CLEAR, l: "— clear —" }, ...props.aOpts];
  return (
    <Card title="Per-user agent policy — default, ceiling, routing, run budget">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = {};
          for (const k of ["defaultAgentId", "ceilingAgentId"] as const) {
            if (f[k]) body[k] = f[k] === CLEAR ? null : f[k];
          }
          if (f.routingMode) body.routingMode = f.routingMode;
          if (f.runBudgetBreachAction) body.runBudgetBreachAction = f.runBudgetBreachAction;
          if (f.runBudgetUsd !== "") body.runBudgetUsd = Number(f.runBudgetUsd);
          void act.run(() => api.post(`/v1/users/${f.userId}/agent-policy`, body), "Policy saved");
        }}
      >
        <Field label="User">
          <Select required value={f.userId} onChange={(e) => set("userId", e.target.value)}>
            {optionEls(props.uOpts, "— select —")}
          </Select>
        </Field>
        <Field label="Default agent">
          <Select value={f.defaultAgentId} onChange={(e) => set("defaultAgentId", e.target.value)}>
            {optionEls(clearable, "— leave unchanged —")}
          </Select>
        </Field>
        <Field label="Cost ceiling">
          <Select value={f.ceilingAgentId} onChange={(e) => set("ceilingAgentId", e.target.value)}>
            {optionEls(clearable, "— leave unchanged —")}
          </Select>
        </Field>
        <Field label="Routing">
          <Select value={f.routingMode} onChange={(e) => set("routingMode", e.target.value)}>
            <option value="">— leave unchanged —</option>
            <option value="automatic">automatic</option>
            <option value="passthrough">passthrough</option>
          </Select>
        </Field>
        <Field label="Run budget USD">
          <Input type="number" step="any" value={f.runBudgetUsd} onChange={(e) => set("runBudgetUsd", e.target.value)} placeholder="e.g. 0.25" />
        </Field>
        <Field label="On breach">
          <Select value={f.runBudgetBreachAction} onChange={(e) => set("runBudgetBreachAction", e.target.value)}>
            <option value="">— leave unchanged —</option>
            <option value="approve">approve</option>
            <option value="replan">replan</option>
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Save policy
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>
        The ceiling is a tier cap, not a suggestion — an agent above it is denied even with a grant. A run
        budget is what makes the run Budget card and the budget-overage approval exist at all; “leave
        unchanged” keeps the stored value.
      </p>
    </Card>
  );
}

function EntitlementCard(props: { uOpts: Array<{ v: string; l: string }>; agents: AdminAgent[] }) {
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [view, setView] = useState<UserAgentPolicyView | null>(null);
  const agentName = new Map(props.agents.map((x) => [x.id, x.name]));
  return (
    <Card title="Per-user entitlement">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            setView(await api.get<UserAgentPolicyView>(`/v1/users/${userId}/agents`));
          }, null);
        }}
      >
        <Field label="User" grow>
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            {optionEls(props.uOpts, "— select —")}
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
      {view && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          <Table
            columns={[
              { key: "name", header: "Agent", render: (x: UserAgentPolicyView["agents"][number]) => x.name },
              { key: "provider", header: "Provider", render: (x) => x.provider },
              { key: "tier", header: "Tier", align: "right", render: (x) => x.tier },
              {
                key: "revoked",
                header: "",
                render: (x) => (x.revoked ? <Badge tone="danger">revoked</Badge> : null),
              },
            ]}
            rows={view.agents}
            rowKey={(x) => x.agentId}
            empty={<EmptyState title="No entitled agents" />}
          />
          <KV
            rows={[
              ["default", agentName.get(view.defaultAgentId ?? "") ?? "none"],
              ["ceiling", agentName.get(view.ceilingAgentId ?? "") ?? "none"],
              ["routing", view.routingMode ?? "automatic"],
              [
                "run budget",
                view.runBudgetUsd == null
                  ? "no cap"
                  : `${fmtUsd(view.runBudgetUsd)} · ${view.runBudgetBreachAction ?? ""}`,
              ],
            ]}
          />
        </div>
      )}
    </Card>
  );
}
