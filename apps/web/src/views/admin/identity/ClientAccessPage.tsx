/**
 * Client Access (ADR-0020/0024) — the deployment's interception posture with
 * HONEST rung labels (enforced / policy / honor system), staged-rollout scope
 * rules with a live effective-value preview (the exact resolver the request
 * gate uses), the per-client copy-paste config generator built from this
 * deployment's own origin, and the honest coverage matrix.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type {
  EffectiveInterception,
  InterceptionSettings,
  InterceptionSettingsResponse,
  ScopeRule,
} from "../../../api/adminTypes";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
} from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import {
  KV,
  QueryGate,
  optionEls,
  projectOpts,
  roleOpts,
  serverOpts,
  useAction,
  useProjects,
  useRoles,
  useServers,
  useUsers,
  userOpts,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const LADDER: Record<
  string,
  { bypass: string; note: string }
> = {
  observe: {
    bypass: "n/a — no enforcement",
    note: "Telemetry only. Nothing stops a developer calling the vendor directly; you will see what they choose to emit.",
  },
  voluntary: {
    bypass: "trivially bypassable",
    note: "HONOR SYSTEM. A developer points their IDE at regulAIt, and nothing prevents them from pointing it straight back at the vendor. Key custody or network egress is what makes interception non-bypassable — not this setting.",
  },
  managed: {
    bypass: "developer can undo locally",
    note: "Pushed by IDE policy / managed settings / MDM. Better than voluntary, still reversible on the developer's own machine.",
  },
  key_custody: {
    bypass: "no — no key, no call (when ENFORCED below)",
    note: "The org never issues raw vendor keys, only regulAIt keys. With 'enforce key custody' ON this deployment makes it real: per-user BYO credentials are refused (409) and dispatch uses org/platform credentials only. Declared without the toggle, it is a statement — not a mechanism.",
  },
  network: {
    bypass: "no",
    note: "regulAIt is the only sanctioned egress to the vendor APIs. Enforced by YOUR network (egress allowlist), never by this product — the recipe is in docs/product/IDE_INTEGRATION.md (Network rung).",
  },
};

const COVERAGE = [
  { client: "Claude Code", model: "ANTHROPIC_BASE_URL → /v1/messages", tools: "MCP proxy (claude mcp add)", headers: "yes" },
  { client: "Cursor", model: "OpenAI-compatible base URL → /v1/chat/completions", tools: "MCP proxy (.cursor/mcp.json)", headers: "MCP only" },
  { client: "Cline", model: "OpenAI- or Anthropic-compatible base URL", tools: "MCP proxy", headers: "MCP only" },
  { client: "Roo Code", model: "OpenAI- or Anthropic-compatible base URL", tools: "MCP proxy", headers: "MCP only" },
  { client: "Continue", model: "apiBase override", tools: "MCP proxy", headers: "MCP only" },
  { client: "Zed", model: "language_models api_url override", tools: "MCP (context servers)", headers: "MCP only" },
  { client: "VS Code (built-in MCP)", model: "not applicable", tools: "MCP proxy", headers: "yes" },
  { client: "GitHub Copilot", model: "NOT SUPPORTED — largely locked down; enterprise proxy path or nothing", tools: "not via this proxy", headers: "n/a" },
  { client: "Eclipse", model: "no first-party agent; third-party plugins vary and are often not configurable", tools: "varies by plugin", headers: "n/a" },
];

export default function ClientAccessPage() {
  const q = useQuery({
    queryKey: ["admin", "interception-settings"],
    queryFn: () => api.get<InterceptionSettingsResponse>("/v1/interception/settings"),
  });
  return (
    <>
      <PageHeader
        title="Client access"
        sub="regulAIt governs calls that ARRIVE at it. These settings decide which arrival surfaces exist, how a model string resolves onto a governed agent, and which rung of the interception ladder this organisation is on — labeled honestly. Both provider-shaped surfaces are OFF until you turn them on; while off they answer 404 and are indistinguishable from not existing."
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && <Loaded data={q.data} />}
      </QueryGate>
    </>
  );
}

function Loaded(props: { data: InterceptionSettingsResponse }) {
  const cur = props.data.settings;
  const posture = props.data.posture ?? { status: "honor_system" as const };
  const rung = LADDER[cur.enforcementPosture] ?? LADDER.voluntary!;
  const postureWarn = posture.status === "honor_system" || posture.status === "declared_not_enforced";

  return (
    <div className={v.stack}>
      <Card title="Enforcement posture — declared vs enforced">
        <KV
          rows={[
            [
              "Rung",
              <span className={v.rowTight} key="r">
                <Badge tone={postureWarn ? "warn" : "ok"}>{cur.enforcementPosture}</Badge>
                <Badge tone={posture.status === "enforced" ? "ok" : postureWarn ? "warn" : "info"}>
                  {posture.label ?? posture.status.replaceAll("_", " ")}
                </Badge>
              </span>,
            ],
            ["Bypassable?", rung.bypass],
            ["What that means", posture.detail ?? rung.note],
          ]}
        />
        {posture.status === "honor_system" && (
          <p className={v.dim}>
            This rung is an <strong>honor system</strong>. Pointing an IDE here is a request, not an
            enforcement. If an enterprise buyer asks what stops a developer from simply not doing it, the
            honest answer at this rung is: nothing. Key custody is the cheapest non-bypassable answer — and
            this deployment CAN enforce it: turn on “enforce key custody” below.
          </p>
        )}
        {posture.status === "declared_not_enforced" && (
          <p className={v.dim}>
            <strong>Warning:</strong> key custody is DECLARED but the enforcement toggle is OFF — per-user
            BYO credentials still work. Turn on “enforce key custody” below to make the declaration true.
          </p>
        )}
      </Card>

      <PostureForm cur={cur} />
      <ScopeRulesCard />
      <EffectivePreviewCard />
      <ConfigGeneratorCard />

      <Card title="Honest coverage">
        <Table
          columns={[
            { key: "client", header: "Client", render: (r: (typeof COVERAGE)[number]) => r.client },
            { key: "model", header: "Model calls", render: (r) => r.model },
            { key: "tools", header: "Tool calls", render: (r) => r.tools },
            { key: "headers", header: "Custom headers", render: (r) => r.headers },
          ]}
          rows={COVERAGE}
          rowKey={(r) => r.client}
        />
        <p className={v.faint}>
          “Works with every IDE” would be a false claim. What is true: any client that accepts a custom
          Anthropic- or OpenAI-compatible base URL can have its model calls governed here, and any
          MCP-capable client can have its tool calls governed here. Those are two independent halves —
          enabling one does not cover the other.
        </p>
      </Card>
    </div>
  );
}

// ---- the posture form -----------------------------------------------------

function PostureForm(props: { cur: InterceptionSettings }) {
  const act = useAction();
  const [f, setF] = useState<InterceptionSettings>(props.cur);
  const set = <K extends keyof InterceptionSettings>(k: K, val: InterceptionSettings[K]) =>
    setF((s) => ({ ...s, [k]: val }));
  const boolSel = (k: keyof InterceptionSettings, labels?: [string, string]) => (
    <Select
      value={String(f[k])}
      onChange={(e) => set(k, (e.target.value === "true") as never)}
    >
      <option value="false">{labels?.[0] ?? "disabled"}</option>
      <option value="true">{labels?.[1] ?? "enabled"}</option>
    </Select>
  );
  return (
    <Card title="Interception surfaces & resolution policy">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // PUT exactly the settings keys — the GET snapshot also carries row
          // metadata (id/timestamps) the endpoint rightly rejects
          void act.run(
            () =>
              api.put("/v1/interception/settings", {
                anthropicCompatEnabled: f.anthropicCompatEnabled,
                openaiCompatEnabled: f.openaiCompatEnabled,
                mcpInterceptionEnabled: f.mcpInterceptionEnabled,
                resolutionMode: f.resolutionMode,
                enforcementPosture: f.enforcementPosture,
                requireProjectAttribution: f.requireProjectAttribution,
                requireMcpAttribution: f.requireMcpAttribution,
                keyCustodyEnforced: f.keyCustodyEnforced,
                streamingOnBlockMode: f.streamingOnBlockMode,
                strictFieldRejection: f.strictFieldRejection,
              }),
            "Posture saved",
          );
        }}
        className={v.stack}
      >
        <div className={v.grid3}>
          <Field label="POST /v1/messages (Anthropic-shaped)">{boolSel("anthropicCompatEnabled")}</Field>
          <Field label="POST /v1/chat/completions (OpenAI-shaped)">{boolSel("openaiCompatEnabled")}</Field>
          <Field label="POST /mcp/:serverId (MCP tool calls)">{boolSel("mcpInterceptionEnabled")}</Field>
          <Field label="Model → agent resolution">
            <Select value={f.resolutionMode} onChange={(e) => set("resolutionMode", e.target.value as InterceptionSettings["resolutionMode"])}>
              <option value="map_by_model">map_by_model</option>
              <option value="require_agent">require_agent</option>
              <option value="router_decides">router_decides</option>
            </Select>
          </Field>
          <Field label="Declared ladder rung">
            <Select value={f.enforcementPosture} onChange={(e) => set("enforcementPosture", e.target.value as InterceptionSettings["enforcementPosture"])}>
              {(["observe", "voluntary", "managed", "key_custody", "network"] as const).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Require project attribution (compat)">{boolSel("requireProjectAttribution")}</Field>
          <Field label="Require MCP attribution">{boolSel("requireMcpAttribution")}</Field>
          <Field label="Enforce key custody">
            {boolSel("keyCustodyEnforced", ["off — BYO user keys allowed", "on — org/platform keys only"])}
          </Field>
          <Field label="Stream on PII-block project">
            <Select value={f.streamingOnBlockMode} onChange={(e) => set("streamingOnBlockMode", e.target.value as InterceptionSettings["streamingOnBlockMode"])}>
              <option value="suppress">suppress (buffer + disclose)</option>
              <option value="reject">reject (400 the stream request)</option>
            </Select>
          </Field>
          <Field label="Strict field rejection">
            {boolSel("strictFieldRejection", ["off — accept & disclose", "on — unsupported fields 400"])}
          </Field>
        </div>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Save posture
          </Button>
          {act.error && (
            <span className={v.errLine} role="alert">
              {act.error}
            </span>
          )}
        </div>
      </form>
      <details style={{ marginTop: "var(--s2)" }}>
        <summary className={v.dim} style={{ cursor: "pointer" }}>
          What each dial means
        </summary>
        <div style={{ marginTop: "var(--s1)" }}>
          <KV
            rows={[
              ["map_by_model", "Resolve to the governed agent whose model id matches the request. Several matches tie-break on lowest tier, then oldest. Least developer friction."],
              ["require_agent", "The caller MUST send x-regulait-agent-id; the model string is advisory. Missing header is a 400. Strictest, explicit attribution per call."],
              ["router_decides", "The requested model is a HINT the pillar-6 router may override for cost. The response always carries the model actually served, and the audit row records requested-vs-served."],
              ["Unmapped model", "Always 403 default-deny, in every mode. regulAIt never passes an ungoverned call through to the vendor."],
              ["Attribution (compat)", "ON rejects any compat call without an x-regulait-project-id header, rather than running it as untracked spend — but only enable it for clients that can send custom headers (see the matrix below)."],
              ["Attribution (MCP)", "Every MCP tool call is METERED whether or not it is attributed; an unattributed call lands in the explicit Unattributed bucket (Cost dashboard). Together the two require-toggles close the unattributed gap entirely."],
              ["Key custody", "ON: per-user BYO model credentials are refused (409, audited) and dispatch resolution skips stored user credentials. Existing user rows are kept but inert; turning it back off restores them."],
              ["Stream on block", "'suppress' (default) answers a stream request on a block-mode PII project with the same governed call fully buffered as JSON, disclosed via streamingSuppressed. 'reject' refuses it with a 400."],
              ["Strict fields", "Off (default): an unsupported-but-harmless field like temperature is accepted, NOT honoured, and disclosed in x-regulait-ignored-fields. On: any unsupported field is a 400."],
            ]}
          />
        </div>
      </details>
    </Card>
  );
}

// ---- scope rules (staged rollout) -----------------------------------------

function ScopeRulesCard() {
  const users = useUsers();
  const projects = useProjects();
  const roles = useRoles();
  const act = useAction();
  const rules = useQuery({
    queryKey: ["admin", "scope-rules"],
    queryFn: () => api.get<{ rules: ScopeRule[] }>("/v1/interception/scope-rules"),
  });

  const [scopeKind, setScopeKind] = useState<"user" | "project" | "role">("user");
  const [scopeId, setScopeId] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [openai, setOpenai] = useState("");
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [deleteRule, setDeleteRule] = useState<ScopeRule | null>(null);

  const targets =
    scopeKind === "user"
      ? userOpts(users.data?.users)
      : scopeKind === "project"
        ? projectOpts(projects.data?.projects)
        : roleOpts(roles.data?.roles);
  const tri = (val: string) => (val === "true" ? true : val === "false" ? false : undefined);

  return (
    <Card title="Staged rollout — per-scope overrides">
      <p className={v.dim}>
        Pilot a compat surface with one user, project, or role instead of flipping the org-wide switch.
        Precedence: <strong>user &gt; project &gt; role &gt; org</strong>; the first non-inherit value per
        field wins. A rule that enables a surface grants NOTHING — every dispatch still passes the same
        per-user entitlement check.
      </p>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act
            .run(
              () =>
                api.post("/v1/interception/scope-rules", {
                  scopeKind,
                  scopeId,
                  ...(tri(anthropic) !== undefined ? { anthropicCompatEnabled: tri(anthropic) } : {}),
                  ...(tri(openai) !== undefined ? { openaiCompatEnabled: tri(openai) } : {}),
                  ...(resolution ? { resolutionMode: resolution } : {}),
                  ...(note ? { note } : {}),
                }),
              "Scope rule created",
            )
            .then((ok) => ok && setNote(""));
        }}
      >
        <Field label="Scope">
          <Select
            value={scopeKind}
            onChange={(e) => {
              setScopeKind(e.target.value as "user" | "project" | "role");
              setScopeId("");
            }}
          >
            <option value="user">user (strongest)</option>
            <option value="project">project</option>
            <option value="role">role</option>
          </Select>
        </Field>
        <Field label="Target">
          <Select required value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
            {optionEls(targets, "— select —")}
          </Select>
        </Field>
        <Field label="/v1/messages">
          <Select value={anthropic} onChange={(e) => setAnthropic(e.target.value)}>
            <option value="">inherit</option>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </Select>
        </Field>
        <Field label="/v1/chat/completions">
          <Select value={openai} onChange={(e) => setOpenai(e.target.value)}>
            <option value="">inherit</option>
            <option value="true">enabled</option>
            <option value="false">disabled</option>
          </Select>
        </Field>
        <Field label="Resolution mode">
          <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <option value="">inherit</option>
            <option value="map_by_model">map_by_model</option>
            <option value="require_agent">require_agent</option>
            <option value="router_decides">router_decides</option>
          </Select>
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. anthropic pilot" />
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Create rule
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <Table<ScopeRule>
        columns={[
          {
            key: "scope",
            header: "Scope",
            render: (r) => `${r.scopeKind} · ${r.scopeName ?? r.scopeId.slice(0, 8) + "…"}`,
          },
          {
            key: "anthropic",
            header: "/v1/messages",
            render: (r) => (r.anthropicCompatEnabled === null ? "inherit" : String(r.anthropicCompatEnabled)),
          },
          {
            key: "openai",
            header: "/v1/chat/completions",
            render: (r) => (r.openaiCompatEnabled === null ? "inherit" : String(r.openaiCompatEnabled)),
          },
          { key: "resolution", header: "Resolution", render: (r) => r.resolutionMode ?? "inherit" },
          { key: "note", header: "Note", render: (r) => r.note ?? "—" },
          { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (r) => (
              <Button size="sm" variant="ghost" onClick={() => setDeleteRule(r)}>
                delete
              </Button>
            ),
          },
        ]}
        rows={rules.data?.rules ?? []}
        rowKey={(r) => r.id}
        loading={rules.isLoading}
        empty={<EmptyState title="No scope rules" body="The org singleton applies to everyone." />}
      />
      <ConfirmModal
        open={deleteRule !== null}
        title="Delete this scope rule?"
        body="The scope falls back to inheritance (project → role → org)."
        danger
        confirmLabel="Delete rule"
        onCancel={() => setDeleteRule(null)}
        onConfirm={() => {
          const r = deleteRule;
          setDeleteRule(null);
          if (r)
            void act.run(
              () => api.del(`/v1/interception/scope-rules/${r.id}`),
              "Rule deleted — the scope falls back to inheritance",
            );
        }}
      />
    </Card>
  );
}

// ---- effective values — live preview --------------------------------------

function EffectivePreviewCard() {
  const users = useUsers();
  const projects = useProjects();
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [result, setResult] = useState<EffectiveInterception | null>(null);

  const srcLabel = (s: { level: string; ruleId: string }) =>
    s.level === "org" ? "org singleton" : `${s.level} rule (${s.ruleId.slice(0, 8)}…)`;

  return (
    <Card title="Effective values — live preview">
      <p className={v.dim}>
        What would this user get right now? Runs the exact resolver the request gate uses, so the preview
        cannot drift from enforcement.
      </p>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            setResult(
              await api.get<EffectiveInterception>(
                `/v1/interception/effective?userId=${userId}${projectId ? `&projectId=${projectId}` : ""}`,
              ),
            );
          }, null);
        }}
      >
        <Field label="User">
          <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select a user —")}
          </Select>
        </Field>
        <Field label="Project (attribution header)">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "— none —")}
          </Select>
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Preview
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      {result && (
        <div style={{ marginTop: "var(--s2)" }} data-testid="effective-preview">
          <KV
            rows={[
              [
                "/v1/messages",
                <span key="a" className={v.rowTight}>
                  <Badge tone={result.effective.anthropicCompatEnabled ? "ok" : "warn"}>
                    {String(result.effective.anthropicCompatEnabled)}
                  </Badge>
                  <span className={v.faint}>
                    from {srcLabel(result.sources.anthropicCompatEnabled!)} (org:{" "}
                    {String(result.org.anthropicCompatEnabled)})
                  </span>
                </span>,
              ],
              [
                "/v1/chat/completions",
                <span key="o" className={v.rowTight}>
                  <Badge tone={result.effective.openaiCompatEnabled ? "ok" : "warn"}>
                    {String(result.effective.openaiCompatEnabled)}
                  </Badge>
                  <span className={v.faint}>
                    from {srcLabel(result.sources.openaiCompatEnabled!)} (org:{" "}
                    {String(result.org.openaiCompatEnabled)})
                  </span>
                </span>,
              ],
              [
                "resolution mode",
                <span key="r" className={v.rowTight}>
                  <Badge tone="info">{result.effective.resolutionMode}</Badge>
                  <span className={v.faint}>
                    from {srcLabel(result.sources.resolutionMode!)} (org: {result.org.resolutionMode})
                  </span>
                </span>,
              ],
            ]}
          />
          <p className={v.faint}>
            Surface exposure is NOT entitlement: an enabled surface only means the route exists for this
            user — every dispatch still runs the same per-user entitlement check.
          </p>
        </div>
      )}
    </Card>
  );
}

// ---- per-client config generator ------------------------------------------

const CLIENTS = [
  { v: "claude-code", l: "Claude Code" },
  { v: "cursor", l: "Cursor" },
  { v: "cline", l: "Cline" },
  { v: "roo", l: "Roo Code" },
  { v: "continue", l: "Continue" },
  { v: "zed", l: "Zed" },
  { v: "generic-anthropic", l: "Generic Anthropic-compatible" },
  { v: "generic-openai", l: "Generic OpenAI-compatible" },
];

function buildSnippet(opts: {
  client: string;
  base: string;
  serverId: string;
  projectId: string;
  model: string;
}): { snip: string; notes: string[] } {
  const KEYPH = "<REGULAIT_API_KEY>";
  const { base, projectId: pid } = opts;
  const sid = opts.serverId || "<MCP_SERVER_ID>";
  const model = opts.model || "claude-opus-5";
  const mcpUrl = `${base}/mcp/${sid}`;
  const hdrJson =
    `"Authorization": "Bearer ${KEYPH}"` +
    (pid ? `,\n        "x-regulait-project-id": "${pid}"` : "");
  const mcpJson = `{\n  "mcpServers": {\n    "regulait": {\n      "url": "${mcpUrl}",\n      "headers": {\n        ${hdrJson}\n      }\n    }\n  }\n}`;
  const notes: string[] = [];
  let snip = "";
  switch (opts.client) {
    case "claude-code":
      snip =
        `# Model calls -> regulAIt (Anthropic-shaped)\n` +
        `export ANTHROPIC_BASE_URL="${base}"\n` +
        `export ANTHROPIC_API_KEY="${KEYPH}"\n` +
        (pid ? `export ANTHROPIC_CUSTOM_HEADERS="x-regulait-project-id: ${pid}"\n` : "") +
        `\n# Tool calls -> regulAIt (governed MCP proxy)\n` +
        `claude mcp add --transport http regulait ${mcpUrl} --header "Authorization: Bearer ${KEYPH}"` +
        (pid ? ` --header "x-regulait-project-id: ${pid}"` : "") +
        `\n\n# or as .mcp.json in the repo root\n${mcpJson}`;
      notes.push(
        "Claude Code sends the key as x-api-key; POST /v1/messages accepts that header name for exactly this reason.",
        "ANTHROPIC_BASE_URL takes the ORIGIN — the client appends /v1/messages itself.",
      );
      break;
    case "cursor":
      snip =
        `# Cursor -> Settings -> Models -> OpenAI API Key -> Override base URL\n` +
        `Base URL:  ${base}/v1\nAPI key:   ${KEYPH}\nModel:     ${model}\n` +
        `\n# .cursor/mcp.json (tool calls)\n${mcpJson}`;
      notes.push(
        "Cursor takes an OpenAI-compatible endpoint, so enable POST /v1/chat/completions above.",
        "Cursor sends no custom headers on MODEL calls — with 'require project attribution' ON its completions would be rejected. Attribute its TOOL calls via the MCP header instead.",
      );
      break;
    case "cline":
    case "roo": {
      const nm = opts.client === "cline" ? "Cline" : "Roo Code";
      snip =
        `# ${nm} -> Settings -> API Provider: OpenAI Compatible\n` +
        `Base URL:  ${base}/v1\nAPI key:   ${KEYPH}\nModel ID:  ${model}\n` +
        `\n# or API Provider: Anthropic, with a custom base URL\nBase URL:  ${base}\nAPI key:   ${KEYPH}\n` +
        `\n# MCP settings JSON (tool calls)\n${mcpJson}`;
      notes.push(`${nm} accepts either shape — enable whichever surface above matches the provider you pick.`);
      break;
    }
    case "continue":
      snip =
        `# ~/.continue/config.yaml\nmodels:\n  - name: regulait\n    provider: openai\n    model: ${model}\n` +
        `    apiKey: ${KEYPH}\n    apiBase: ${base}/v1\n\n# MCP (tool calls)\n${mcpJson}`;
      notes.push(`For the Anthropic shape instead, use provider: anthropic and apiBase: ${base} .`);
      break;
    case "zed":
      snip =
        `// Zed settings.json\n{\n  "language_models": {\n    "anthropic": { "api_url": "${base}" },\n` +
        `    "openai": { "api_url": "${base}/v1" }\n  },\n` +
        `  "context_servers": {\n    "regulait": { "source": "custom", "url": "${mcpUrl}" }\n  }\n}\n` +
        `\n// the API key is entered in Zed's agent panel, not in settings.json`;
      notes.push("Zed cannot attach custom headers to model calls — leave 'require project attribution' off for it.");
      break;
    case "generic-anthropic":
      snip =
        `curl ${base}/v1/messages \\\n  -H "x-api-key: ${KEYPH}"\n` +
        (pid ? `  -H "x-regulait-project-id: ${pid}"\n` : "") +
        `  -H "content-type: application/json"\n` +
        `  -d '{"model":"${model}","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'\n` +
        `\n# base URL for any Anthropic SDK: ${base}`;
      notes.push("Authorization: Bearer <key> works identically — x-api-key is the alias Anthropic clients send.");
      break;
    default:
      snip =
        `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer ${KEYPH}"\n` +
        (pid ? `  -H "x-regulait-project-id: ${pid}"\n` : "") +
        `  -H "content-type: application/json"\n` +
        `  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'\n` +
        `\n# base URL for any OpenAI SDK: ${base}/v1`;
  }
  if (!opts.serverId)
    notes.push("No MCP server selected — the snippet carries a placeholder. Register one under Integrations → MCP servers.");
  if (!pid)
    notes.push(
      "No project selected — these calls run UNATTRIBUTED and land no per-project cost row. With 'require project attribution' ON they would be rejected outright.",
    );
  return { snip, notes };
}

function ConfigGeneratorCard() {
  const servers = useServers();
  const projects = useProjects();
  const { toast } = useToast();
  const [client, setClient] = useState("claude-code");
  const [serverId, setServerId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [out, setOut] = useState<{ snip: string; notes: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const base = window.location.origin;

  return (
    <Card title="Connect a client">
      <p className={v.dim}>
        Generated from this page's own origin ({base}). The snippet uses a placeholder for the API key on
        purpose — issue the developer their own key in Identity &amp; Access → Users, never paste yours.
      </p>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          setOut(buildSnippet({ client, base, serverId, projectId, model }));
          setCopied(false);
        }}
      >
        <Field label="Client">
          <Select value={client} onChange={(e) => setClient(e.target.value)}>
            {CLIENTS.map((c) => (
              <option key={c.v} value={c.v}>
                {c.l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="MCP server">
          <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {optionEls(serverOpts(servers.data?.servers), "— none / placeholder —")}
          </Select>
        </Field>
        <Field label="Project (attribution)">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {optionEls(projectOpts(projects.data?.projects), "— unattributed —")}
          </Select>
        </Field>
        <Field label="Model id">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-opus-5" />
        </Field>
        <Button type="submit" size="sm" variant="primary">
          Generate
        </Button>
      </form>
      {out && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          <div className={v.row}>
            <span className={v.sectionTitle} style={{ margin: 0 }}>
              Copy-paste config
            </span>
            <span className={v.grow} />
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(out.snip);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  toast("Clipboard unavailable — select the text manually", "error");
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className={a.snippet} data-testid="client-config">
            {out.snip}
          </pre>
          {out.notes.length > 0 && (
            <ul className={v.dim} style={{ margin: 0, paddingLeft: "var(--s3)" }}>
              {out.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
