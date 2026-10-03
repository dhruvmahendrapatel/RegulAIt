/**
 * Agents — stewardship (ADR-0168 item 6: steward, successor, lifecycle,
 * review), the global agent catalog (create with provider/tier/model/pricing,
 * enable/disable), the ADR-0023 admin-authored BASE system prompt, per-user
 * agent grants, the per-user agent policy (default, cost ceiling, routing,
 * run budget), and the per-user entitlement view.
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../../../api/client";
import type { AdminAgent, CustomModelProvider, UserAgentPolicyView } from "../../../api/adminTypes";
import { fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, Textarea } from "../../../ui/kit";
import {
  KV,
  RemoveButton,
  agentOpts,
  optionEls,
  useAction,
  useAgents,
  useCustomProviders,
  useUsers,
  userOpts,
} from "../adminKit";
import { StewardshipCard } from "./AgentStewardship";
import a from "../admin.module.css";
import v from "../../views.module.css";

const CLEAR = "__clear__";

export default function AgentsPage() {
  const agents = useAgents();
  const users = useUsers();
  const customProviders = useCustomProviders();
  const act = useAction();

  // `#agent-<id>` deep links (dependency graph, governance alerts): once the
  // list has loaded, scroll that agent's row into view and mark it, so the
  // link lands on the agent rather than at the top of the catalog
  const { hash } = useLocation();
  const linkedAgentId = hash.startsWith("#agent-") ? hash.slice("#agent-".length) : null;
  useEffect(() => {
    if (!linkedAgentId || !agents.data) return;
    document.getElementById(`agent-${linkedAgentId}`)?.scrollIntoView({ block: "center" });
  }, [linkedAgentId, agents.data]);

  const aOpts = agentOpts(agents.data?.agents);
  const uOpts = userOpts(users.data?.users);
  // ADR-0034: an agent bound to a custom endpoint shows WHICH endpoint, not
  // just the word "custom" — two agents can both be provider 'custom' and go
  // to two different hosts.
  const endpointName = new Map(
    (customProviders.data?.providers ?? []).map((p) => [p.id, p.name] as const),
  );

  return (
    <>
      <PageHeader
        title="Agents"
        sub="The agent catalog, decoupled from entitlement — registering one grants nobody anything."
        info={<p>The global catalog is decoupled from entitlement: registering an agent grants nobody anything. Pricing feeds pillar 5's meters; the tier feeds pillar 6's routing.</p>}
      />
      <div className={v.stack}>
        <StewardshipCard
          agents={agents.data?.agents}
          users={users.data?.users}
          loading={agents.isLoading}
          failed={!!agents.error && !agents.data}
        />
        <Card flush title="Catalog">
          <Table<AdminAgent>
            columns={[
              { key: "name", header: "Name", sort: (x) => x.name, render: (x) => (
                  <span id={`agent-${x.id}`}>
                    {x.name}
                    {x.id === linkedAgentId ? <> <Badge tone="info">linked</Badge></> : null}
                  </span>
                ) },
              {
                key: "provider",
                header: "Provider",
                sort: (x) => x.provider,
                render: (x) =>
                  x.provider === "custom" ? (
                    <>
                      custom ·{" "}
                      <span className={v.mono}>
                        {x.customProviderId ? (endpointName.get(x.customProviderId) ?? x.customProviderId) : "—"}
                      </span>
                    </>
                  ) : (
                    x.provider
                  ),
              },
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
                  x.costPerMTokIn == null && x.costPerMTokOut == null ? (
                    <span
                      className={v.faint}
                      title="No price is recorded. Spend is metered in real tokens with costUsd null, and the optimizer neither routes toward this agent nor claims savings against it."
                    >
                      unpriced
                    </span>
                  ) : (
                    `${fmtUsd(x.costPerMTokIn)} → ${fmtUsd(x.costPerMTokOut)}`
                  ),
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
            error={agents.error}
            onRetry={() => void agents.refetch()}
            empty={<EmptyState title="No agents registered" body="Register the first agent below." />}
          />
        </Card>

        <RegisterAgentCard />
        <ModelPricingCard agents={agents.data?.agents ?? []} />
        <SystemPromptCard agents={agents.data?.agents ?? []} />
        <FallbackChainCard agents={agents.data?.agents ?? []} />

        <Card title="Grant an agent">
          <GrantForm uOpts={uOpts} aOpts={aOpts} />
        </Card>

        <PolicyCard uOpts={uOpts} aOpts={aOpts} />
        <EntitlementCard uOpts={uOpts} agents={agents.data?.agents ?? []} />
      </div>
    </>
  );
}

const EMPTY_AGENT = {
  name: "",
  provider: "anthropic",
  customProviderId: "",
  tier: "1",
  model: "",
  costPerMTokIn: "",
  costPerMTokOut: "",
  systemPrompt: "",
};

function RegisterAgentCard() {
  const act = useAction();
  const customProviders = useCustomProviders();
  const [f, setF] = useState(EMPTY_AGENT);
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));

  // ADR-0034: ONLY ENABLED ENDPOINTS ARE SELECTABLE. A disabled one is either
  // untested or deliberately switched off; binding an agent to it would build
  // a 409 into the catalog.
  const selectable: CustomModelProvider[] = (customProviders.data?.providers ?? []).filter((p) => p.enabled);
  const isCustom = f.provider === "custom";

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
                  // The DB models `provider = 'custom'` and `customProviderId`
                  // as a discriminated union (a CHECK constraint), so the two
                  // are always sent together or not at all.
                  ...(isCustom ? { customProviderId: f.customProviderId } : {}),
                  ...(f.costPerMTokIn ? { costPerMTokIn: Number(f.costPerMTokIn) } : {}),
                  ...(f.costPerMTokOut ? { costPerMTokOut: Number(f.costPerMTokOut) } : {}),
                  ...(f.systemPrompt ? { systemPrompt: f.systemPrompt } : {}),
                }),
              "Agent registered",
            )
            .then((ok) => ok && setF(EMPTY_AGENT));
        }}
      >
        <div className={a.formRow}>
          <Field label="Name">
            <Input required value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. claude-opus" />
          </Field>
          <Field label="Provider">
            <Select
              value={f.provider}
              onChange={(e) => {
                set("provider", e.target.value);
                // never leave a stale endpoint id behind on a non-custom agent
                if (e.target.value !== "custom") set("customProviderId", "");
              }}
              data-testid="agent-provider"
            >
              {["anthropic", "openai", "google", "xai", "mock", "custom"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          {isCustom && (
            <Field label="Custom endpoint (enabled endpoints only)" grow>
              <Select
                required
                value={f.customProviderId}
                onChange={(e) => set("customProviderId", e.target.value)}
                data-testid="agent-custom-endpoint"
              >
                {optionEls(
                  selectable.map((p) => ({ v: p.id, l: `${p.name} · ${p.wireProtocol} · ${p.baseUrl}` })),
                  "— select an endpoint —",
                )}
              </Select>
            </Field>
          )}
          <Field label="Tier (0 = cheapest)">
            <Input required type="number" min={0} value={f.tier} onChange={(e) => set("tier", e.target.value)} />
          </Field>
          <Field label="Model id (blank = not dispatchable)">
            <Input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="e.g. claude-opus-5" />
          </Field>
          <Field label={isCustom ? "$/MTok in — blank = unpriced" : "$/MTok in"}>
            <Input type="number" step="any" value={f.costPerMTokIn} onChange={(e) => set("costPerMTokIn", e.target.value)} />
          </Field>
          <Field label={isCustom ? "$/MTok out — blank = unpriced" : "$/MTok out"}>
            <Input type="number" step="any" value={f.costPerMTokOut} onChange={(e) => set("costPerMTokOut", e.target.value)} />
          </Field>
        </div>
        {isCustom && (
          <>
            {selectable.length === 0 && (
              <p className={v.errLine} role="alert" data-testid="no-enabled-endpoints">
                No custom endpoint is enabled yet. Register one under{" "}
                <Link to="/admin/custom-providers">Integrations → Custom LLM providers</Link>, pass its
                connection test, then enable it — only enabled endpoints can be bound to an agent.
              </p>
            )}
            <p className={v.faint}>
              A self-hosted endpoint has no list price, and <strong>leaving both cost fields blank is the
              right answer</strong> — null means unpriced, not zero and not unknown-so-guess. Spend is still
              metered in real tokens, with <span className={v.mono}>costUsd: null</span>; pillar 6's
              optimizer passes through rather than comparing, never routes toward an unpriced model, and
              never claims savings against one. Please do not invent a number to fill the box.
            </p>
          </>
        )}
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

/**
 * B1.5 — edit an agent's model id + list prices, the affordance the live
 * verification run found missing (a retired provider model id was only
 * fixable via psql). `PATCH /v1/agents/:agentId` rides the versioned
 * agent_config edit path on the gateway: a versioned agent's save mints and
 * activates a config version, an unversioned agent keeps the plain row write.
 */
function ModelPricingCard(props: { agents: AdminAgent[] }) {
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [model, setModel] = useState("");
  const [inC, setInC] = useState("");
  const [outC, setOutC] = useState("");
  return (
    <Card title="Model & pricing — dispatch-execution config">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(
            () =>
              api.patch(`/v1/agents/${agentId}`, {
                model: model || null,
                costPerMTokIn: inC === "" ? null : Number(inC),
                costPerMTokOut: outC === "" ? null : Number(outC),
              }),
            "Model & pricing saved",
          );
        }}
      >
        <Field label="Agent" grow>
          <Select
            required
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              const picked = props.agents.find((x) => x.id === e.target.value);
              setModel(picked?.model ?? "");
              setInC(picked?.costPerMTokIn == null ? "" : String(picked.costPerMTokIn));
              setOutC(picked?.costPerMTokOut == null ? "" : String(picked.costPerMTokOut));
            }}
            data-testid="model-pricing-agent"
          >
            {optionEls(agentOpts(props.agents), "— select an agent —")}
          </Select>
        </Field>
        <Field label="Model id (empty = not dispatchable)">
          <Input value={model} onChange={(e) => setModel(e.target.value)} data-testid="model-pricing-model" />
        </Field>
        <Field label="$/MTok in (empty = unpriced)">
          <Input type="number" step="any" value={inC} onChange={(e) => setInC(e.target.value)} />
        </Field>
        <Field label="$/MTok out (empty = unpriced)">
          <Input type="number" step="any" value={outC} onChange={(e) => setOutC(e.target.value)} />
        </Field>
        <Button type="submit" disabled={act.busy || !agentId}>
          Save model & pricing
        </Button>
        {act.error && (
          <span className={v.errLine} role="alert">
            {act.error}
          </span>
        )}
      </form>
      <p className={v.faint}>
        Provider model ids age out (the seeded Google id already did once) — this is where a stale id is
        refreshed. The save is versioned where versions exist: an agent with agent_config versions gets a
        new version minted and activated (one click rolls back under Config versions); an unversioned
        agent is updated in place. Provider, tier, enablement and lifecycle are deliberately not editable
        here — each has its own governed control.
      </p>
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

/** One rung of a chain, as the gateway reports it. */
interface FallbackRow {
  position: number;
  agentId: string;
  name: string;
  provider: string;
  model: string | null;
  enabled: boolean;
}

/**
 * ADR-0066 fallback chains — shipped API-only until now, which meant the
 * ordering that decides what runs when a provider is down lived nowhere an
 * admin could read it.
 *
 * The chain is edited as a WHOLE (the endpoint is a PUT, and order is the
 * semantics), so this card loads the current chain on agent select and saves
 * the full ordered list. The gateway owns the refusals — self-fallback,
 * duplicates, unknown targets — and this form deliberately does not
 * re-implement them: a rejected save surfaces the gateway's own reason
 * verbatim, so the UI can never disagree with the rule that actually binds.
 */
function FallbackChainCard(props: { agents: AdminAgent[] }) {
  const act = useAction();
  const [agentId, setAgentId] = useState("");
  const [chain, setChain] = useState<FallbackRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [addId, setAddId] = useState("");

  const load = async (id: string) => {
    setChain([]);
    if (!id) return;
    setLoading(true);
    try {
      const r = await api.get<{ fallbacks: FallbackRow[] }>(`/v1/agents/${id}/fallbacks`);
      setChain(r.fallbacks ?? []);
    } finally {
      setLoading(false);
    }
  };

  const save = (next: FallbackRow[], msg: string) =>
    void act.run(async () => {
      await api.put(`/v1/agents/${agentId}/fallbacks`, {
        fallbackAgentIds: next.map((r) => r.agentId),
      });
      await load(agentId);
    }, msg);

  const move = (i: number, delta: number) => {
    const next = [...chain];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next, "Fallback order saved");
  };

  // candidates exclude the primary itself and anything already in the chain —
  // the two conditions the gateway refuses with self_fallback / duplicate_fallback
  const inChain = new Set(chain.map((r) => r.agentId));
  const candidates = props.agents.filter((x) => x.id !== agentId && !inChain.has(x.id));

  return (
    <Card title="Fallback chain (ADR-0066) — what runs when the primary cannot">
      <div className={a.formRow}>
        <Field label="Primary agent" grow>
          <Select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setAddId("");
              void load(e.target.value);
            }}
          >
            {optionEls(agentOpts(props.agents), "— select an agent —")}
          </Select>
        </Field>
      </div>

      {agentId && (
        <>
          {loading ? (
            <span className={v.dim}>Loading chain…</span>
          ) : chain.length === 0 ? (
            <p className={v.dim}>
              No fallbacks. A dispatch that cannot reach this agent fails honestly rather than
              silently routing somewhere the admin never named.
            </p>
          ) : (
            <ol className={v.stack} style={{ margin: 0, paddingLeft: "1.25rem" }}>
              {chain.map((r, i) => (
                <li key={r.agentId}>
                  <span className={v.rowTight}>
                    <strong>{r.name}</strong>
                    <span className={v.dim}>
                      {r.provider}
                      {r.model ? ` · ${r.model}` : ""}
                    </span>
                    {!r.enabled && (
                      <Badge tone="warn" title="This agent is disabled — the chain will skip past it">
                        disabled
                      </Badge>
                    )}
                    <span className={v.grow} />
                    <Button size="sm" disabled={act.busy || i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      disabled={act.busy || i === chain.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={act.busy}
                      onClick={() => save(chain.filter((x) => x.agentId !== r.agentId), "Fallback removed")}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}

          <div className={a.formRow}>
            <Field label="Add a fallback (tried in order, after the ones above)" grow>
              <Select value={addId} onChange={(e) => setAddId(e.target.value)}>
                {optionEls(agentOpts(candidates), "— select an agent —")}
              </Select>
            </Field>
            <Button
              disabled={act.busy || !addId}
              onClick={() => {
                const picked = props.agents.find((x) => x.id === addId);
                if (!picked) return;
                save(
                  [
                    ...chain,
                    {
                      position: chain.length,
                      agentId: picked.id,
                      name: picked.name,
                      provider: picked.provider,
                      model: picked.model ?? null,
                      enabled: picked.enabled ?? true,
                    },
                  ],
                  "Fallback added",
                );
                setAddId("");
              }}
            >
              Add
            </Button>
          </div>
        </>
      )}

      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <p className={v.faint}>
        Order is the policy: on a provider failure the gateway walks this list top-down and
        dispatches the first agent it can reach. Every rung is still governed — a fallback the
        CALLER is not entitled to is refused exactly like a direct invoke of it, so a chain can
        never widen what someone may run. Cost and audit are attributed to the agent that actually
        served. An agent cannot be its own fallback, and each target may appear once.
      </p>
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
                key: "source",
                header: "Via",
                render: (x) =>
                  x.source === "role" ? (
                    <Badge tone="info" title={(x.roles ?? []).join(", ")}>
                      role{(x.roles ?? []).length ? `: ${(x.roles ?? []).join(", ")}` : ""}
                    </Badge>
                  ) : (
                    <Badge tone="ok">direct</Badge>
                  ),
              },
              {
                key: "revoked",
                header: "",
                render: (x) => (x.revoked ? <Badge tone="danger">revoked</Badge> : null),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (x) => (
                  <RemoveButton
                    what={`${x.name} from this user`}
                    // A role-granted agent has no direct grant to delete. Saying
                    // that on the row is the point: an absent button would read
                    // as a missing feature, and the admin would not learn that
                    // the lever they want is the role — or a per-user
                    // revocation, which subtracts without touching the role.
                    disabledReason={
                      x.source === "role"
                        ? `granted by role ${(x.roles ?? []).join(", ")} — remove it there, or add a per-user revocation on the Users page`
                        : undefined
                    }
                    consequence={
                      <p>
                        The direct grant is deleted, so the next call this user makes on{" "}
                        <strong>{x.name}</strong> is refused by default-deny. Nothing already audited
                        changes — the ledger keeps every call made while the grant existed, and the
                        removal is itself audited.
                      </p>
                    }
                    onRemove={() => api.del(`/v1/grants/agents/${x.grantId}`)}
                    onDone={() => {
                      void act.run(async () => {
                        setView(await api.get<UserAgentPolicyView>(`/v1/users/${userId}/agents`));
                      }, null);
                    }}
                  />
                ),
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
