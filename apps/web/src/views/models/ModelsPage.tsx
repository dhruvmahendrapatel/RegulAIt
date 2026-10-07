/**
 * ADR-0172 — the model portal (/models). Left: every governed model binding
 * the person may use, as searchable, provider-filterable tiles with logo,
 * model id, tier and readiness. Right: "Try it" — copyable code samples for
 * the gateway's OpenAI- and Anthropic-compatible endpoints (key placeholder
 * only), and a Run button that goes through the governed invoke path, so a
 * refusal comes back by name exactly as it would for any other call.
 *
 * Data (existing APIs only): admins read the registry (GET /v1/agents);
 * everyone else reads their own grants (GET /v1/users/:me/agents). Readiness
 * adds GET /v1/model-providers/status and the person's own stored keys.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, codeSentence } from "../../api/client";
import type { AdminAgent } from "../../api/adminTypes";
import type { InvokeResult, MyAgentsResponse, Project, ProviderStatusResponse } from "../../api/types";
import { fmtUsd } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, SkeletonBlock, Tabs, Textarea } from "../../ui/kit";
import { ModelTileBody } from "../../ui/ModelPicker";
import { Logo } from "../../ui/logos/Logo";
import { useToast } from "../../ui/toast";
import { LITERACY_REFUSAL_CODE, REFUSAL_GUIDANCE } from "../../api/refusals";
import { RefusalNotice } from "../../ui/RefusalNotice";
import {
  bindingsFromGranted,
  bindingsFromRegistry,
  filterBindings,
  classifyRunFailure,
  providerChips,
  type BindingRow,
  type ModelBinding,
} from "./modelBindings";
import { buildSnippets, KEY_ENV, SNIPPET_TABS, type SnippetTab } from "./snippets";
import { allowedFeatures, modelPolicyVerdict, useModelPolicy, type ModelPolicyView } from "./modelPolicy";
import s from "./models.module.css";

const DEFAULT_PROMPT = "Explain what an AI gateway does in one sentence.";

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; result: InvokeResult & { cached?: boolean }; latencyMs: number }
  | { kind: "refused"; ruleId: string; reason: string | null; latencyMs: number }
  | { kind: "error"; code: string; message: string; status: number | null; latencyMs: number };

export default function ModelsPage() {
  const { auth } = useSession();
  const userId = auth?.userId ?? null;
  const isAdmin = Boolean(auth?.isAdmin);

  const registryQ = useQuery({
    queryKey: ["admin", "agents"],
    enabled: isAdmin,
    queryFn: () => api.get<{ agents: Array<AdminAgent & { haltedAt?: string | null; haltedReason?: string | null }> }>("/v1/agents"),
  });
  const grantsQ = useQuery({
    queryKey: ["my-agents", userId],
    enabled: !isAdmin && Boolean(userId),
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
  });
  const statusQ = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.get<ProviderStatusResponse>("/v1/model-providers/status"),
  });
  const credsQ = useQuery({
    queryKey: ["my-credentials", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<{ credentials: Array<{ provider: string }> }>(`/v1/users/${userId}/model-credentials`),
  });

  // ADR-0173 §3 — the org's model allow-list: Run is the Chat feature
  const policyQ = useModelPolicy();
  const policy = policyQ.data ?? null;

  const listQ = isAdmin ? registryQ : grantsQ;
  const bindings = useMemo<ModelBinding[]>(() => {
    const ctx = {
      providerStatus: statusQ.data?.providers ?? {},
      myProviders: (credsQ.data?.credentials ?? []).map((c) => c.provider),
    };
    if (isAdmin) return bindingsFromRegistry((registryQ.data?.agents ?? []) as BindingRow[], ctx);
    return bindingsFromGranted(grantsQ.data?.agents ?? [], ctx);
  }, [isAdmin, registryQ.data, grantsQ.data, statusQ.data, credsQ.data]);

  const [params, setParams] = useSearchParams();
  const selectedId = params.get("model");
  const selected = bindings.find((b) => b.id === selectedId) ?? null;
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("model", id);
    setParams(next, { replace: true });
  };

  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const chips = useMemo(() => providerChips(bindings), [bindings]);
  const shown = useMemo(() => filterBindings(bindings, query, provider), [bindings, query, provider]);

  return (
    <>
      <PageHeader
        title="Models"
        sub="Every model you may use, what it takes to call it, and a governed way to try it."
        info={
          <p>
            Each tile is a governed model binding from the agent registry. Readiness says whether a call would
            run right now. Trying a model goes through the same governance, budgets and audit as any other
            call — a refusal is shown by name.
          </p>
        }
      />
      <div className={s.layout}>
        <Card className={s.pickCard}>
          <h2 className={s.sectionTitle}>Choose a model</h2>
          <Input
            type="search"
            aria-label="Search models and providers"
            placeholder="Search models and providers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {chips.length > 1 && (
            <div className={s.chips} role="group" aria-label="Filter by provider">
              <button type="button" className={s.chip} aria-pressed={provider === null} onClick={() => setProvider(null)}>
                All <span className={s.chipCount}>{bindings.length}</span>
              </button>
              {chips.map((c) => (
                <button
                  key={c.provider}
                  type="button"
                  className={s.chip}
                  aria-pressed={provider === c.provider}
                  onClick={() => setProvider(provider === c.provider ? null : c.provider)}
                >
                  <span aria-hidden="true" className={s.chipLogo}>
                    <Logo name={c.logoKey} label={c.label} size={16} />
                  </span>
                  {c.label} <span className={s.chipCount}>{c.count}</span>
                </button>
              ))}
            </div>
          )}
          {listQ.isLoading ? (
            <SkeletonBlock lines={6} />
          ) : listQ.error && !listQ.data ? (
            <ErrorState
              title="Couldn't load your models"
              message={listQ.error instanceof Error ? listQ.error.message : String(listQ.error)}
              access={listQ.error instanceof ApiError && listQ.error.status === 403}
              onRetry={() => void listQ.refetch()}
            />
          ) : bindings.length === 0 ? (
            <EmptyState
              title={userId || isAdmin ? "No models available to you yet" : "This session has no user identity"}
              body={
                isAdmin
                  ? "Register a model binding in the agent registry first."
                  : userId
                    ? "An admin grants models from Identity & access. Once one is granted it appears here."
                    : "Sign in as a person to see the models granted to you."
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState title="No models match" body="Try another search, or clear the provider filter." />
          ) : (
            <ul className={s.grid} aria-label="Models">
              {shown.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={s.tile}
                    aria-pressed={b.id === selectedId}
                    data-readiness={b.readiness}
                    onClick={() => select(b.id)}
                  >
                    <ModelTileBody agent={b} />
                    {!modelPolicyVerdict(policy, "chat", b).allowed && (
                      <span className={s.tileNote}>Not allowed in Chat by your organisation&apos;s model policy</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <TryIt binding={selected} bindings={bindings} isAdmin={isAdmin} policy={policy} />
      </div>
    </>
  );
}

function TryIt(props: { binding: ModelBinding | null; bindings: ModelBinding[]; isAdmin: boolean; policy: ModelPolicyView | null }) {
  const b = props.binding;
  const { toast } = useToast();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [tab, setTab] = useState<SnippetTab>("curl");
  const [copied, setCopied] = useState<SnippetTab | null>(null);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [runFor, setRunFor] = useState<string | null>(null);
  // ADR-0181: a governed dispatch must name a project unless an admin has
  // relaxed that, so Run bills to one of the person's projects (the first, by
  // default) and says so; "no project" stays available for a relaxed deployment
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const projects = projectsQ.data?.projects ?? [];
  const [billTo, setBillTo] = useState<string | null>(null);
  const projectId = billTo ?? projects[0]?.id ?? "";

  const snippets = useMemo(
    () => (b ? buildSnippets({ base: window.location.origin, agentId: b.id, model: b.model, name: b.name, prompt }) : null),
    [b, prompt],
  );

  if (!b || !snippets) {
    return (
      <Card className={s.tryCard}>
        <h2 className={s.sectionTitle}>Try it</h2>
        <EmptyState
          title="Select a model"
          body="Pick a model on the left to see how to call it from code, and to send it a governed request."
        />
      </Card>
    );
  }

  const shownRun: RunState = runFor === b.id ? run : { kind: "idle" };
  const chatVerdict = modelPolicyVerdict(props.policy, "chat", b);
  const blocked =
    b.readiness === "routing_only"
      ? "This binding has no model id, so it cannot be called directly."
      : !chatVerdict.allowed
        ? `Not allowed here: ${chatVerdict.reason}`
        : !prompt.trim()
          ? "Write a request first."
          : null;
  const usableIn = props.policy?.rules?.length ? allowedFeatures(props.policy, b) : null;

  const send = async () => {
    setRunFor(b.id);
    setRun({ kind: "running" });
    const t0 = performance.now();
    try {
      const result = await api.post<InvokeResult & { cached?: boolean }>(`/v1/agents/${b.id}/invoke`, {
        mode: "execute",
        input: prompt.trim(),
        dispatch: true,
        ...(projectId ? { projectId } : {}),
      });
      setRun({ kind: "ok", result, latencyMs: performance.now() - t0 });
    } catch (e) {
      const latencyMs = performance.now() - t0;
      const failure =
        e instanceof ApiError
          ? classifyRunFailure(e.status, e.payload as Record<string, unknown>, e.message)
          : classifyRunFailure(null, null, codeSentence("network"));
      setRun({ ...failure, latencyMs });
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippets[tab]);
      setCopied(tab);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      toast("Clipboard unavailable — select the text manually", "error");
    }
  };

  const tabLabel = SNIPPET_TABS.find((t) => t.id === tab)!.label;

  return (
    <Card className={s.tryCard}>
      <h2 className={s.sectionTitle}>Try it</h2>
      <div className={s.selected} aria-label="Selected model" role="group">
        <span aria-hidden="true">
          <Logo name={b.logoKey} label={b.providerLabel} size={36} />
        </span>
        <div className={s.selectedText}>
          <div className={s.selectedName}>{b.name}</div>
          <div className={s.selectedMeta}>
            <span className={s.mono}>{b.model ?? "no model id"}</span> · {b.providerLabel} · tier {b.tier}
          </div>
        </div>
        <Badge tone={b.readinessTone}>{b.readinessLabel}</Badge>
      </div>
      <p className={s.readiness} data-testid="readiness-detail">
        {b.readinessDetail}
        {b.readiness === "needs_credentials" && (
          <>
            {" "}
            {props.isAdmin ? (
              <Link className={s.inlineLink} to="/admin/model-credentials">Add the platform credential</Link>
            ) : (
              <Link className={s.inlineLink} to="/account?section=keys">Add your own key</Link>
            )}
          </>
        )}
      </p>
      {usableIn && (
        <ul className={s.allowedIn} aria-label="Where your organisation's model policy allows this model" data-testid="allowed-in">
          {usableIn.map((f) => (
            <li key={f.feature}>
              <Badge tone={f.allowed ? "ok" : "warn"}>
                {f.label}: {f.allowed ? "allowed" : "not allowed"}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <div className={s.fieldBlock}>
        <label className={s.label} htmlFor="models-request">
          Request
        </label>
        <Textarea id="models-request" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>

      {projects.length > 0 && (
        <div className={s.fieldBlock}>
          <label className={s.label} htmlFor="models-bill-to">
            Bill to
          </label>
          <Select id="models-bill-to" value={projectId} onChange={(e) => setBillTo(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="">no project</option>
          </Select>
        </div>
      )}

      <div className={s.codeHead}>
        <Tabs tabs={SNIPPET_TABS} active={tab} onChange={(id) => setTab(id as SnippetTab)} />
        <span className={s.grow} />
        <Button size="sm" onClick={() => void copy()} aria-label={`Copy ${tabLabel} sample`}>
          {copied === tab ? "Copied" : "Copy"}
        </Button>
      </div>
      {/* the panel is the scroll container, so it takes focus (keyboard scrolling) */}
      <div role="tabpanel" tabIndex={0} aria-label={`${tabLabel} sample`} className={s.codePanel}>
        <pre className={s.code} data-testid="model-snippet">
          {snippets[tab]}
        </pre>
      </div>
      <p className={s.hint}>
        Calls from code use your own RegulAIt API key, read from <span className={s.mono}>{KEY_ENV}</span> — no key
        is ever shown here. The <span className={s.mono}>x-regulait-agent-id</span> header pins this exact model
        binding. These endpoints answer once an admin has enabled them under Client access, and they require an{" "}
        <span className={s.mono}>x-regulait-project-id</span> header naming one of your projects unless an admin has
        relaxed that.
      </p>

      <div className={s.runRow}>
        <Button
          variant="primary"
          onClick={() => void send()}
          disabled={Boolean(blocked) || shownRun.kind === "running"}
          aria-describedby={blocked ? "models-run-blocked" : undefined}
        >
          {shownRun.kind === "running" ? "Running…" : "Run"}
        </Button>
        {blocked && (
          <span id="models-run-blocked" className={s.hintInline}>
            {blocked}
          </span>
        )}
        {!blocked && <span className={s.hintInline}>Runs through governance as you, and is metered and audited.</span>}
      </div>

      <div aria-live="polite" className={s.resultWrap}>
        <RunResult run={shownRun} bindings={props.bindings} requestedId={b.id} />
      </div>
    </Card>
  );
}

const fmtLatency = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

function RunResult(props: { run: RunState; bindings: ModelBinding[]; requestedId: string }) {
  const { run } = props;
  if (run.kind === "idle") return null;
  if (run.kind === "running") {
    return (
      <div className={s.result} data-testid="run-result">
        <SkeletonBlock lines={2} />
      </div>
    );
  }
  if (run.kind === "refused") {
    return (
      <div className={`${s.result} ${s.resultRefused}`} data-testid="run-result" role="alert">
        <div className={s.resultHead}>
          <Badge tone="danger">Refused by governance</Badge>
          <span className={s.mono}>{run.ruleId}</span>
          <span className={s.grow} />
          <span className={s.stat}>{fmtLatency(run.latencyMs)}</span>
        </div>
        {run.reason && <p className={s.resultText}>{run.reason}</p>}
        {run.ruleId === LITERACY_REFUSAL_CODE && <RefusalNotice guidance={REFUSAL_GUIDANCE.literacy} />}
      </div>
    );
  }
  if (run.kind === "error") {
    // not a governance decision: a neutral state with the code, never "Refused"
    return (
      <div className={s.result} data-testid="run-result" role="status">
        <div className={s.resultHead}>
          <Badge tone="neutral">Couldn&apos;t run</Badge>
          <span className={s.mono}>{run.code}</span>
          {run.status != null && <span className={s.stat}>HTTP {run.status}</span>}
          <span className={s.grow} />
          <span className={s.stat}>{fmtLatency(run.latencyMs)}</span>
        </div>
        <p className={s.resultText}>{run.message}</p>
      </div>
    );
  }
  const { result } = run;
  const d = result.dispatch;
  const decision = result.decision;
  const servedId = result.routing?.selectedAgentId ?? d?.servedAgentId;
  const served = servedId && servedId !== props.requestedId ? props.bindings.find((x) => x.id === servedId) : null;
  return (
    <div className={s.result} data-testid="run-result">
      <div className={s.resultHead}>
        <Badge tone="ok">Allowed</Badge>
        {decision?.ruleId && <span className={s.mono}>{decision.ruleId}</span>}
        <span className={s.grow} />
        <span className={s.stat} title="Round trip, measured in this browser">
          {fmtLatency(run.latencyMs)}
        </span>
        <span className={s.stat}>{fmtUsd(d?.costUsd ?? null)}</span>
        {d?.model && <span className={`${s.stat} ${s.mono}`}>{d.model}</span>}
      </div>
      <p className={s.resultText}>
        {d?.refusal ? "The model declined this request." : (d?.outputText ?? "No reply text was returned.")}
      </p>
      <dl className={s.facts}>
        {decision?.reason && (
          <>
            <dt>Governance</dt>
            <dd>{decision.reason}</dd>
          </>
        )}
        {served && (
          <>
            <dt>Served by</dt>
            <dd>{served.name} (routing chose a different model)</dd>
          </>
        )}
        {d?.usage && (
          <>
            <dt>Tokens</dt>
            <dd>
              {d.usage.inputTokens} in · {d.usage.outputTokens} out
            </dd>
          </>
        )}
        {d?.credentialSource && (
          <>
            <dt>Paid by</dt>
            <dd>{d.credentialSource === "user" ? "your own key" : "the platform credential"}</dd>
          </>
        )}
        {result.cached && (
          <>
            <dt>Cache</dt>
            <dd>Answered from the response cache — no provider call, no spend.</dd>
          </>
        )}
      </dl>
    </div>
  );
}
