/**
 * ADR-0320 (lane E5, slice 2) — THIRD-PARTY CLOUD CODING AGENTS AS GOVERNED PILLAR-7 WORKERS.
 *
 * `executeGovernedCloudWorkerDispatch` is the ONLY function that launches work on a cloud coding agent (Cursor cloud
 * agents, Devin; GitHub Copilot and OpenAI Codex are refused until their contracts are verified). It is shaped after
 * `executeGovernedA2aCall` (a2a.ts). The kernel (`@regulait/orchestration-kernel` cloud-worker.ts) is pure: it decides
 * the envelope, builds every request and parses every reply. This file loads state, sends through the guarded fetch
 * and writes rows.
 *
 * ONE DISPATCH, IN ORDER (each refusal writes ONE deny audit row and never contacts the provider):
 *  1. the org setting `cloudWorkersEnabled` (default false, ADR-0180);
 *  2. the task itself (`cloudWorkerTaskSchema`: pinned repository, base branch, branch prefix, prompt, budget cap);
 *  3. the kernel's `decideCloudDispatch`: the provider is ready, configured, not halted and enabled; the execution dial
 *     (ADR-0124: halted and read_only refuse, require_approval would queue, and there is no queue yet, so it refuses);
 *     the dispatch belongs to the person's own workflow instance, which is resting at its build stage after a
 *     completed planning stage and a completed human sign-off; the person's grant (default deny); the node's lead
 *     ceiling (only narrows); the repository is the one the workflow's own git connection targets; the budget cap fits
 *     the node and run ceilings;
 *  4. the project (the instance's attribution): `assertProjectAttribution`, then `preDispatchProjectGate`;
 *  5. PII on the prompt (`enforcePII`; redact refuses, there is no redaction path) and the ADR-0042 guardrails;
 *  6. egress: `checkMcpServerUrl` on the provider's registered base URL, and plain http only with the private-range
 *     opt-in; every request then goes through `createGuardedFetch` (re-validated, pinned, redirect-refused);
 *  7. the provider's own spend limit from the reservation (`providerSpendLimit`; Devin's `max_acu_limit`);
 *  8. the credential, opened last and sent as `Authorization: Bearer` on the registered origin only.
 * Then the launch, and in ONE transaction: the dispatch row (state running), ONE `usage_events` row
 * (`object_type` 'cloud_worker', the reserved cap as the cost per ADR-0320 §4) and the allow audit row.
 *
 * NEVER RECORDED: the credential and the prompt text. Audit rows carry the prompt's length and the PII and guardrail
 * COUNTS only.
 *
 * NOT IN THIS SLICE (follow-ups, ADR-0320 §7 slice 3): the governed core (`governedEvaluateResource`) has no
 * `cloud_worker` resource type, and adding one edits the shared core owned by lane L1, so its rate limits and approval
 * rules do not apply yet; the run-budget reservation (`chargeRunBudget`), PR capture with `checkCapturedPr`, and cost
 * settlement are wired when `planRun` dispatches the node.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  cloudWorkerCredentials,
  cloudWorkerDispatches,
  cloudWorkerGrants,
  cloudWorkerProviders,
  desc,
  eq,
  gitConnections,
  inArray,
  isNotNull,
  lt,
  sql,
  usageEvents,
  users,
  workflowInstances,
  type CloudWorkerCredentialRow,
  type CloudWorkerDispatchRow,
  type CloudWorkerProviderRow,
  type Db,
} from "@regulait/db";
import { guardrailCategoryList, mcpUpstreamSecretProblem } from "@regulait/shared";
import {
  buildCancelRequest,
  buildLaunchRequest,
  buildStatusRequest,
  CLOUD_WORKER_PROVIDERS,
  CLOUD_WORKER_READINESS,
  cloudWorkerTaskSchema,
  decideCloudDispatch,
  parseLaunchReply,
  parseStatusReply,
  providerSpendLimit,
  type CloudHandle,
  type CloudRequest,
  type CloudWorkerProviderId,
  type CloudWorkerState,
  type CloudWorkerTask,
} from "@regulait/orchestration-kernel";
import { createGuardedFetch, EGRESS_REDIRECT_REASON, egressRedirectRefused, egressRefusal, egressResponseTooLarge } from "./egress-guard.js";
import { checkMcpServerUrl, loadMcpEgressPosture } from "./mcp-egress.js";
import { loadOrgSettings, piiInternationalCategories } from "./org-settings.js";
import { assertProjectAttribution, enforcePII, piiCategoryList, preDispatchProjectGate, projectPiiMode } from "./projects.js";
import { flattenFindings, resolveGuardrailPolicy, runGuardrailsAsync } from "./guardrails.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp } from "./step-up.js";
import { timeouts } from "./timeouts.js";
import { loadExecutionDial } from "./execution-posture.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** the most bytes a provider reply may carry (counted while it streams, after decoding) */
export const CLOUD_WORKER_RESPONSE_MAX_BYTES = 1024 * 1024;
/** dispatch states the gateway still polls and a halt cancels */
export const LIVE_DISPATCH_STATES = ["launching", "running", "needs_input"] as const;
/** written into the admin listing (ADR-0320 Consequences): the provider's own repository access is wider than ours */
export const CLOUD_WORKER_SCOPE_NOTE =
  "The provider's own repository access is wider than the person's. Give each provider's GitHub app access to the pinned repositories only; RegulAIt checks the result after the fact.";

export const CLOUD_WORKER_RULE_IDS = Object.freeze({
  disabled: "cloud-worker-disabled",
  invalidTask: "cloud-worker-invalid-task",
  /** the kernel's deny reasons map onto `cloud-worker-<reason with hyphens>` */
  decisionPrefix: "cloud-worker-",
  approvalRequired: "cloud-worker-approval-required",
  egress: "cloud-worker-egress-blocked",
  spendLimit: "cloud-worker-spend-limit",
  credentialUnavailable: "cloud-worker-credential-unavailable",
  upstreamError: "cloud-worker-upstream-error",
  dispatched: "cloud-worker-dispatch",
  stateChanged: "cloud-worker-state-changed",
  providerSaved: "cloud-worker-provider-saved",
  providerRefused: "cloud-worker-provider-refused",
  credentialSet: "cloud-worker-credential-set",
  credentialRotated: "cloud-worker-credential-rotated",
  credentialRefused: "cloud-worker-credential-refused",
  granted: "cloud-worker-grant-added",
  grantRemoved: "cloud-worker-grant-removed",
  halted: "cloud-worker-provider-halted",
  unhalted: "cloud-worker-provider-unhalted",
  cancelled: "cloud-worker-dispatch-cancelled",
  // the same rule ids the MCP, model and A2A paths use, so one query finds every refusal of its kind
  projectAttribution: "project-attribution",
  projectBudget: "project-budget-cap",
  piiBlocked: "pii-blocked",
  piiUnsupported: "cloud-worker-pii-unsupported",
  guardrailBlocked: "guardrail-blocked",
});

/** the rule id of a kernel deny reason: `provider_halted` -> `cloud-worker-provider-halted` */
export const cloudWorkerDecisionRuleId = (reason: string): string => `${CLOUD_WORKER_RULE_IDS.decisionPrefix}${reason.replace(/_/g, "-")}`;

// ---------------------------------------------------------------------------
// Data key (set once by registerCloudWorkerRoutes, like a2a.ts)
// ---------------------------------------------------------------------------

let cloudWorkerDataKey: string | undefined;
export function configureCloudWorkerDataKey(dataKey: string | undefined): void {
  cloudWorkerDataKey = dataKey;
}

export interface CloudWorkerDeps {
  /** tests only: replaces the pinned transport under the guarded fetch (see `GuardedFetchOptions.fetchImpl`) */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// The workflow instance: is it at a signed-off build stage, and which repository may it change?
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["completed", "aborted", "denied", "rolled_back"]);
const storedStage = z.object({ id: z.string(), type: z.string(), connection: z.string().optional(), repo: z.string().optional(), action: z.string().optional(), base: z.string().optional() }).passthrough();
const storedDefinition = z.object({ stages: z.array(storedStage).min(1).max(500) }).passthrough();
const storedState = z.object({ status: z.string(), currentStageIndex: z.number().int().min(0), stageStatuses: z.array(z.string()) }).passthrough();
type StoredStage = z.infer<typeof storedStage>;

/**
 * PURE. The instance rests at an active `automated_build` stage, every stage before it is completed, and among them a
 * `planning` stage is followed by a completed `human_approval` (the sign-off on the plan). An unreadable definition or
 * state is "not signed off" (fail closed). `stageId`, when given, must name the current stage.
 */
export function instanceAtSignedOffBuild(definition: unknown, state: unknown, stageId?: string | null): boolean {
  const d = storedDefinition.safeParse(definition);
  const s = storedState.safeParse(state);
  if (!d.success || !s.success) return false;
  const { stages } = d.data;
  const { status, currentStageIndex: idx, stageStatuses } = s.data;
  if (TERMINAL_STATUSES.has(status)) return false;
  const current = stages[idx];
  if (!current || current.type !== "automated_build" || stageStatuses[idx] !== "active") return false;
  if (stageId && current.id !== stageId) return false;
  for (let i = 0; i < idx; i += 1) if (stageStatuses[i] !== "completed") return false;
  const planIdx = stages.slice(0, idx).findIndex((st) => st.type === "planning");
  if (planIdx === -1) return false;
  return stages.slice(planIdx + 1, idx).some((st) => st.type === "human_approval");
}

/** the host a git connection's repositories live on (null = a provider with no public host, e.g. mock) */
function gitHostOf(conn: { provider: string; baseUrl: string | null }): string[] {
  if (conn.baseUrl) {
    try {
      const h = new URL(conn.baseUrl).hostname.toLowerCase();
      return h.startsWith("api.") ? [h, h.slice(4)] : [h];
    } catch {
      return [];
    }
  }
  const defaults: Record<string, string> = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org", azure_devops: "dev.azure.com" };
  return defaults[conn.provider] ? [defaults[conn.provider]!] : [];
}

/** the git_operation stages of the instance that target `task`'s repository and base branch, by name only */
function gitStagesFor(stages: readonly StoredStage[], task: CloudWorkerTask): StoredStage[] {
  const want = `${task.repo.owner}/${task.repo.name}`.toLowerCase();
  return stages.filter((st) => st.type === "git_operation" && typeof st.connection === "string" && typeof st.repo === "string" && st.repo.toLowerCase() === want && (st.base ?? "main") === task.baseBranch);
}

// ---------------------------------------------------------------------------
// Egress and the credential
// ---------------------------------------------------------------------------

const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/** Why `raw` cannot be a provider base URL, or null. An origin only (no path, query, fragment or user info), so the
 * kernel's paths are the only thing appended and the credential's origin is unambiguous. Plain http needs the
 * private-range opt-in (a self-hosted test double or a BYOC endpoint), never a public host. */
export function providerBaseUrlProblem(raw: string, allowPrivateRanges: boolean | null): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "the base URL is not a URL";
  }
  if (raw.length > 2048) return "the base URL is longer than 2048 characters";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "the base URL must be https";
  if (u.protocol === "http:" && allowPrivateRanges !== true) return "plain http is allowed only for a private-range endpoint the admin opted in";
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return "the base URL must be an origin only (no path, query, fragment or user info)";
  return null;
}

type Sent = { status: number; json: unknown };

/** the guarded fetch for one provider, on the CURRENT posture; the credential goes to the registered origin only */
async function providerSender(db: Db, row: CloudWorkerProviderRow, secret: string | null, deps: CloudWorkerDeps): Promise<(r: CloudRequest) => Promise<Sent>> {
  const posture = await loadMcpEgressPosture(db, row.allowPrivateRanges);
  const guarded = createGuardedFetch({
    allowList: posture.allowList,
    privateLan: { openByDefault: posture.openByDefault },
    maxResponseBytes: CLOUD_WORKER_RESPONSE_MAX_BYTES,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const registered = originOf(row.baseUrl);
  return async (r: CloudRequest) => {
    if (!registered || !r.path.startsWith("/")) throw new Error("cloud worker request outside the registered origin");
    const url = new URL(r.path, registered);
    if (url.origin !== registered) throw new Error("cloud worker request outside the registered origin");
    const headers: Record<string, string> = { accept: "application/json" };
    if (r.body !== undefined) headers["content-type"] = "application/json";
    if (secret !== null) headers.authorization = `Bearer ${secret}`;
    const res = await guarded(url.toString(), {
      method: r.method,
      headers,
      ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      signal: AbortSignal.timeout(timeouts().outboundDefaultMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };
}

type OpenedSecret = { ok: true; secret: string } | { ok: false; reason: "no_credential" | "data_key_unavailable" | "undecryptable" };

async function openSecret(db: Db, providerId: string): Promise<OpenedSecret> {
  const [row] = await db.select().from(cloudWorkerCredentials).where(eq(cloudWorkerCredentials.providerId, providerId));
  if (!row) return { ok: false, reason: "no_credential" };
  if (!cloudWorkerDataKey) return { ok: false, reason: "data_key_unavailable" };
  try {
    return { ok: true, secret: decryptSecret(cloudWorkerDataKey, row.secretCiphertext) };
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
}

/** an upstream failure as a fixed sentence: the provider's own text is never repeated */
function upstreamReason(err: unknown): { outcome: string; reason: string } {
  if (egressRedirectRefused(err)) return { outcome: "redirect_refused", reason: EGRESS_REDIRECT_REASON };
  if (egressResponseTooLarge(err)) return { outcome: "response_too_large", reason: `the provider's response was larger than ${CLOUD_WORKER_RESPONSE_MAX_BYTES} bytes, so it was refused` };
  const blocked = egressRefusal(err);
  if (blocked) return { outcome: "egress_blocked", reason: blocked };
  return { outcome: "upstream_error", reason: "the provider did not return a usable reply" };
}

export function cloudWorkerCredentialView(row: CloudWorkerCredentialRow | undefined | null) {
  if (!row) return { set: false, last4: null, setBy: null, setAt: null };
  return { set: true, last4: row.secretLast4, setBy: row.setBy, setAt: row.secretSetAt.toISOString() };
}

export function cloudWorkerProviderView(row: CloudWorkerProviderRow, credential: CloudWorkerCredentialRow | undefined | null) {
  return {
    id: row.id,
    provider: row.provider,
    readiness: CLOUD_WORKER_READINESS[row.provider as CloudWorkerProviderId],
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    halted: row.haltedAt !== null,
    haltedAt: row.haltedAt?.toISOString() ?? null,
    haltedReason: row.haltedReason,
    allowPrivateRanges: row.allowPrivateRanges,
    usdPerAcu: row.usdPerAcu,
    usdPerMillionTokens: row.usdPerMillionTokens,
    maxPollMinutes: row.maxPollMinutes,
    credential: cloudWorkerCredentialView(credential),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function cloudWorkerDispatchView(row: CloudWorkerDispatchRow, provider: string) {
  return {
    id: row.id,
    provider,
    userId: row.userId,
    projectId: row.projectId,
    workflowInstanceId: row.workflowInstanceId,
    runId: row.runId,
    nodeId: row.nodeId,
    repo: { host: row.repoHost, owner: row.repoOwner, name: row.repoName },
    baseBranch: row.baseBranch,
    branchPrefix: row.branchPrefix,
    externalId: row.externalId,
    state: row.state,
    reason: row.reason,
    reservedUsd: row.reservedUsd,
    costUsd: row.costUsd,
    prUrl: row.prUrl,
    pollDeadlineAt: row.pollDeadlineAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// THE GOVERNED DISPATCH
// ---------------------------------------------------------------------------

export interface GovernedCloudWorkerDispatchArgs {
  /** the person the dispatch runs as: the workflow instance's initiator */
  userId: string;
  provider: string;
  workflowInstanceId: string;
  /** the build stage's id; when given it must be the instance's current stage */
  stageId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  repo: { host?: string; owner: string; name: string };
  baseBranch: string;
  /** default `regulait/<runId or instance id>/` */
  branchPrefix?: string;
  prompt: string;
  budgetCapUsd: number;
  /** default: a fresh uuid (the idempotency key sent to the provider) */
  dispatchId?: string;
  /** the node's lead ceiling on cloud providers; null/undefined = no ceiling above the node */
  ceilingProviders?: readonly string[] | null;
  /** `computeNodeBudgetCeiling` for the node and the run's remaining budget; null/undefined = none */
  budget?: { nodeCeilingUsd?: number | null; runRemainingUsd?: number | null };
  callerIsAdmin?: boolean;
}

export type GovernedCloudWorkerDispatchOutcome =
  | { kind: "dispatched"; dispatchId: string; externalId: string; usageEventId: string; auditId: string; reservedUsd: number }
  | { kind: "denied"; status: number; error: string; ruleId: string; reason: string; auditId: string }
  | { kind: "upstream_error"; status: 502; error: "cloud_worker_upstream_error"; reason: string; auditId: string };

export async function executeGovernedCloudWorkerDispatch(db: Db, args: GovernedCloudWorkerDispatchArgs, deps: CloudWorkerDeps = {}): Promise<GovernedCloudWorkerDispatchOutcome> {
  const base = { phase: "dispatch", provider: String(args.provider).slice(0, 32), workflowInstanceId: args.workflowInstanceId, runId: args.runId ?? null, nodeId: args.nodeId ?? null, promptChars: typeof args.prompt === "string" ? args.prompt.length : 0 };
  let objectId: string | null = null;
  const deny = async (status: number, error: string, ruleId: string, reason: string, extra: Record<string, unknown> = {}): Promise<GovernedCloudWorkerDispatchOutcome> => {
    const [row] = await db
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "cloud_worker", objectId, toolName: base.provider, detail: { ...base, ...extra, receiptClass: "decision" }, effect: "deny", ruleId, ruleChain: [ruleId], reason: `Cloud worker dispatch refused: ${reason}; nothing was sent` })
      .returning({ id: auditLog.id });
    return { kind: "denied", status, error, ruleId, reason, auditId: row!.id };
  };

  // 1. the org setting, before anything else is loaded
  const org = await loadOrgSettings(db);
  if (!org.cloudWorkersEnabled) return deny(403, "cloud_workers_disabled", CLOUD_WORKER_RULE_IDS.disabled, "cloud coding agents are turned off for this organisation");

  // 2. the task. The run-scoped prefix ends in `/` so `regulait/run1/` never matches `regulait/run10/`.
  const parsedTask = cloudWorkerTaskSchema.safeParse({
    provider: args.provider,
    repo: { host: args.repo?.host ?? "github.com", owner: args.repo?.owner, name: args.repo?.name },
    baseBranch: args.baseBranch,
    branchPrefix: args.branchPrefix ?? `regulait/${args.runId ?? args.workflowInstanceId}/`,
    prompt: args.prompt,
    budgetCapUsd: args.budgetCapUsd,
    dispatchId: args.dispatchId ?? randomUUID(),
  });
  if (!parsedTask.success) {
    // the issue list could echo the prompt back: the field paths only
    return deny(400, "invalid_task", CLOUD_WORKER_RULE_IDS.invalidTask, "the task is not a valid cloud worker task", { fields: [...new Set(parsedTask.error.issues.map((i) => String(i.path[0] ?? "")))].slice(0, 10) });
  }
  const task = parsedTask.data;
  const repoDetail = { repo: `${task.repo.host}/${task.repo.owner}/${task.repo.name}`, baseBranch: task.baseBranch, branchPrefix: task.branchPrefix, budgetCapUsd: task.budgetCapUsd, dispatchId: task.dispatchId };

  // 3. the envelope, decided by the kernel on state loaded here
  const [[provider], [instance], dial] = await Promise.all([
    db.select().from(cloudWorkerProviders).where(eq(cloudWorkerProviders.provider, task.provider)),
    db.select().from(workflowInstances).where(eq(workflowInstances.id, args.workflowInstanceId)),
    loadExecutionDial(db, org),
  ]);
  objectId = provider?.id ?? null;
  const [grant] = provider
    ? await db.select({ id: cloudWorkerGrants.id }).from(cloudWorkerGrants).where(and(eq(cloudWorkerGrants.providerId, provider.id), eq(cloudWorkerGrants.userId, args.userId)))
    : [];
  const inWorkflowInstance = Boolean(instance) && instance!.initiatorUserId === args.userId;
  const definition = storedDefinition.safeParse(instance?.definition);
  let repoEntitled = false;
  if (inWorkflowInstance && definition.success) {
    const names = [...new Set(gitStagesFor(definition.data.stages, task).map((st) => st.connection!))];
    if (names.length) {
      const conns = await db.select({ provider: gitConnections.provider, baseUrl: gitConnections.baseUrl }).from(gitConnections).where(inArray(gitConnections.name, names));
      repoEntitled = conns.some((c) => gitHostOf(c).includes(task.repo.host.toLowerCase()));
    }
  }
  const decision = decideCloudDispatch({
    provider: task.provider,
    orgEnabled: true,
    providerRow: provider ? { enabled: provider.enabled, halted: provider.haltedAt !== null } : null,
    executionMode: dial.mode,
    planSignedOff: inWorkflowInstance && instanceAtSignedOffBuild(instance!.definition, instance!.state, args.stageId ?? null),
    inWorkflowInstance,
    personHasGrant: Boolean(grant),
    ceilingProviders: args.ceilingProviders ?? null,
    repoEntitled,
    budget: { capUsd: task.budgetCapUsd, nodeCeilingUsd: args.budget?.nodeCeilingUsd ?? null, runRemainingUsd: args.budget?.runRemainingUsd ?? null },
  });
  if (decision.kind === "deny") {
    const status = decision.reason === "provider_not_configured" ? 404 : decision.reason.startsWith("over_") || decision.reason === "budget_invalid" ? 409 : 403;
    return deny(status, decision.reason, cloudWorkerDecisionRuleId(decision.reason), decision.reason.replace(/_/g, " "), repoDetail);
  }
  if (decision.kind === "queue") {
    // no approval queue for a cloud dispatch yet, so the dial's require_approval refuses (fail closed)
    return deny(403, "approval_required", CLOUD_WORKER_RULE_IDS.approvalRequired, "the execution dial requires an approval for every write, and a cloud dispatch has no approval queue yet", repoDetail);
  }
  const prov = provider!;
  const inst = instance!;
  const projectId = inst.projectId ?? null;

  // 4. the project: attribution, then the pillar-5 budget gate
  if (projectId !== null) {
    const attribution = await assertProjectAttribution(db, projectId, args.userId, args.callerIsAdmin === true);
    if (!attribution.ok) return deny(attribution.status, attribution.error, CLOUD_WORKER_RULE_IDS.projectAttribution, attribution.error === "invalid_reference" ? "no such project" : "the person is not a member of the instance's project", { ...repoDetail, projectId });
  }
  const budget = await preDispatchProjectGate(db, projectId, args.userId);
  if (!budget.ok) return deny(budget.status, budget.error, CLOUD_WORKER_RULE_IDS.projectBudget, `${budget.error}: the project budget is exhausted`, { ...repoDetail, projectId });

  // 5. PII and the guardrails, on the person's prompt (the pinned preamble is ours)
  const piiMode = await projectPiiMode(db, projectId);
  let piiDetail: Record<string, unknown> | null = null;
  if (piiMode === "redact") return deny(403, "pii_unsupported", CLOUD_WORKER_RULE_IDS.piiUnsupported, "the project's PII mode is redact, which a cloud dispatch cannot apply yet", { ...repoDetail, pii: { mode: piiMode } });
  if (piiMode) {
    const chk = enforcePII(piiMode, { input: task.prompt }, await piiInternationalCategories(db));
    piiDetail = { mode: piiMode, action: chk.action, inputHits: chk.hits };
    if (chk.action === "block") return deny(403, "pii_blocked", CLOUD_WORKER_RULE_IDS.piiBlocked, `the prompt contains PII (${piiCategoryList(chk.hits)})`, { ...repoDetail, pii: piiDetail });
  }
  const guardrailPolicy = await resolveGuardrailPolicy(db, { projectId, userId: args.userId });
  let guardrailDetail: Record<string, unknown> | null = null;
  if (guardrailPolicy.active) {
    const g = await runGuardrailsAsync(guardrailPolicy, "input", task.prompt);
    if (g.findings.length) guardrailDetail = { phase: "input", action: g.action, findings: flattenFindings(g.findings) };
    if (g.action === "block") return deny(403, "guardrail_blocked", CLOUD_WORKER_RULE_IDS.guardrailBlocked, `the prompt was blocked by a guardrail (${guardrailCategoryList(g.blocking)})`, { ...repoDetail, guardrail: { ...guardrailDetail, outcome: "blocked" } });
  }

  // 6. egress on the current posture
  const urlProblem = providerBaseUrlProblem(prov.baseUrl, prov.allowPrivateRanges);
  if (urlProblem) return deny(403, "egress_blocked", CLOUD_WORKER_RULE_IDS.egress, urlProblem, repoDetail);
  const { decision: egress } = await checkMcpServerUrl(db, prov.baseUrl, prov.allowPrivateRanges);
  if (!egress.ok) return deny(403, "egress_blocked", CLOUD_WORKER_RULE_IDS.egress, egress.reason, { ...repoDetail, code: egress.code });

  // 7. the provider's own spend limit from the reservation
  const limit = providerSpendLimit(task.provider, task.budgetCapUsd, { ...(prov.usdPerAcu !== null ? { usdPerAcu: prov.usdPerAcu } : {}), ...(prov.usdPerMillionTokens !== null ? { usdPerMillionTokens: prov.usdPerMillionTokens } : {}) });
  if (limit.kind === "no_price") return deny(409, "spend_limit_unavailable", CLOUD_WORKER_RULE_IDS.spendLimit, "the provider needs a price per unit to set its own spend limit, and none is configured", repoDetail);
  if (limit.kind === "insufficient") return deny(409, "budget_below_one_unit", CLOUD_WORKER_RULE_IDS.spendLimit, "the budget cap buys less than one unit of the provider's spend limit", repoDetail);

  // 8. the credential, last
  const opened = await openSecret(db, prov.id);
  if (!opened.ok) return deny(503, opened.reason, CLOUD_WORKER_RULE_IDS.credentialUnavailable, "the provider's credential could not be opened", repoDetail);

  const allowDetail = { ...base, ...repoDetail, projectId, grantId: grant!.id, origin: originOf(prov.baseUrl), ...(piiDetail ? { pii: piiDetail } : {}), ...(guardrailDetail ? { guardrail: guardrailDetail } : {}), ...(limit.kind === "limit" ? { maxAcuLimit: limit.maxAcuLimit } : {}) };
  let handle: CloudHandle;
  try {
    const send = await providerSender(db, prov, opened.secret, deps);
    const sent = await send(buildLaunchRequest(task, limit.kind === "limit" ? { maxAcuLimit: limit.maxAcuLimit } : {}));
    const parsed = sent.status >= 200 && sent.status < 300 ? parseLaunchReply(task.provider, sent.json) : ({ ok: false, reason: `launch_http_${sent.status >= 500 ? "5xx" : "4xx"}` } as const);
    if (!parsed.ok) throw Object.assign(new Error("launch refused"), { cloudReason: parsed.reason });
    handle = parsed.value;
  } catch (err) {
    const code = (err as { cloudReason?: string }).cloudReason;
    const { outcome, reason } = code ? { outcome: code, reason: "the provider did not accept the launch" } : upstreamReason(err);
    const [row] = await db
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "cloud_worker", objectId: prov.id, toolName: task.provider, detail: { ...allowDetail, outcome, receiptClass: "decision" }, effect: "allow", ruleId: CLOUD_WORKER_RULE_IDS.upstreamError, ruleChain: [CLOUD_WORKER_RULE_IDS.dispatched], reason: `Cloud worker '${task.provider}': the dispatch was allowed, but ${reason}; nothing was charged` })
      .returning({ id: auditLog.id });
    return { kind: "upstream_error", status: 502, error: "cloud_worker_upstream_error", reason, auditId: row!.id };
  }

  // the dispatch, its spend and the decision, together (ADR-0320 §4: the reserved cap is the cost until settled)
  const written = await db.transaction(async (tx) => {
    const [usage] = await tx
      .insert(usageEvents)
      .values({ userId: args.userId, objectType: "cloud_worker", operation: "dispatch", provider: task.provider, costUsd: task.budgetCapUsd, projectId, detail: { cloudWorkerDispatchId: task.dispatchId, cloudWorkerProvider: task.provider, reserved: true } })
      .returning({ id: usageEvents.id });
    await tx.insert(cloudWorkerDispatches).values({
      id: task.dispatchId,
      providerId: prov.id,
      userId: args.userId,
      projectId,
      workflowInstanceId: inst.id,
      runId: args.runId ?? null,
      nodeId: args.nodeId ?? null,
      repoHost: task.repo.host,
      repoOwner: task.repo.owner,
      repoName: task.repo.name,
      baseBranch: task.baseBranch,
      branchPrefix: task.branchPrefix,
      externalId: handle.externalId,
      externalRunId: handle.runId ?? null,
      state: "running",
      reservedUsd: task.budgetCapUsd,
      costUsd: task.budgetCapUsd,
      usageEventId: usage!.id,
      // the database clock (M-075)
      pollDeadlineAt: sql`now() + make_interval(mins => ${prov.maxPollMinutes})`,
    });
    const [audit] = await tx
      .insert(auditLog)
      .values({ userId: args.userId, objectType: "cloud_worker", objectId: prov.id, toolName: task.provider, detail: { ...allowDetail, outcome: "launched", externalId: handle.externalId, usageEventId: usage!.id, costUsd: task.budgetCapUsd, receiptClass: "decision" }, effect: "allow", ruleId: CLOUD_WORKER_RULE_IDS.dispatched, ruleChain: [CLOUD_WORKER_RULE_IDS.dispatched], reason: `Cloud worker '${task.provider}': build dispatched on ${repoDetail.repo} from ${task.baseBranch}; ${task.budgetCapUsd} USD reserved` })
      .returning({ id: auditLog.id });
    return { usageEventId: usage!.id, auditId: audit!.id };
  });
  return { kind: "dispatched", dispatchId: task.dispatchId, externalId: handle.externalId, reservedUsd: task.budgetCapUsd, ...written };
}

// ---------------------------------------------------------------------------
// Polling and the kill switch
// ---------------------------------------------------------------------------

/** a state change, compare-and-set on the state it was read in, with its audit row in the same transaction */
async function moveDispatch(db: Db, d: CloudWorkerDispatchRow, provider: string, actorUserId: string, next: { state: CloudWorkerState; reason?: string | null; prUrl?: string | null }, ruleId: string, sentence: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(cloudWorkerDispatches)
      .set({ state: next.state, reason: next.reason ?? null, ...(next.prUrl ? { prUrl: next.prUrl } : {}), updatedAt: sql`now()` })
      .where(and(eq(cloudWorkerDispatches.id, d.id), eq(cloudWorkerDispatches.state, d.state)))
      .returning({ id: cloudWorkerDispatches.id });
    if (moved.length === 0) return false;
    await tx.insert(auditLog).values({
      userId: actorUserId,
      objectType: "cloud_worker",
      objectId: d.providerId,
      toolName: provider,
      detail: { phase: "state", dispatchId: d.id, from: d.state, to: next.state, reason: next.reason ?? null, ...(next.prUrl ? { prUrl: next.prUrl } : {}), usageEventId: d.usageEventId, ...extra, receiptClass: "decision" },
      effect: "allow",
      ruleId,
      ruleChain: [ruleId],
      reason: `Cloud worker '${provider}' dispatch ${d.id}: ${sentence}`,
    });
    return true;
  });
}

export type PollOutcome =
  | { kind: "unchanged"; state: string }
  | { kind: "changed"; from: string; state: CloudWorkerState; prUrl: string | null; reason: string | null }
  | { kind: "not_found" }
  | { kind: "poll_error"; reason: string };

const isLive = (state: string) => (LIVE_DISPATCH_STATES as readonly string[]).includes(state);

/** One poll of a live dispatch (no vendor webhook is relied on). Audited on a state change only; past its deadline a
 * dispatch is cancelled where the provider can, and failed (`poll_deadline`). */
export async function pollCloudWorkerDispatch(db: Db, dispatchId: string, deps: CloudWorkerDeps = {}): Promise<PollOutcome> {
  const [row] = await db
    .select({ d: cloudWorkerDispatches, p: cloudWorkerProviders, overdue: sql<boolean>`now() > ${cloudWorkerDispatches.pollDeadlineAt}` })
    .from(cloudWorkerDispatches)
    .innerJoin(cloudWorkerProviders, eq(cloudWorkerProviders.id, cloudWorkerDispatches.providerId))
    .where(eq(cloudWorkerDispatches.id, dispatchId));
  if (!row) return { kind: "not_found" };
  const { d, p } = row;
  if (!isLive(d.state) || !d.externalId) return { kind: "unchanged", state: d.state };
  const providerId = p.provider as CloudWorkerProviderId;
  const handle: CloudHandle = { externalId: d.externalId, ...(d.externalRunId ? { runId: d.externalRunId } : {}) };
  const urlProblem = providerBaseUrlProblem(p.baseUrl, p.allowPrivateRanges);
  const { decision } = urlProblem ? { decision: { ok: false as const } } : await checkMcpServerUrl(db, p.baseUrl, p.allowPrivateRanges);
  if (!decision.ok) return { kind: "poll_error", reason: "egress_blocked" };
  const opened = await openSecret(db, p.id);
  if (!opened.ok) return { kind: "poll_error", reason: opened.reason };
  const send = await providerSender(db, p, opened.secret, deps);
  if (row.overdue) {
    const cancel = buildCancelRequest(providerId, handle);
    let cancelSent = false;
    if (cancel) {
      try {
        cancelSent = (await send(cancel)).status < 300;
      } catch {
        cancelSent = false;
      }
    }
    const moved = await moveDispatch(db, d, p.provider, d.userId, { state: "failed", reason: "poll_deadline" }, CLOUD_WORKER_RULE_IDS.stateChanged, "the poll deadline passed, so the dispatch failed", { cancelSent });
    return moved ? { kind: "changed", from: d.state, state: "failed", prUrl: null, reason: "poll_deadline" } : { kind: "unchanged", state: d.state };
  }
  let status: ReturnType<typeof parseStatusReply>;
  try {
    const sent = await send(buildStatusRequest(providerId, handle));
    if (sent.status < 200 || sent.status >= 300) return { kind: "poll_error", reason: `status_http_${sent.status >= 500 ? "5xx" : "4xx"}` };
    status = parseStatusReply(providerId, sent.json);
  } catch (err) {
    return { kind: "poll_error", reason: upstreamReason(err).outcome };
  }
  if (status.state === d.state) return { kind: "unchanged", state: d.state };
  const sentence = status.state === "succeeded" ? "the provider finished and reported one pull request" : status.state === "failed" ? `the provider reported a failure (${status.reason ?? "unknown"})` : `the provider reported ${status.state.replace(/_/g, " ")}`;
  const moved = await moveDispatch(db, d, p.provider, d.userId, { state: status.state, reason: status.reason ?? null, prUrl: status.prUrl ?? null }, CLOUD_WORKER_RULE_IDS.stateChanged, sentence);
  return moved ? { kind: "changed", from: d.state, state: status.state, prUrl: status.prUrl ?? null, reason: status.reason ?? null } : { kind: "unchanged", state: d.state };
}

export type HaltOutcome =
  | { kind: "halted"; providerId: string; cancelled: Array<{ dispatchId: string; cancelSent: boolean; reason: string }>; auditId: string }
  | { kind: "not_found" };

/** The per-provider kill switch: new dispatches are refused at once, and every live dispatch is cancelled where the
 * provider has a verified cancel endpoint (Devin has none: its spend limit bounds it and polling stops). Audited. */
export async function haltCloudWorkerProvider(db: Db, provider: string, reason: string, actorUserId: string, deps: CloudWorkerDeps = {}): Promise<HaltOutcome> {
  const [prov] = await db
    .update(cloudWorkerProviders)
    .set({ haltedAt: sql`now()`, haltedReason: reason, haltedBy: actorUserId === NIL_USER ? null : actorUserId, updatedAt: sql`now()` })
    .where(eq(cloudWorkerProviders.provider, provider as CloudWorkerProviderId))
    .returning();
  if (!prov) return { kind: "not_found" };
  const live = await db
    .select()
    .from(cloudWorkerDispatches)
    .where(and(eq(cloudWorkerDispatches.providerId, prov.id), inArray(cloudWorkerDispatches.state, [...LIVE_DISPATCH_STATES])))
    .orderBy(asc(cloudWorkerDispatches.createdAt))
    .limit(1000);
  const [audit] = await db
    .insert(auditLog)
    .values({ userId: actorUserId, objectType: "cloud_worker", objectId: prov.id, toolName: prov.provider, detail: { phase: "halt", provider: prov.provider, liveDispatches: live.length }, effect: "allow", ruleId: CLOUD_WORKER_RULE_IDS.halted, ruleChain: [], reason: `Cloud worker '${prov.provider}' halted: ${reason}` })
    .returning({ id: auditLog.id });
  const cancelled: Array<{ dispatchId: string; cancelSent: boolean; reason: string }> = [];
  if (live.length) {
    const opened = await openSecret(db, prov.id);
    const urlProblem = providerBaseUrlProblem(prov.baseUrl, prov.allowPrivateRanges);
    const egressOk = !urlProblem && (await checkMcpServerUrl(db, prov.baseUrl, prov.allowPrivateRanges)).decision.ok;
    const send = opened.ok && egressOk ? await providerSender(db, prov, opened.secret, deps) : null;
    for (const d of live) {
      const req = d.externalId ? buildCancelRequest(prov.provider as CloudWorkerProviderId, { externalId: d.externalId, ...(d.externalRunId ? { runId: d.externalRunId } : {}) }) : null;
      let cancelSent = false;
      if (req && send) {
        try {
          cancelSent = (await send(req)).status < 300;
        } catch {
          cancelSent = false;
        }
      }
      const code = !req ? "provider_halted_no_cancel_endpoint" : cancelSent ? "provider_halted" : "provider_halted_cancel_failed";
      await moveDispatch(db, d, prov.provider, actorUserId, { state: "cancelled", reason: code }, CLOUD_WORKER_RULE_IDS.cancelled, `cancelled because the provider was halted${req ? (cancelSent ? "" : " (the provider's cancel did not succeed)") : " (the provider has no cancel endpoint; its spend limit bounds it and polling stops)"}`, { cancelSent });
      cancelled.push({ dispatchId: d.id, cancelSent, reason: code });
    }
  }
  return { kind: "halted", providerId: prov.id, cancelled, auditId: audit!.id };
}

// ---------------------------------------------------------------------------
// Admin routes (API only; the screens are tracked on #453)
// ---------------------------------------------------------------------------

const providerParam = z.object({ provider: z.enum(CLOUD_WORKER_PROVIDERS) });
const grantParam = z.object({ provider: z.enum(CLOUD_WORKER_PROVIDERS), grantId: z.string().uuid() });
const upsertSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048),
    enabled: z.boolean().optional(),
    allowPrivateRanges: z.boolean().nullable().optional(),
    usdPerAcu: z.number().positive().max(1000).nullable().optional(),
    usdPerMillionTokens: z.number().positive().max(10_000).nullable().optional(),
    maxPollMinutes: z.number().int().min(1).max(120).optional(),
  })
  .strict();
const credentialSchema = z.object({ secret: z.string(), rotate: z.boolean().optional() }).strict();
const grantSchema = z.object({ userId: z.string().uuid() }).strict();
const haltSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const dispatchListSchema = z.object({ provider: z.enum(CLOUD_WORKER_PROVIDERS).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() }).strict();

const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_USER;

export function registerCloudWorkerRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; deps?: CloudWorkerDeps } = {}): void {
  configureCloudWorkerDataKey(opts.dataKey);
  const deps = opts.deps ?? {};

  const audit = (tx: Db, req: FastifyRequest, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    tx.insert(auditLog).values({ userId: actor(req), objectType: "cloud_worker", objectId, detail, effect, ruleId, ruleChain: [], reason });
  const loadProvider = async (provider: CloudWorkerProviderId) => (await db.select().from(cloudWorkerProviders).where(eq(cloudWorkerProviders.provider, provider)))[0];
  const stepUp = async (req: FastifyRequest, reply: FastifyReply, op: string, facts: Record<string, unknown>) => {
    const su = await checkStepUp(db, req, { kind: "settings_relax", facts: { op, ...facts } });
    if (!su.ok) {
      await reply.status(su.status).send(su.body);
      return false;
    }
    return true;
  };

  app.get("/v1/cloud-workers/providers", async () => {
    const [org, rows, creds] = await Promise.all([loadOrgSettings(db), db.select().from(cloudWorkerProviders).orderBy(asc(cloudWorkerProviders.provider)), db.select().from(cloudWorkerCredentials)]);
    const byProvider = new Map(creds.map((c) => [c.providerId, c]));
    return {
      enabled: org.cloudWorkersEnabled,
      readiness: CLOUD_WORKER_READINESS,
      scopeNote: CLOUD_WORKER_SCOPE_NOTE,
      providers: rows.map((r) => cloudWorkerProviderView(r, byProvider.get(r.id))),
    };
  });

  app.put("/v1/cloud-workers/providers/:provider", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const parsed = upsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { baseUrl, enabled?, allowPrivateRanges?, usdPerAcu?, usdPerMillionTokens?, maxPollMinutes? }" });
    const body = parsed.data;
    const before = await loadProvider(provider);
    const allowPrivateRanges = body.allowPrivateRanges === undefined ? (before?.allowPrivateRanges ?? null) : body.allowPrivateRanges;
    const enabled = body.enabled ?? before?.enabled ?? false;
    const refuse = async (status: number, code: string, detail: string) => {
      await audit(db, req, before?.id ?? null, CLOUD_WORKER_RULE_IDS.providerRefused, "deny", `Cloud worker '${provider}' refused: ${detail}. Nothing was saved.`, { phase: "provider", provider, code });
      return reply.status(status).send({ error: "cloud_worker_provider_refused", code, detail });
    };
    if (enabled && CLOUD_WORKER_READINESS[provider] !== "fake_verified") return refuse(400, "provider_not_ready", "this provider's contract is not verified yet, so it cannot be enabled (ADR-0320 §1)");
    const urlProblem = providerBaseUrlProblem(body.baseUrl, allowPrivateRanges);
    if (urlProblem) return refuse(400, "base_url_refused", urlProblem);
    const { decision } = await checkMcpServerUrl(db, body.baseUrl, allowPrivateRanges);
    if (!decision.ok) return refuse(400, "egress_blocked", decision.reason);
    // relaxations: enabling a provider, opting a provider into private ranges
    const enabling = enabled && !(before?.enabled ?? false);
    const opening = allowPrivateRanges === true && before?.allowPrivateRanges !== true;
    if ((enabling || opening) && !(await stepUp(req, reply, "cloud_worker_provider_relax", { provider, baseUrl: body.baseUrl, values: { enabled, allowPrivateRanges } }))) return reply;
    const values = {
      baseUrl: body.baseUrl,
      enabled,
      allowPrivateRanges,
      usdPerAcu: body.usdPerAcu === undefined ? (before?.usdPerAcu ?? null) : body.usdPerAcu,
      usdPerMillionTokens: body.usdPerMillionTokens === undefined ? (before?.usdPerMillionTokens ?? null) : body.usdPerMillionTokens,
      maxPollMinutes: body.maxPollMinutes ?? before?.maxPollMinutes ?? 120,
    };
    const row = await db.transaction(async (tx) => {
      const [saved] = before
        ? await tx.update(cloudWorkerProviders).set({ ...values, updatedAt: sql`now()` }).where(eq(cloudWorkerProviders.id, before.id)).returning()
        : await tx.insert(cloudWorkerProviders).values({ provider, ...values, createdBy: req.authCtx.userId ?? null }).onConflictDoNothing().returning();
      if (!saved) return null;
      await audit(tx as unknown as Db, req, saved.id, CLOUD_WORKER_RULE_IDS.providerSaved, "allow", `Cloud worker '${provider}' ${before ? "updated" : "configured"} at ${originOf(saved.baseUrl)}${saved.enabled ? ", enabled" : ", disabled"}; nobody may dispatch to it until granted`, {
        phase: "provider",
        provider,
        before: before ? { baseUrl: before.baseUrl, enabled: before.enabled, allowPrivateRanges: before.allowPrivateRanges, usdPerAcu: before.usdPerAcu, usdPerMillionTokens: before.usdPerMillionTokens, maxPollMinutes: before.maxPollMinutes } : null,
        after: values,
        ...(enabling || opening ? { relaxation: true } : {}),
      });
      return saved;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "the provider changed while this was being saved; reload and try again" });
    const [cred] = await db.select().from(cloudWorkerCredentials).where(eq(cloudWorkerCredentials.providerId, row.id));
    return reply.status(before ? 200 : 201).send({ ...cloudWorkerProviderView(row, cred), scopeNote: CLOUD_WORKER_SCOPE_NOTE });
  });

  app.put("/v1/cloud-workers/providers/:provider/credential", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const parsed = credentialSchema.safeParse(req.body);
    // the zod issue list could echo the body back, and the body holds the secret: a fixed sentence instead
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { secret, rotate? }" });
    const body = parsed.data;
    const prov = await loadProvider(provider);
    if (!prov) return reply.status(404).send({ error: "provider_not_configured", detail: "configure the provider first" });
    if (!opts.dataKey) return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
    const problem = mcpUpstreamSecretProblem(body.secret);
    if (problem) {
      await audit(db, req, prov.id, CLOUD_WORKER_RULE_IDS.credentialRefused, "deny", `Cloud worker '${provider}': credential refused: ${problem}. Nothing was saved.`, { phase: "credential", provider, code: "secret_refused" });
      return reply.status(400).send({ error: "cloud_worker_credential_refused", code: "secret_refused", detail: problem });
    }
    const rotate = body.rotate === true;
    const [existing] = await db.select({ id: cloudWorkerCredentials.id }).from(cloudWorkerCredentials).where(eq(cloudWorkerCredentials.providerId, prov.id));
    if (Boolean(existing) !== rotate) {
      return reply.status(409).send(existing ? { error: "credential_exists", detail: "this provider already has a credential: rotate it to replace it" } : { error: "no_credential", detail: "this provider has no credential to rotate: set one" });
    }
    if (!(await stepUp(req, reply, `cloud_worker_credential_${rotate ? "rotate" : "set"}`, { provider, baseUrl: prov.baseUrl }))) return reply;
    const values = { secretCiphertext: encryptSecret(opts.dataKey, body.secret), secretLast4: body.secret.slice(-4), setBy: req.authCtx.userId ?? null };
    const row = await db.transaction(async (tx) => {
      const [saved] = rotate
        ? await tx.update(cloudWorkerCredentials).set(values).where(eq(cloudWorkerCredentials.providerId, prov.id)).returning()
        : await tx.insert(cloudWorkerCredentials).values({ providerId: prov.id, ...values }).onConflictDoNothing().returning();
      if (!saved) return null;
      await audit(tx as unknown as Db, req, prov.id, rotate ? CLOUD_WORKER_RULE_IDS.credentialRotated : CLOUD_WORKER_RULE_IDS.credentialSet, "allow", `Cloud worker '${provider}': credential ${rotate ? "rotated" : "set"}, sent only to ${originOf(prov.baseUrl)} as Authorization: Bearer`, { phase: "credential", provider, relaxation: true });
      return saved;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "the credential changed while this was being saved; reload and try again" });
    return reply.status(rotate ? 200 : 201).send({ credential: cloudWorkerCredentialView(row) });
  });

  app.get("/v1/cloud-workers/providers/:provider/grants", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const prov = await loadProvider(provider);
    if (!prov) return reply.status(404).send({ error: "provider_not_configured" });
    const rows = await db
      .select({ id: cloudWorkerGrants.id, userId: cloudWorkerGrants.userId, email: users.email, displayName: users.displayName, createdAt: cloudWorkerGrants.createdAt })
      .from(cloudWorkerGrants)
      .innerJoin(users, eq(users.id, cloudWorkerGrants.userId))
      .where(eq(cloudWorkerGrants.providerId, prov.id))
      .orderBy(asc(users.email))
      .limit(1000);
    return { grants: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  app.post("/v1/cloud-workers/providers/:provider/grants", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { userId }" });
    const prov = await loadProvider(provider);
    if (!prov) return reply.status(404).send({ error: "provider_not_configured" });
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, parsed.data.userId));
    if (!user) return reply.status(404).send({ error: "unknown_user" });
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(cloudWorkerGrants).values({ providerId: prov.id, userId: user.id, grantedBy: req.authCtx.userId ?? null }).onConflictDoNothing().returning();
      if (!created) return null;
      await audit(tx as unknown as Db, req, prov.id, CLOUD_WORKER_RULE_IDS.granted, "allow", `Cloud worker '${provider}': ${user.email} may now dispatch signed-off build stages to it, within their own entitlements`, { phase: "grant", provider, grantId: created.id, userId: user.id });
      return created;
    });
    if (!row) return reply.status(409).send({ error: "grant_exists", detail: "this person already has this access" });
    return reply.status(201).send({ id: row.id, userId: row.userId, createdAt: row.createdAt.toISOString() });
  });

  app.delete("/v1/cloud-workers/providers/:provider/grants/:grantId", async (req, reply) => {
    const { provider, grantId } = grantParam.parse(req.params);
    const prov = await loadProvider(provider);
    if (!prov) return reply.status(404).send({ error: "provider_not_configured" });
    const removed = await db.transaction(async (tx) => {
      const [gone] = await tx.delete(cloudWorkerGrants).where(and(eq(cloudWorkerGrants.id, grantId), eq(cloudWorkerGrants.providerId, prov.id))).returning();
      if (!gone) return false;
      await audit(tx as unknown as Db, req, prov.id, CLOUD_WORKER_RULE_IDS.grantRemoved, "allow", `Cloud worker '${provider}': access removed`, { phase: "grant", provider, grantId, userId: gone.userId });
      return true;
    });
    if (!removed) return reply.status(404).send({ error: "unknown_grant" });
    return reply.status(204).send();
  });

  app.post("/v1/cloud-workers/providers/:provider/halt", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const parsed = haltSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected { reason (1 to 500 characters) }" });
    const out = await haltCloudWorkerProvider(db, provider, parsed.data.reason, actor(req), deps);
    if (out.kind === "not_found") return reply.status(404).send({ error: "provider_not_configured" });
    return { halted: true, cancelled: out.cancelled, auditId: out.auditId };
  });

  app.post("/v1/cloud-workers/providers/:provider/unhalt", async (req, reply) => {
    const { provider } = providerParam.parse(req.params);
    const prov = await loadProvider(provider);
    if (!prov) return reply.status(404).send({ error: "provider_not_configured" });
    if (!prov.haltedAt) return reply.status(409).send({ error: "not_halted", detail: "this provider is not halted" });
    if (!(await stepUp(req, reply, "cloud_worker_provider_unhalt", { provider }))) return reply;
    const row = await db.transaction(async (tx) => {
      const [saved] = await tx.update(cloudWorkerProviders).set({ haltedAt: null, haltedReason: null, haltedBy: null, updatedAt: sql`now()` }).where(and(eq(cloudWorkerProviders.id, prov.id), isNotNull(cloudWorkerProviders.haltedAt))).returning();
      if (!saved) return null;
      await audit(tx as unknown as Db, req, prov.id, CLOUD_WORKER_RULE_IDS.unhalted, "allow", `Cloud worker '${provider}': halt lifted; new dispatches are decided again`, { phase: "halt", provider, relaxation: true });
      return saved;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently" });
    const [cred] = await db.select().from(cloudWorkerCredentials).where(eq(cloudWorkerCredentials.providerId, row.id));
    return cloudWorkerProviderView(row, cred);
  });

  app.get("/v1/cloud-workers/dispatches", async (req, reply) => {
    const parsed = dispatchListSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", detail: "expected ?provider=&limit=1..200&before=<ISO time>" });
    const q = parsed.data;
    const conds = [
      ...(q.provider ? [eq(cloudWorkerProviders.provider, q.provider)] : []),
      ...(q.before ? [lt(cloudWorkerDispatches.createdAt, new Date(q.before))] : []),
    ];
    const rows = await db
      .select({ d: cloudWorkerDispatches, provider: cloudWorkerProviders.provider })
      .from(cloudWorkerDispatches)
      .innerJoin(cloudWorkerProviders, eq(cloudWorkerProviders.id, cloudWorkerDispatches.providerId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(cloudWorkerDispatches.createdAt))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { dispatches: page.map((r) => cloudWorkerDispatchView(r.d, r.provider)), nextBefore: rows.length > q.limit ? page[page.length - 1]!.d.createdAt.toISOString() : null };
  });
}
