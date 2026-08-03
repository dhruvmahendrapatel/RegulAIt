/**
 * Organization (ADR-0021) — the org_settings singleton in six sections, each
 * its own PARTIAL PUT so an admin can change one dial without restating the
 * rest. Every default equals the shipped behaviour, so an untouched page IS
 * the previous release. Sign-in & sessions lives in Identity & Access → SSO &
 * sessions.
 */
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, ConfirmModal, Field, Input, Select, Textarea } from "../../../ui/kit";
import { QueryGate, agentOpts, optionEls, useAction, useAgents } from "../adminKit";
import { useToast } from "../../../ui/toast";
import v from "../../views.module.css";

const CLEAR = "__clear__";

export default function OrganizationPage() {
  const q = useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings"),
  });
  return (
    <>
      <PageHeader
        title="Organization"
        sub="Org-wide functional defaults. Everything here used to be a hardcoded constant; now it is your choice. Org settings are CEILINGS: they only ever narrow what happens below them. Every save is audited with exactly which keys changed."
      />
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {q.data && <Loaded settings={q.data.settings} />}
      </QueryGate>
    </>
  );
}

/** one section = one form = one partial PUT */
function useSection(initial: Record<string, string>) {
  const act = useAction();
  const [f, setF] = useState(initial);
  const set = (k: string, val: string) => setF((s) => ({ ...s, [k]: val }));
  return { act, f, set };
}

function str(settings: Record<string, unknown>, k: string): string {
  const val = settings[k];
  return val == null ? "" : String(val);
}

function SectionShell(props: {
  title: string;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  submitLabel?: string;
  help: ReactNode;
  children: ReactNode;
}) {
  return (
    <form
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <div className={v.sectionTitle}>{props.title}</div>
      <div className={v.grid3}>{props.children}</div>
      <div className={v.row}>
        <Button type="submit" variant="primary" size="sm" disabled={props.busy}>
          {props.submitLabel ?? "Save"}
        </Button>
        {props.error && (
          <span className={v.errLine} role="alert">
            {props.error}
          </span>
        )}
      </div>
      <p className={v.faint}>{props.help}</p>
    </form>
  );
}

const ON_OFF = (
  <>
    <option value="true">enabled</option>
    <option value="false">disabled</option>
  </>
);

function Loaded(props: { settings: Record<string, unknown> }) {
  const s = props.settings;
  const agents = useAgents();
  const put = (body: Record<string, unknown>) => api.put("/v1/org/settings", body);
  const asBool = (val: string) => val === "true";

  // --- 1. Optimization -----------------------------------------------------
  const opt = useSection({
    routingEnabled: str(s, "routingEnabled"),
    compactionEnabled: str(s, "compactionEnabled"),
    promptCachingEnabled: str(s, "promptCachingEnabled"),
    editVsRewriteEnabled: str(s, "editVsRewriteEnabled"),
    filePreprocessingEnabled: str(s, "filePreprocessingEnabled"),
    lazyToolLoadingEnabled: str(s, "lazyToolLoadingEnabled"),
    defaultRoutingMode: str(s, "defaultRoutingMode"),
    semanticCachePolicy: str(s, "semanticCachePolicy"),
    semanticCacheTtlSeconds: str(s, "semanticCacheTtlSeconds"),
    compactionFailureMode: str(s, "compactionFailureMode"),
    summarizerSelection: str(s, "summarizerSelection"),
    summarizerAgentId: "",
    compactionThresholdTokens: str(s, "compactionThresholdTokens"),
    compactionRecentWindow: str(s, "compactionRecentWindow"),
    minCacheableTokens: str(s, "minCacheableTokens"),
    cacheReadDiscount: str(s, "cacheReadDiscount"),
    maxToolsInManifest: str(s, "maxToolsInManifest"),
    minEditableBaselineTokens: str(s, "minEditableBaselineTokens"),
    batchOverheadTokens: str(s, "batchOverheadTokens"),
    minPreprocessTokens: str(s, "minPreprocessTokens"),
  });

  // --- 2. Compliance defaults ----------------------------------------------
  const comp = useSection({
    defaultPiiMode: str(s, "defaultPiiMode"),
    envKeyFallbackEnabled: str(s, "envKeyFallbackEnabled"),
  });
  const [envProviders, setEnvProviders] = useState<string[]>(
    Array.isArray(s.envFallbackProviders) ? (s.envFallbackProviders as string[]) : [],
  );

  // --- 2b. Custom LLM providers (ADR-0034) ---------------------------------
  const custom = useSection({
    customModelProvidersEnabled: str(s, "customModelProvidersEnabled"),
  });

  // --- 2c. MCP egress posture (ADR-0043) -----------------------------------
  const mcpEgress = useSection({
    mcpPrivateRangesDefault: str(s, "mcpPrivateRangesDefault"),
  });

  // --- 2d. Deployment egress posture (ADR-0062) ----------------------------
  const compiledEgress = useSection({
    egressCompiledDefaultPolicy: str(s, "egressCompiledDefaultPolicy"),
  });

  // --- 3. Budgets & limits -------------------------------------------------
  const budget = useSection({
    budgetEnforcement: str(s, "budgetEnforcement"),
    budgetHardBlockPct: str(s, "budgetHardBlockPct"),
    defaultWorkerMaxTurns: str(s, "defaultWorkerMaxTurns"),
    maxWorkerTurns: str(s, "maxWorkerTurns"),
    maxAttachmentsPerDispatch: str(s, "maxAttachmentsPerDispatch"),
    maxAttachmentBytes: str(s, "maxAttachmentBytes"),
    imageTokenEstimateTokens: str(s, "imageTokenEstimateTokens"),
    sharedContextMaxChars: str(s, "sharedContextMaxChars"),
    nodeOutputMaxChars: str(s, "nodeOutputMaxChars"),
  });

  // --- 4. Approvals --------------------------------------------------------
  const approvals = useSection({
    approvalQuorum: str(s, "approvalQuorum"),
    approvalDelegationEnabled: str(s, "approvalDelegationEnabled"),
  });

  // --- 7. Network access (ADR-0039) ----------------------------------------
  // Not a useSection form: the save needs the confirm-on-lockout retry flow
  // (a 409 ip_policy_lockout opens an explicit confirm modal, and only a
  // confirmed resend carries confirmIpLockout: true).
  const { toast } = useToast();
  const qc = useQueryClient();
  const [netForm, setNetForm] = useState({
    sessionIpPolicy: str(s, "sessionIpPolicy") || "off",
    apiKeyIpPolicy: str(s, "apiKeyIpPolicy") || "off",
  });
  const [ipAllowlistText, setIpAllowlistText] = useState<string>(
    Array.isArray(s.sessionIpAllowlist) ? (s.sessionIpAllowlist as string[]).join("\n") : "",
  );
  const [netBusy, setNetBusy] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [lockoutPrompt, setLockoutPrompt] = useState<string | null>(null);
  const saveNet = async (confirmIpLockout: boolean) => {
    setNetBusy(true);
    setNetError(null);
    const list = ipAllowlistText
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      await put({
        sessionIpPolicy: netForm.sessionIpPolicy,
        apiKeyIpPolicy: netForm.apiKeyIpPolicy,
        sessionIpAllowlist: list.length ? list : null,
        ...(confirmIpLockout ? { confirmIpLockout: true } : {}),
      });
      setLockoutPrompt(null);
      toast("Network access policy saved (audited)", "success");
      void qc.invalidateQueries({ queryKey: ["admin"] });
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "ip_policy_lockout") {
        // the gateway's self-lockout guard: continuing requires an explicit,
        // eyes-open confirm — surfaced as a modal, never silently retried
        setLockoutPrompt(
          err.payload.detail ??
            "This allow-list excludes your own current IP under continuous enforcement — saving would sign you out on your next request.",
        );
      } else {
        setNetError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setNetBusy(false);
    }
  };

  // --- 5. Audit retention --------------------------------------------------
  const retention = useSection({
    autoPruneEnabled: str(s, "autoPruneEnabled"),
    pruneIntervalHours: str(s, "pruneIntervalHours"),
    defaultAuditRetentionDays: s.defaultAuditRetentionDays == null ? "0" : String(s.defaultAuditRetentionDays),
  });

  const numField = (
    section: ReturnType<typeof useSection>,
    label: string,
    k: string,
    ph?: string,
  ) => (
    <Field label={label}>
      <Input
        type="number"
        step="any"
        required
        value={section.f[k]}
        onChange={(e) => section.set(k, e.target.value)}
        placeholder={ph}
      />
    </Field>
  );

  return (
    <div className={v.stack}>
      <Card title="1 · Optimization — pillar-6 techniques (org-wide ceilings)">
        <SectionShell
          title="Technique toggles"
          busy={opt.act.busy}
          error={opt.act.error}
          submitLabel="Save optimization settings"
          onSubmit={() =>
            void opt.act.run(
              () =>
                put({
                  routingEnabled: asBool(opt.f.routingEnabled!),
                  compactionEnabled: asBool(opt.f.compactionEnabled!),
                  promptCachingEnabled: asBool(opt.f.promptCachingEnabled!),
                  editVsRewriteEnabled: asBool(opt.f.editVsRewriteEnabled!),
                  filePreprocessingEnabled: asBool(opt.f.filePreprocessingEnabled!),
                  lazyToolLoadingEnabled: asBool(opt.f.lazyToolLoadingEnabled!),
                  defaultRoutingMode: opt.f.defaultRoutingMode,
                  semanticCachePolicy: opt.f.semanticCachePolicy,
                  semanticCacheTtlSeconds: Number(opt.f.semanticCacheTtlSeconds),
                  compactionFailureMode: opt.f.compactionFailureMode,
                  summarizerSelection: opt.f.summarizerSelection,
                  ...(opt.f.summarizerAgentId
                    ? { summarizerAgentId: opt.f.summarizerAgentId === CLEAR ? null : opt.f.summarizerAgentId }
                    : {}),
                  compactionThresholdTokens: Number(opt.f.compactionThresholdTokens),
                  compactionRecentWindow: Number(opt.f.compactionRecentWindow),
                  minCacheableTokens: Number(opt.f.minCacheableTokens),
                  cacheReadDiscount: Number(opt.f.cacheReadDiscount),
                  maxToolsInManifest: Number(opt.f.maxToolsInManifest),
                  minEditableBaselineTokens: Number(opt.f.minEditableBaselineTokens),
                  batchOverheadTokens: Number(opt.f.batchOverheadTokens),
                  minPreprocessTokens: Number(opt.f.minPreprocessTokens),
                }),
              "Optimization settings saved (audited)",
            )
          }
          help="Each toggle is the org CEILING for one cost-optimization technique: disabled means it never runs for anyone. Enabled (the default — today's behaviour) defers to each user's own routing mode; a user's explicit passthrough always wins. Semantic cache 'off' beats a caller's semanticCache:true. Compaction 'fail closed' refuses the turn when summarization fails. A fixed summarizer must still be in the calling user's own entitled roster — it can never widen entitlement. The numeric dials are the formerly-hardcoded kernel constants (compact past 1600 tokens keeping 4 messages verbatim; cache 1024+ token prefixes at a 0.9 read discount; at most 20 lazy-loaded tools; diff edits over 200-token baselines)."
        >
          {(
            [
              ["Model routing", "routingEnabled"],
              ["Context compaction", "compactionEnabled"],
              ["Prompt caching", "promptCachingEnabled"],
              ["Edit vs rewrite", "editVsRewriteEnabled"],
              ["File preprocessing", "filePreprocessingEnabled"],
              ["Lazy tool loading", "lazyToolLoadingEnabled"],
            ] as const
          ).map(([label, k]) => (
            <Field key={k} label={label}>
              <Select value={opt.f[k]} onChange={(e) => opt.set(k, e.target.value)}>
                {ON_OFF}
              </Select>
            </Field>
          ))}
          <Field label="Default for unset users">
            <Select value={opt.f.defaultRoutingMode} onChange={(e) => opt.set("defaultRoutingMode", e.target.value)}>
              <option value="automatic">automatic (optimize)</option>
              <option value="passthrough">passthrough (never optimize)</option>
            </Select>
          </Field>
          <Field label="Semantic cache">
            <Select value={opt.f.semanticCachePolicy} onChange={(e) => opt.set("semanticCachePolicy", e.target.value)}>
              <option value="opt_in">opt-in (caller asks — default)</option>
              <option value="off">off (even if the caller asks)</option>
              <option value="always">always (every eligible dispatch)</option>
            </Select>
          </Field>
          {numField(opt, "Cache TTL seconds", "semanticCacheTtlSeconds")}
          <Field label="Compaction failure">
            <Select value={opt.f.compactionFailureMode} onChange={(e) => opt.set("compactionFailureMode", e.target.value)}>
              <option value="fail_open">fail open (turn proceeds, full history)</option>
              <option value="fail_closed">fail closed (turn is refused)</option>
            </Select>
          </Field>
          <Field label="Summarizer">
            <Select value={opt.f.summarizerSelection} onChange={(e) => opt.set("summarizerSelection", e.target.value)}>
              <option value="cheapest">cheapest entitled agent (default)</option>
              <option value="fixed_agent">a fixed agent</option>
            </Select>
          </Field>
          <Field label="Fixed summarizer agent">
            <Select value={opt.f.summarizerAgentId} onChange={(e) => opt.set("summarizerAgentId", e.target.value)}>
              {optionEls(
                [{ v: CLEAR, l: "— clear (use cheapest) —" }, ...agentOpts(agents.data?.agents)],
                "— leave unchanged —",
              )}
            </Select>
          </Field>
          {numField(opt, "Compaction threshold (tokens)", "compactionThresholdTokens")}
          {numField(opt, "Verbatim window (messages)", "compactionRecentWindow")}
          {numField(opt, "Min cacheable prefix (tokens)", "minCacheableTokens")}
          {numField(opt, "Cache read discount (0..1)", "cacheReadDiscount")}
          {numField(opt, "Max tools in manifest", "maxToolsInManifest")}
          {numField(opt, "Min editable baseline (tokens)", "minEditableBaselineTokens")}
          {numField(opt, "Batch overhead (tokens)", "batchOverheadTokens")}
          {numField(opt, "Min preprocess size (tokens)", "minPreprocessTokens")}
        </SectionShell>
      </Card>

      <Card title="2 · Compliance defaults">
        <SectionShell
          title="PII + env-key fallback"
          busy={comp.act.busy}
          error={comp.act.error}
          submitLabel="Save compliance defaults"
          onSubmit={() =>
            void comp.act.run(
              () =>
                put({
                  defaultPiiMode: comp.f.defaultPiiMode,
                  envKeyFallbackEnabled: asBool(comp.f.envKeyFallbackEnabled!),
                  ...(envProviders.length ? { envFallbackProviders: envProviders } : {}),
                }),
              "Compliance defaults saved (audited)",
            )
          }
          help="Default PII mode applies wherever a project-attributed call resolves to NO compliance-cascade PII policy (an unclassified project, or tags with no profile). A classified project's own cascade always wins — this fills the gap, it never overrides a framework. The env-var fallback lets a dispatch use ANTHROPIC_API_KEY-style server env vars when no credential is stored; regulated orgs can turn it off to force every key through the encrypted store, or narrow which providers may use it."
        >
          <Field label="Default PII mode (unclassified projects)">
            <Select value={comp.f.defaultPiiMode} onChange={(e) => comp.set("defaultPiiMode", e.target.value)}>
              <option value="none">none — no enforcement (default)</option>
              <option value="log">log — record category counts</option>
              <option value="warn">warn — proceed with warning</option>
              <option value="block">block — deny / withhold</option>
            </Select>
          </Field>
          <Field label="Env-var key fallback">
            <Select value={comp.f.envKeyFallbackEnabled} onChange={(e) => comp.set("envKeyFallbackEnabled", e.target.value)}>
              {ON_OFF}
            </Select>
          </Field>
          <Field label="Providers allowed to fall back (ctrl/cmd-click; empty = keep stored)">
            <Select
              multiple
              size={4}
              value={envProviders}
              onChange={(e) => setEnvProviders(Array.from(e.target.selectedOptions).map((o) => o.value))}
            >
              {["anthropic", "openai", "google", "xai"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        </SectionShell>
      </Card>

      <Card title="3 · Custom LLM providers (ADR-0034)">
        <SectionShell
          title="Master switch"
          busy={custom.act.busy}
          error={custom.act.error}
          submitLabel="Save custom-provider switch"
          onSubmit={() =>
            void custom.act.run(
              () => put({ customModelProvidersEnabled: asBool(custom.f.customModelProvidersEnabled!) }),
              "Custom-provider switch saved (audited)",
            )
          }
          help="The 'remove the capability entirely' switch for admin-registered endpoints (Ollama, vLLM, LM Studio, an internal gateway). It is NOT the thing standing between this org and an open proxy — the capability is already default-deny four separate ways beneath it: registration is admin-only, the egress allow-list starts empty, a provider stays disabled until a connection test passes, and a user still needs the ordinary per-agent grant. Off refuses registration and enablement and stops every custom dispatch with a 409 before any request leaves the box; the Integrations → Custom LLM providers page then says so plainly instead of appearing broken."
        >
          <Field label="Custom LLM providers">
            <Select
              value={custom.f.customModelProvidersEnabled}
              onChange={(e) => custom.set("customModelProvidersEnabled", e.target.value)}
            >
              <option value="true">enabled (default — admins may register endpoints)</option>
              <option value="false">disabled (capability removed org-wide)</option>
            </Select>
          </Field>
        </SectionShell>
      </Card>

      <Card title="3b · MCP egress posture (ADR-0043)">
        <SectionShell
          title="Private ranges for MCP servers"
          busy={mcpEgress.act.busy}
          error={mcpEgress.act.error}
          submitLabel="Save MCP egress posture"
          onSubmit={() =>
            void mcpEgress.act.run(
              () => put({ mcpPrivateRangesDefault: asBool(mcpEgress.f.mcpPrivateRangesDefault!) }),
              "MCP egress posture saved (audited)",
            )
          }
          help="The default for MCP servers that never took an explicit per-server decision (their flag is 'inherit'). Open (default) = a self-hosted MCP server on a private address (http://mcp.internal:9000, http://localhost:3000) works with zero ceremony — the guard fires on the risky public-internet case, not the ordinary internal one. Strict = every server needs its own explicit allow-private-ranges flag (set on the MCP servers page) or an egress allow entry with the private-range opt-in. Either way, link-local / instance-metadata (169.254.0.0/16) and the other never-legitimate ranges stay unconditionally blocked, and a public-internet MCP URL still requires an egress allow entry."
        >
          <Field label="Private-range default for MCP servers">
            <Select
              value={mcpEgress.f.mcpPrivateRangesDefault}
              onChange={(e) => mcpEgress.set("mcpPrivateRangesDefault", e.target.value)}
            >
              <option value="true">open (default — private-LAN MCP servers just work)</option>
              <option value="false">strict (each server needs an explicit opt-in)</option>
            </Select>
          </Field>
        </SectionShell>
      </Card>

      <Card title="3c · Compiled vendor endpoints (ADR-0062)">
        <SectionShell
          title="Deployment egress posture"
          busy={compiledEgress.act.busy}
          error={compiledEgress.act.error}
          submitLabel="Save egress posture"
          onSubmit={() =>
            void compiledEgress.act.run(
              () =>
                put({
                  egressCompiledDefaultPolicy: compiledEgress.f
                    .egressCompiledDefaultPolicy as "inherit" | "strict",
                }),
              "Deployment egress posture saved (audited)",
            )
          }
          help="The egress guard has always adjudicated URLs a human typed. It did not adjudicate the endpoint a built-in adapter falls back to with no baseUrl override — api.anthropic.com, slack.com, api.github.com and friends — because nobody can type a constant. That is a complete answer to SSRF and no answer at all to 'may this installation reach that vendor'. This dial can only TIGHTEN: the deployment-wide posture comes from the server's REGULAIT_DEPLOY_MODE (air_gapped is always strict, and nothing here can loosen it, because 'is this box air-gapped' is not something a portal toggle can know). Strict = a dispatch that would run on a compiled vendor endpoint is refused with a 403 and audited unless that host is in Egress Allow Hosts; a self-hosted model on a private address keeps working once allow-listed. Inherit = today's behaviour on a hosted or BYOC box."
        >
          <Field label="Compiled vendor endpoints">
            <Select
              value={compiledEgress.f.egressCompiledDefaultPolicy}
              onChange={(e) => compiledEgress.set("egressCompiledDefaultPolicy", e.target.value)}
            >
              <option value="inherit">inherit (default — the server's deploy mode decides)</option>
              <option value="strict">strict (adjudicate them even on a hosted/BYOC box)</option>
            </Select>
          </Field>
        </SectionShell>
      </Card>

      <Card title="4 · Budgets & limits">
        <SectionShell
          title="Budget enforcement + worker/size ceilings"
          busy={budget.act.busy}
          error={budget.act.error}
          submitLabel="Save budgets & limits"
          onSubmit={() =>
            void budget.act.run(
              () =>
                put({
                  budgetEnforcement: budget.f.budgetEnforcement,
                  budgetHardBlockPct: Number(budget.f.budgetHardBlockPct),
                  defaultWorkerMaxTurns: Number(budget.f.defaultWorkerMaxTurns),
                  maxWorkerTurns: Number(budget.f.maxWorkerTurns),
                  maxAttachmentsPerDispatch: Number(budget.f.maxAttachmentsPerDispatch),
                  maxAttachmentBytes: Number(budget.f.maxAttachmentBytes),
                  imageTokenEstimateTokens: Number(budget.f.imageTokenEstimateTokens),
                  sharedContextMaxChars: Number(budget.f.sharedContextMaxChars),
                  nodeOutputMaxChars: Number(budget.f.nodeOutputMaxChars),
                }),
              "Budgets & limits saved (audited)",
            )
          }
          help="'Block' (default) refuses attributed dispatches once measured spend reaches the hard-block threshold, until the named approver sanctions the overage. 'Warn only' still files the overage into the Approvals queue and audits every crossing, but lets the calls run — showback without enforcement. Worker caps bound the pillar-7 tool-using loop; the size ceilings narrow below their API walls (at most 8 attachments of 6 MiB, a flat 1200-token estimate per image, 100k-char node instructions, 20k chars of stored node output)."
        >
          <Field label="Project budget enforcement">
            <Select value={budget.f.budgetEnforcement} onChange={(e) => budget.set("budgetEnforcement", e.target.value)}>
              <option value="block">block (409 past the threshold — default)</option>
              <option value="warn_only">warn only (escalate + audit, let it run)</option>
            </Select>
          </Field>
          {numField(budget, "Hard-block at % of budget", "budgetHardBlockPct")}
          {numField(budget, "Worker default max turns", "defaultWorkerMaxTurns")}
          {numField(budget, "Worker hard turn ceiling", "maxWorkerTurns")}
          {numField(budget, "Max attachments / dispatch", "maxAttachmentsPerDispatch")}
          {numField(budget, "Max attachment bytes", "maxAttachmentBytes")}
          {numField(budget, "Image token estimate", "imageTokenEstimateTokens")}
          {numField(budget, "Node instruction max chars", "sharedContextMaxChars")}
          {numField(budget, "Stored node output max chars", "nodeOutputMaxChars")}
        </SectionShell>
      </Card>

      <Card title="5 · Approvals">
        <SectionShell
          title="Quorum + delegation"
          busy={approvals.act.busy}
          error={approvals.act.error}
          submitLabel="Save approval policy"
          onSubmit={() =>
            void approvals.act.run(
              () =>
                put({
                  approvalQuorum: approvals.f.approvalQuorum,
                  approvalDelegationEnabled: asBool(approvals.f.approvalDelegationEnabled!),
                }),
              "Approval policy saved (audited)",
            )
          }
          help="Applies to workflow human_approval stages. 'All' (default — today's behaviour): the stage advances only when every named approver has approved; any denial denies it. 'Any': the first approval advances the stage and the remaining pending approvals are superseded so no dead gate lingers. Approver delegation: when disabled, creating delegation windows is refused and existing windows stop applying immediately — for orgs whose control posture forbids deciding in another's name."
        >
          <Field label="Human-approval quorum">
            <Select value={approvals.f.approvalQuorum} onChange={(e) => approvals.set("approvalQuorum", e.target.value)}>
              <option value="all">all named approvers (default)</option>
              <option value="any">any one approver advances</option>
            </Select>
          </Field>
          <Field label="Approver delegation">
            <Select
              value={approvals.f.approvalDelegationEnabled}
              onChange={(e) => approvals.set("approvalDelegationEnabled", e.target.value)}
            >
              <option value="true">enabled (delegation windows apply)</option>
              <option value="false">disabled (strict separation of duties)</option>
            </Select>
          </Field>
        </SectionShell>
      </Card>

      <Card title="6 · Audit retention">
        <SectionShell
          title="Scheduled auto-prune + org default retention"
          busy={retention.act.busy}
          error={retention.act.error}
          submitLabel="Save retention policy"
          onSubmit={() =>
            void retention.act.run(
              () =>
                put({
                  autoPruneEnabled: asBool(retention.f.autoPruneEnabled!),
                  pruneIntervalHours: Number(retention.f.pruneIntervalHours),
                  defaultAuditRetentionDays:
                    Number(retention.f.defaultAuditRetentionDays) === 0
                      ? null
                      : Number(retention.f.defaultAuditRetentionDays),
                }),
              "Retention policy saved (audited)",
            )
          }
          help="Off by default: pruning only happens when an admin presses the button on the Audit log page. When on, the gateway prunes on the configured interval under the SAME floor the manual button uses. The org default retention only fills the gap when no compliance profile sets one — a profile floor always wins upward, so this can never shorten a framework's audit trail. Enter 0 to clear the org default (never prune without a profile floor). Every prune, manual or scheduled, is itself audited."
        >
          <Field label="Scheduled auto-prune">
            <Select value={retention.f.autoPruneEnabled} onChange={(e) => retention.set("autoPruneEnabled", e.target.value)}>
              <option value="false">off (manual prune only — default)</option>
              <option value="true">on (prune on a schedule)</option>
            </Select>
          </Field>
          {numField(retention, "Prune interval (hours)", "pruneIntervalHours")}
          {numField(retention, "Org default retention (days, 0 = none)", "defaultAuditRetentionDays")}
        </SectionShell>
      </Card>

      <Card title="7 · Network access — IP allow-listing (ADR-0039)">
        <SectionShell
          title="Trusted-network policy"
          busy={netBusy}
          error={netError}
          submitLabel="Save network access policy"
          onSubmit={() => void saveNet(false)}
          help="Confine sign-ins to your corporate networks by CIDR (IPv4 + IPv6, one block per line; empty = no restriction — the upgrade-safe default). The HUMAN knob governs password/SSO sessions: 'enforce at login' refuses new sign-ins from outside the list (existing sessions untouched); 'enforce continuously' also checks every request and force-signs-out a session the moment it leaves the envelope (fail-closed: an undeterminable client IP counts as outside). The API-KEY knob is a deliberately SEPARATE choice for automation (CI runners, IDEs, key-exchanged sessions) over the same list — so 'humans confined, CI not' is a visible chosen state, and tightening one path never silently locks out the other. The deploy-time bootstrap token is never IP-restricted (break-glass recovery). Malformed CIDR blocks are refused at save time; saving a continuous policy that excludes your own current IP demands an explicit confirmation. Behind a TLS-terminating proxy the gateway must trust it (REGULAIT_TRUSTED_PROXIES) or the observed client IP is the proxy's. Every denial and forced sign-out is audited with the IP and the policy that fired."
        >
          <Field label="Human session policy">
            <Select
              value={netForm.sessionIpPolicy}
              onChange={(e) => setNetForm((f) => ({ ...f, sessionIpPolicy: e.target.value }))}
            >
              <option value="off">off — no IP restriction (default)</option>
              <option value="enforce_at_login">enforce at login — new sign-ins only</option>
              <option value="enforce_continuous">enforce continuously — force sign-out when outside</option>
            </Select>
          </Field>
          <Field label="API-key policy (separate knob)">
            <Select
              value={netForm.apiKeyIpPolicy}
              onChange={(e) => setNetForm((f) => ({ ...f, apiKeyIpPolicy: e.target.value }))}
            >
              <option value="off">off — automation unrestricted (default)</option>
              <option value="enforce_at_login">enforce at key-exchange sign-in</option>
              <option value="enforce_continuous">enforce continuously — every request</option>
            </Select>
          </Field>
          <Field label="Allowed CIDR blocks (one per line)">
            <Textarea
              rows={4}
              value={ipAllowlistText}
              onChange={(e) => setIpAllowlistText(e.target.value)}
              placeholder={"10.0.0.0/8\n203.0.113.0/24\n2001:db8::/32"}
            />
          </Field>
        </SectionShell>
        <ConfirmModal
          open={lockoutPrompt !== null}
          title="This policy would lock YOU out"
          body={lockoutPrompt ?? ""}
          danger
          confirmLabel="Save anyway (sign me out)"
          onCancel={() => setLockoutPrompt(null)}
          onConfirm={() => void saveNet(true)}
        />
      </Card>
    </div>
  );
}
