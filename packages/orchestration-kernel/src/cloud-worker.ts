/**
 * Cloud coding agents as governed pillar-7 workers (ADR-0320, gap G5).
 *
 * PURE and zero-I/O, like the rest of this kernel. The gateway loads state,
 * calls these functions, sends the request they describe through its guarded
 * fetch, and writes the audit and usage rows. Nothing here sees a credential:
 * the gateway adds the Authorization header on the registered origin only.
 *
 * Every reply parser validates with zod and fails closed: a reply this module
 * does not recognise becomes `failed`, never `succeeded`.
 *
 * Vendor contracts were checked on 2026-11-15 (ADR-0320 "Sources"). Fields
 * marked UNVERIFIED below are not in the vendor's published docs and are
 * confirmed against a live account before any live use; until then only the
 * fake servers in the gateway tests exercise them.
 */

import { z } from "zod";

export class CloudWorkerNotReadyError extends Error {}

export const CLOUD_WORKER_PROVIDERS = ["cursor", "devin", "github_copilot", "openai_codex"] as const;
export type CloudWorkerProviderId = (typeof CLOUD_WORKER_PROVIDERS)[number];

/** `fake_verified`: built from the verified public contract and tested against
 * fake servers. `contract_unverified`: the request shape is not verified, so
 * the gateway must refuse to dispatch (ADR-0320 §1). Flipping a provider to
 * ready is a code change with its own review, never a setting. */
export const CLOUD_WORKER_READINESS: Readonly<Record<CloudWorkerProviderId, "fake_verified" | "contract_unverified">> =
  Object.freeze({
    cursor: "fake_verified",
    devin: "fake_verified",
    github_copilot: "contract_unverified",
    openai_codex: "contract_unverified",
  });

/** Branch prefixes the provider itself is documented to use for its work
 * branch. Cursor pushes `cursor/...` when `workOnCurrentBranch` is false. */
export const PROVIDER_HEAD_PREFIXES: Readonly<Record<CloudWorkerProviderId, readonly string[]>> = Object.freeze({
  cursor: ["cursor/"],
  devin: [],
  github_copilot: [],
  openai_codex: [],
});

// ---------------------------------------------------------------------------
// Input schemas. Every pattern is anchored, has no nested quantifier and runs
// on a length-capped string (linear time; no ReDoS on caller input).
// ---------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_CHARS_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const EXTERNAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A git ref name safe to send to a provider and compare by prefix. Stricter
 * than `git check-ref-format`: a narrow character set and no `..`, `//`, `@{`,
 * leading `-` or `/`, trailing `/`, `.` or `.lock`. */
export function isSafeRefName(ref: string): boolean {
  if (ref.length > 200 || !REF_CHARS_RE.test(ref)) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.startsWith(".")) return false;
  if (ref.endsWith(".") || ref.endsWith(".lock")) return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("/.")) return false;
  return true;
}

export const cloudRepoRefSchema = z
  .object({
    host: z.string().max(253).regex(HOST_RE).default("github.com"),
    owner: z.string().max(39).regex(OWNER_RE),
    name: z
      .string()
      .max(100)
      .regex(REPO_RE)
      .refine((s) => s !== "." && s !== "..", "invalid repository name"),
  })
  .strict();
export type CloudRepoRef = z.infer<typeof cloudRepoRefSchema>;

const refSchema = z.string().max(200).refine(isSafeRefName, "unsafe ref name");

export const cloudWorkerTaskSchema = z
  .object({
    provider: z.enum(CLOUD_WORKER_PROVIDERS),
    repo: cloudRepoRefSchema,
    baseBranch: refSchema,
    /** The work branch must start with this; defaults to `regulait/<runId>/` at the gateway. It ends in
     * `/` so `regulait/run1/` cannot match `regulait/run10/`. */
    branchPrefix: z
      .string()
      .min(2)
      .max(200)
      .refine((s) => s.endsWith("/") && isSafeRefName(s.slice(0, -1)), "prefix must be a safe ref ending in /"),
    prompt: z.string().min(1).max(32_000),
    /** Per-dispatch budget cap in USD, reserved before launch (ADR-0320 §2.5). */
    budgetCapUsd: z.number().finite().positive().max(10_000),
    /** Idempotency key, one per dispatch attempt. */
    dispatchId: z.uuid(),
  })
  .strict();
export type CloudWorkerTask = z.infer<typeof cloudWorkerTaskSchema>;

// ---------------------------------------------------------------------------
// The pinned-scope preamble. The repository and branches come from the stage's
// git connection, never from the prompt; the preamble tells the agent the same
// thing, and the result is checked regardless (checkCapturedPr).
// ---------------------------------------------------------------------------

export function pinnedPrompt(task: CloudWorkerTask): string {
  const repo = `${task.repo.host}/${task.repo.owner}/${task.repo.name}`;
  return [
    "RegulAIt governed task. Scope is fixed and checked after you finish:",
    `- repository: ${repo} (no other repository)`,
    `- base branch: ${task.baseBranch}`,
    `- work branch: must start with ${task.branchPrefix}`,
    "- open exactly one pull request against the base branch; do not merge it",
    "",
    task.prompt,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Request builders. They describe a request; the gateway sends it.
// ---------------------------------------------------------------------------

export interface CloudRequest {
  method: "GET" | "POST" | "DELETE";
  /** Path on the provider's registered base URL; ids are validated and encoded. */
  path: string;
  body?: Record<string, unknown>;
}

/** Ids we put into a path came from the provider's own reply; validate them. */
export function safeExternalId(id: string): string {
  if (!EXTERNAL_ID_RE.test(id)) throw new CloudWorkerNotReadyError("unsafe external id");
  return encodeURIComponent(id);
}

function assertReady(provider: CloudWorkerProviderId): void {
  if (CLOUD_WORKER_READINESS[provider] !== "fake_verified") {
    throw new CloudWorkerNotReadyError(`provider ${provider} contract is unverified (ADR-0320 §1)`);
  }
}

export interface LaunchOptions {
  /** Devin only: the ACU limit from providerSpendLimit. Required for Devin. */
  maxAcuLimit?: number;
}

export function buildLaunchRequest(task: CloudWorkerTask, opts: LaunchOptions = {}): CloudRequest {
  assertReady(task.provider);
  const text = pinnedPrompt(task);
  switch (task.provider) {
    case "cursor":
      return {
        method: "POST",
        path: "/v1/agents",
        body: {
          prompt: { text },
          repos: [
            { url: `https://${task.repo.host}/${task.repo.owner}/${task.repo.name}`, startingRef: task.baseBranch },
          ],
          // A new branch, never the base branch (verified: false = new cursor/... branch).
          workOnCurrentBranch: false,
          autoCreatePR: true,
          mode: "agent",
          name: `regulait ${task.dispatchId}`,
          // Idempotent create (verified: `bc-<uuid>`).
          agentId: `bc-${task.dispatchId}`,
        },
      };
    case "devin": {
      if (!opts.maxAcuLimit || !Number.isInteger(opts.maxAcuLimit) || opts.maxAcuLimit < 1) {
        throw new CloudWorkerNotReadyError("devin dispatch needs a positive integer max_acu_limit");
      }
      return {
        method: "POST",
        path: "/v1/sessions",
        body: {
          prompt: text,
          title: `regulait ${task.dispatchId}`,
          tags: ["regulait", `dispatch:${task.dispatchId}`],
          idempotent: true,
          max_acu_limit: opts.maxAcuLimit,
          // Least privilege: an empty array means none (verified); null would mean all.
          secret_ids: [],
          knowledge_ids: [],
          unlisted: true,
        },
      };
    }
    default:
      throw new CloudWorkerNotReadyError(`provider ${task.provider} has no adapter`);
  }
}

/** The provider handle the gateway stores after a launch. */
export interface CloudHandle {
  externalId: string;
  /** Cursor: the initial run id. */
  runId?: string;
  /** The provider's own UI link, shown to admins; never fetched by us. */
  url?: string;
}

export function buildStatusRequest(provider: CloudWorkerProviderId, h: CloudHandle): CloudRequest {
  assertReady(provider);
  if (provider === "cursor") {
    if (!h.runId) throw new CloudWorkerNotReadyError("cursor handle has no run id");
    return { method: "GET", path: `/v1/agents/${safeExternalId(h.externalId)}/runs/${safeExternalId(h.runId)}` };
  }
  return { method: "GET", path: `/v1/sessions/${safeExternalId(h.externalId)}` };
}

/** `null` when the provider has no verified cancel endpoint (Devin): the
 * gateway then relies on the spend limit and stops polling. */
export function buildCancelRequest(provider: CloudWorkerProviderId, h: CloudHandle): CloudRequest | null {
  assertReady(provider);
  if (provider === "cursor" && h.runId) {
    return {
      method: "POST",
      path: `/v1/agents/${safeExternalId(h.externalId)}/runs/${safeExternalId(h.runId)}/cancel`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reply parsers
// ---------------------------------------------------------------------------

export type CloudWorkerState = "running" | "needs_input" | "succeeded" | "failed" | "cancelled";

export interface CloudStatus {
  state: CloudWorkerState;
  prUrl?: string;
  /** Reason code when failed; never the provider's free text. */
  reason?: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

const idString = z.string().regex(EXTERNAL_ID_RE);
const httpsUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      return new URL(s).protocol === "https:";
    } catch {
      return false;
    }
  });

// Cursor create reply. The agent `id` is verified (`bc-<uuid>`); where the
// initial run id sits in the reply is UNVERIFIED, so both observed spellings are
// accepted and a reply with neither fails closed.
const cursorLaunchReply = z.object({
  id: idString,
  url: httpsUrl.optional(),
  runId: idString.optional(),
  run: z.object({ id: idString }).optional(),
  latestRunId: idString.optional(),
});

const devinLaunchReply = z.object({ session_id: idString, url: httpsUrl.optional() });

export function parseLaunchReply(provider: CloudWorkerProviderId, json: unknown): ParseResult<CloudHandle> {
  if (provider === "cursor") {
    const r = cursorLaunchReply.safeParse(json);
    if (!r.success) return { ok: false, reason: "launch_reply_invalid" };
    const runId = r.data.run?.id ?? r.data.runId ?? r.data.latestRunId;
    if (!runId) return { ok: false, reason: "launch_reply_no_run" };
    return { ok: true, value: { externalId: r.data.id, runId, ...(r.data.url ? { url: r.data.url } : {}) } };
  }
  if (provider === "devin") {
    const r = devinLaunchReply.safeParse(json);
    if (!r.success) return { ok: false, reason: "launch_reply_invalid" };
    return { ok: true, value: { externalId: r.data.session_id, ...(r.data.url ? { url: r.data.url } : {}) } };
  }
  return { ok: false, reason: "provider_not_ready" };
}

const CURSOR_RUNNING = new Set(["CREATING", "RUNNING", "WAITING_FOR_BACKGROUND_WORK"]);
const cursorStatusReply = z.object({
  status: z.string().max(64),
  git: z
    .object({
      branches: z.array(z.object({ name: z.string().max(255).optional(), prUrl: httpsUrl.optional() })).max(50).optional(),
    })
    .optional(),
});

const DEVIN_RUNNING = new Set(["working", "resumed", "resume_requested", "resume_requested_frontend"]);
const DEVIN_CANCELLED = new Set(["suspend_requested", "suspend_requested_frontend"]);
const devinStatusReply = z.object({
  status_enum: z.string().max(64).nullable().optional(),
  pull_request: z.object({ url: httpsUrl }).nullable().optional(),
});

/** One PR, or none. More than one PR from a single dispatch is a scope escape. */
function onePr(urls: string[]): CloudStatus {
  const uniq = [...new Set(urls)];
  if (uniq.length === 0) return { state: "failed", reason: "no_pull_request" };
  const [only] = uniq;
  if (uniq.length > 1 || only === undefined) return { state: "failed", reason: "multiple_pull_requests" };
  return { state: "succeeded", prUrl: only };
}

export function parseStatusReply(provider: CloudWorkerProviderId, json: unknown): CloudStatus {
  if (provider === "cursor") {
    const r = cursorStatusReply.safeParse(json);
    if (!r.success) return { state: "failed", reason: "status_reply_invalid" };
    const s = r.data.status;
    if (CURSOR_RUNNING.has(s)) return { state: "running" };
    if (s === "CANCELLED") return { state: "cancelled" };
    if (s === "ERROR" || s === "EXPIRED") return { state: "failed", reason: `provider_${s.toLowerCase()}` };
    if (s === "FINISHED") {
      const urls = (r.data.git?.branches ?? []).flatMap((b) => (b.prUrl ? [b.prUrl] : []));
      return onePr(urls);
    }
    return { state: "failed", reason: "status_unknown" };
  }
  if (provider === "devin") {
    const r = devinStatusReply.safeParse(json);
    if (!r.success) return { state: "failed", reason: "status_reply_invalid" };
    const s = r.data.status_enum ?? "";
    if (DEVIN_RUNNING.has(s)) return { state: "running" };
    if (s === "blocked") return { state: "needs_input" };
    if (DEVIN_CANCELLED.has(s)) return { state: "cancelled" };
    if (s === "expired") return { state: "failed", reason: "provider_expired" };
    if (s === "finished") return onePr(r.data.pull_request?.url ? [r.data.pull_request.url] : []);
    return { state: "failed", reason: "status_unknown" };
  }
  return { state: "failed", reason: "provider_not_ready" };
}

// ---------------------------------------------------------------------------
// The dispatch envelope (ADR-0320 §2). Order matters: the first failing check
// is the reason recorded, and nothing after it is evaluated.
// ---------------------------------------------------------------------------

export type ExecutionMode = "normal" | "read_only" | "require_approval" | "halted";

export interface CloudDispatchInput {
  provider: CloudWorkerProviderId;
  orgEnabled: boolean;
  /** The tenant's provider row; null = never configured (default deny). */
  providerRow: { enabled: boolean; halted: boolean } | null;
  executionMode: ExecutionMode;
  /** The instance passed its planning stage and the human sign-off before the build stage. */
  planSignedOff: boolean;
  /** The dispatch belongs to a workflow instance's build stage. */
  inWorkflowInstance: boolean;
  /** The person holds a grant on this provider. */
  personHasGrant: boolean;
  /** The node's lead ceiling on cloud providers; null = no ceiling above the node. */
  ceilingProviders: readonly string[] | null;
  /** The person may change this repository through the workflow's git connection. */
  repoEntitled: boolean;
  budget: {
    capUsd: number;
    /** computeNodeBudgetCeiling for the node; null = none. */
    nodeCeilingUsd: number | null;
    /** The run's remaining budget; null = no run cap. */
    runRemainingUsd: number | null;
  };
}

export type CloudDispatchDenyReason =
  | "org_disabled"
  | "provider_not_ready"
  | "provider_not_configured"
  | "provider_disabled"
  | "provider_halted"
  | "execution_halted"
  | "execution_read_only"
  | "not_in_workflow"
  | "plan_not_signed_off"
  | "no_grant"
  | "outside_ceiling"
  | "repo_not_entitled"
  | "budget_invalid"
  | "over_node_budget"
  | "over_run_budget";

export type CloudDispatchDecision =
  | { kind: "allow" }
  | { kind: "queue"; reason: "execution_require_approval" }
  | { kind: "deny"; reason: CloudDispatchDenyReason };

export function decideCloudDispatch(i: CloudDispatchInput): CloudDispatchDecision {
  const deny = (reason: CloudDispatchDenyReason): CloudDispatchDecision => ({ kind: "deny", reason });
  if (!i.orgEnabled) return deny("org_disabled");
  if (CLOUD_WORKER_READINESS[i.provider] !== "fake_verified") return deny("provider_not_ready");
  if (!i.providerRow) return deny("provider_not_configured");
  if (i.providerRow.halted) return deny("provider_halted");
  if (!i.providerRow.enabled) return deny("provider_disabled");
  if (i.executionMode === "halted") return deny("execution_halted");
  if (i.executionMode === "read_only") return deny("execution_read_only");
  if (!i.inWorkflowInstance) return deny("not_in_workflow");
  if (!i.planSignedOff) return deny("plan_not_signed_off");
  if (!i.personHasGrant) return deny("no_grant");
  if (i.ceilingProviders !== null && !i.ceilingProviders.includes(i.provider)) return deny("outside_ceiling");
  if (!i.repoEntitled) return deny("repo_not_entitled");
  const { capUsd, nodeCeilingUsd, runRemainingUsd } = i.budget;
  if (!Number.isFinite(capUsd) || capUsd <= 0) return deny("budget_invalid");
  if (nodeCeilingUsd !== null && capUsd > nodeCeilingUsd) return deny("over_node_budget");
  if (runRemainingUsd !== null && capUsd > runRemainingUsd) return deny("over_run_budget");
  if (i.executionMode === "require_approval") return { kind: "queue", reason: "execution_require_approval" };
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// The scope check on the captured PR (ADR-0320 §3). The PR facts come from the
// git provider through the workflow's own connection, not from the agent.
// ---------------------------------------------------------------------------

export interface PrRef {
  host: string;
  owner: string;
  name: string;
  number: number;
}

const PR_PATH_RE = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/([0-9]{1,10})$/;

/** Parse a provider-reported PR URL. Only `https://<host>/<owner>/<repo>/pull/<n>`. */
export function parsePrUrl(url: string): PrRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
  const m = PR_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { host: u.hostname.toLowerCase(), owner: m[1]!, name: m[2]!, number };
}

export interface CapturedPrFacts {
  host: string;
  owner: string;
  name: string;
  baseBranch: string;
  headBranch: string;
  /** The head branch lives in the same repository (not a fork). */
  headInSameRepo: boolean;
  merged: boolean;
  state: "open" | "closed";
}

export type ScopeCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "wrong_repository"
        | "wrong_base_branch"
        | "head_branch_outside_prefix"
        | "head_from_fork"
        | "already_merged"
        | "not_open";
    };

const eqCi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function checkCapturedPr(task: CloudWorkerTask, pr: CapturedPrFacts): ScopeCheck {
  if (!eqCi(pr.host, task.repo.host) || !eqCi(pr.owner, task.repo.owner) || !eqCi(pr.name, task.repo.name)) {
    return { ok: false, reason: "wrong_repository" };
  }
  if (pr.merged) return { ok: false, reason: "already_merged" };
  if (pr.state !== "open") return { ok: false, reason: "not_open" };
  if (pr.baseBranch !== task.baseBranch) return { ok: false, reason: "wrong_base_branch" };
  if (!pr.headInSameRepo) return { ok: false, reason: "head_from_fork" };
  const prefixes = [task.branchPrefix, ...PROVIDER_HEAD_PREFIXES[task.provider]];
  if (!isSafeRefName(pr.headBranch) || !prefixes.some((p) => pr.headBranch.startsWith(p))) {
    return { ok: false, reason: "head_branch_outside_prefix" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Budget and cost (ADR-0320 §2.5, §4)
// ---------------------------------------------------------------------------

export interface ProviderPrices {
  /** Devin: USD per ACU, set by the admin. */
  usdPerAcu?: number;
  /** Cursor: USD per million tokens, set by the admin. */
  usdPerMillionTokens?: number;
}

/** The provider's own spend limit for a reservation, where it has one.
 * `null` limit = the provider has no limit field (the reservation still caps
 * what we charge). `insufficient` = the reservation buys less than one unit. */
export function providerSpendLimit(
  provider: CloudWorkerProviderId,
  reservedUsd: number,
  prices: ProviderPrices,
): { kind: "limit"; maxAcuLimit: number } | { kind: "none" } | { kind: "insufficient" } | { kind: "no_price" } {
  if (provider !== "devin") return { kind: "none" };
  const p = prices.usdPerAcu;
  if (p === undefined || !Number.isFinite(p) || p <= 0) return { kind: "no_price" };
  const units = Math.floor(reservedUsd / p);
  if (units < 1) return { kind: "insufficient" };
  return { kind: "limit", maxAcuLimit: units };
}

export interface ReportedUsage {
  acus?: number;
  tokens?: number;
}

/** What we charge for a finished dispatch. Measured usage priced by the admin's
 * table, capped at the reservation; with no usable measurement, the full
 * reservation (secure default: a release only ever goes down, never up). */
export function settleCost(
  provider: CloudWorkerProviderId,
  reservedUsd: number,
  usage: ReportedUsage | null,
  prices: ProviderPrices,
): { costUsd: number; measured: boolean } {
  let measured: number | null = null;
  if (usage) {
    if (provider === "devin" && usage.acus !== undefined && prices.usdPerAcu !== undefined) {
      measured = usage.acus * prices.usdPerAcu;
    } else if (provider === "cursor" && usage.tokens !== undefined && prices.usdPerMillionTokens !== undefined) {
      measured = (usage.tokens / 1_000_000) * prices.usdPerMillionTokens;
    }
  }
  if (measured === null || !Number.isFinite(measured) || measured < 0) return { costUsd: reservedUsd, measured: false };
  return { costUsd: Math.min(reservedUsd, measured), measured: true };
}
