/**
 * ADR-0173 — THE GOVERNED CONNECTOR CALL, in-process.
 *
 * Extracted VERBATIM from `POST /v1/connectors/:connectorId/invoke` so the
 * builder's tool loop (builder-runtime.ts) runs exactly the code a person's own
 * invoke runs — entitlement kernel (with the kill switch), the decision audit
 * row, the pillar-5 project budget, the credential, §8.4 PII, ADR-0042
 * guardrails, the ADR-0034/0062/0167 egress guards, the provider call, the
 * usage row and the connector span — and can never drift from it. The route is
 * now a thin wrapper that maps `{status, body}` onto the reply.
 *
 * Two optional inputs exist for in-process callers and change nothing for the
 * route (which passes neither):
 *  - `trace`: the caller owns the trace tree, so the connector span hangs from
 *    the caller's context (a model turn) instead of opening a one-span trace;
 *  - `detail`: correlation ids merged into the DECISION audit row (the builder
 *    passes its thread / step ids), so the governed call stays findable from
 *    the step that made it.
 *
 * It never decides anything the route did not: every refusal is the same
 * status and body the route returns, and an unexpected failure throws (the
 * route lets Fastify answer 500, exactly as before the extraction).
 *
 * ADR-0173 batch 2b — CONNECTOR WRITES IN THE APPROVALS QUEUE. Under the
 * execution dial's `require_approval` mode a connector WRITE used to be
 * refused ("this path has no per-call approval queue"). It now gets one, and it
 * is the MCP path's queue under the MCP path's rules, reused rather than
 * re-derived:
 *  - the kernel resolves ENTITLEMENT FIRST and only then holds the write
 *    (AER-017), so an approval can never stand in for a missing grant;
 *  - the queued row is bound to the call's ARGUMENT DIGEST (ADR-0104; the
 *    redacted digest under PII redact mode, ADR-0144) and to its POLICY
 *    CONTEXT — the dial's hold, the named approver and the connector target
 *    (ADR-0105/0166) — and dies on the org's approval TTL;
 *  - an identical pending call reuses the pending row instead of piling up;
 *  - an approved row is spent by `consumeBoundApproval` (the MCP primitive) in
 *    one guarded UPDATE right before the provider is called, so two re-submits
 *    of one approved call execute ONCE; a consent that went stale or expired is
 *    superseded visibly (`supersedeStaleConsent`) and re-queued.
 * A caller is answered 202 with the approval id (`status: pending_approval`);
 * a re-submit after the decision executes the identical call. A READ under the
 * dial is still refused, as before: the hold is defined for writes.
 */
import {
  and,
  approvals,
  asc,
  auditLog,
  connectorCredentials,
  connectorGrants,
  connectors,
  eq,
  governancePolicyEpoch,
  usageEvents,
  type Db,
} from "@regulait/db";
import { evaluateConnector } from "@regulait/policy-kernel";
import {
  CREDENTIAL_HOST_CONNECTOR_KINDS,
  ConnectorProviderError,
  connectorCredentialHosts,
  connectorDefaultBaseUrl,
  isConnectorProviderKind,
  resolveConnectorProvider,
  reservedChatControl,
} from "@regulait/connector-provider";
import {
  approvalArgumentsDigest,
  approvalArgumentsPreview,
  approvalContextDigest,
  canonicalJson,
  sha256Hex,
  guardrailCategoryList,
  guardrailWithheldMarker,
  redactPiiPayload,
  type PiiHit,
} from "@regulait/shared";
import { ConnectorPolicyChangedError, prepareConnectorPiiAction } from "./connector-pii.js";
import { loadExecutionDial, postureOf } from "./execution-posture.js";
import { literacySlot } from "./ai-literacy.js"; // ADR-0182 A14
import { consumeBoundApproval, supersedeStaleConsent } from "./mcp-proxy.js";
import { loadOrgSettings } from "./org-settings.js";
import type { RetiredApproval } from "./governed-evaluate.js";
import {
  flattenFindings,
  guardrailOutcome,
  recordGuardrailDecision,
  resolveGuardrailPolicy,
  runGuardrails,
  type DispatchGuardrails,
  type GuardrailPolicy,
} from "./guardrails.js";
import { decryptSecret } from "./secrets.js";
import {
  assertProjectAttribution,
  enforcePII,
  piiCategoryList,
  piiInternationalCategories,
  piiWithheldMarker,
  preDispatchProjectGate,
  projectPiiMode,
} from "./projects.js";
import { loadConnectorRevocations, loadRoleConnectorGrants } from "./entitlements.js";
import { egressRefusal } from "./egress-guard.js";
import {
  ConnectionEgressBlockedError,
  guardConnectionCall,
  guardCredentialDerivedCall,
} from "./connection-egress.js";
import {
  auditCompiledDefaultDenied,
  decideCompiledDefault,
  loadCompiledEgressContext,
} from "./compiled-egress.js";
import { beginTrace, finishTrace, recordSpan, type TraceContext } from "./tracing.js";
// ADR-0185 G5 — the decision counter (a no-op seam until the meter lands)
import { recordDecision } from "./metrics.js";

/**
 * ADR-0070 amendment (2026-08-15) — what the governed connector body answers
 * into instead of the Fastify reply, so that ONE wrapper can see EVERY exit and
 * write the `connector` span from it.
 *
 * It is deliberately not a Fastify reply and is deliberately not named `reply`:
 * it sends nothing, it decides nothing, it only captures the status and payload
 * the attempt chose so the wrapper can classify them and then send them on
 * unchanged. The shape mirrors `reply.status(n).send(body)` exactly so the body
 * it wraps reads the same as every other route.
 */
export interface ConnectorAttemptResult {
  status: number;
  body: Record<string, unknown>;
}
interface ConnectorReplyRecorder {
  status(code: number): ConnectorReplyRecorder;
  send(body: Record<string, unknown>): ConnectorAttemptResult;
}
function connectorReplyRecorder(): ConnectorReplyRecorder {
  let code = 200;
  const api: ConnectorReplyRecorder = {
    status(c) {
      code = c;
      return api;
    },
    send(body) {
      return { status: code, body };
    },
  };
  return api;
}

export interface GovernedConnectorCallArgs {
  /** the person the call runs as (their grants, revocations, project) */
  userId: string;
  /** project-attribution re-check: an admin may bill any project */
  isAdmin: boolean;
  connectorId: string;
  operation: "read" | "write";
  object?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  /** pillar 5: the project this call bills to (re-checked for the person) */
  projectId?: string | null | undefined;
  /** UNDEFINED (the route): a one-span trace of its own. A context or null:
   * the caller owns the tree; the span hangs from it (null records nothing). */
  trace?: TraceContext | null | undefined;
  /** correlation ids merged into the decision audit row's detail */
  detail?: Record<string, unknown> | undefined;
}

/** the approval-queue object type of a held connector write */
export const CONNECTOR_APPROVAL_OBJECT_TYPE = "connector_call" as const;

/** the fingerprint of a connector call's argument envelope, shown beside a
 * redacted preview where an MCP tool shows its input schema's */
const CONNECTOR_INVOCATION_SCHEMA_DIGEST = sha256Hex(
  canonicalJson({ namespace: "regulait.connector-invocation.v1", fields: ["operation", "object", "payload"] }),
);

/**
 * ADR-0173 batch 2b — the consent identity of one connector WRITE, computed
 * only while the dial holds writes. Pure reads; nothing is written here.
 */
interface ConnectorWriteBinding {
  argumentsDigest: string;
  argumentsPreview: unknown;
  argumentsPreviewKind: "arguments_v1" | "mcp_redacted_v1";
  contextDigest: string;
  /** a fresh, payload-matching approved row this call may spend */
  approvedApprovalId: string | null;
  /** payload-matching approved rows that lapsed or went stale */
  retired: RetiredApproval[];
}

async function connectorWriteBinding(
  db: Db,
  input: {
    userId: string;
    connector: typeof connectors.$inferSelect;
    projectId: string | null;
    invocation: { operation: "read" | "write"; object: string | null; payload: Record<string, unknown> | null };
    preparedPii: { argumentsDigest: string; argumentsPreview: unknown } | null;
    approverUserId: string | null;
  },
): Promise<ConnectorWriteBinding> {
  const { connector } = input;
  const [cred] = await db
    .select({ baseUrl: connectorCredentials.baseUrl })
    .from(connectorCredentials)
    .where(eq(connectorCredentials.connectorId, connector.id));
  // ADR-0104: computed on the RAW arguments, so a credential scrub cannot move
  // consent identity; under PII redact the redacted binding (ADR-0144) instead,
  // and its preview never carries the original payload.
  const argumentsDigest =
    input.preparedPii?.argumentsDigest ??
    approvalArgumentsDigest({ projectId: input.projectId, arguments: input.invocation });
  const contextDigest = approvalContextDigest({
    // the dial's hold is the one "rule" that demanded this consent
    ruleVersions: [{ ruleId: "execution-require-approval", activeVersionId: null }],
    requiredApproverUserId: input.approverUserId,
    approvalScope: "action",
    target: {
      kind: "connector",
      connectorId: connector.id,
      providerKind: connector.providerKind ?? null,
      baseUrl: cred?.baseUrl ?? connector.baseUrl ?? null,
    },
  });
  const approved = await db
    .select({ id: approvals.id, argumentsDigest: approvals.argumentsDigest, contextDigest: approvals.contextDigest, expiresAt: approvals.expiresAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.userId, input.userId),
        eq(approvals.objectType, CONNECTOR_APPROVAL_OBJECT_TYPE),
        eq(approvals.connectorId, connector.id),
        eq(approvals.status, "approved"),
        eq(approvals.argumentsDigest, argumentsDigest),
      ),
    )
    .orderBy(asc(approvals.requestedAt))
    .limit(50);
  const now = Date.now();
  const expired = (r: (typeof approved)[number]) => r.expiresAt != null && r.expiresAt.getTime() <= now;
  const fresh = (r: (typeof approved)[number]) => !expired(r) && r.contextDigest === contextDigest;
  return {
    argumentsDigest,
    // under PII redact the preview has the redacted-action shape the approval
    // review reads (`{prepared, schemaDigest}`, as mcp-pii.ts writes it): a
    // connector's input "schema" is the fixed invocation envelope
    argumentsPreview: input.preparedPii
      ? { prepared: input.preparedPii.argumentsPreview, schemaDigest: CONNECTOR_INVOCATION_SCHEMA_DIGEST }
      : approvalArgumentsPreview(input.invocation),
    argumentsPreviewKind: input.preparedPii ? "mcp_redacted_v1" : "arguments_v1",
    contextDigest,
    approvedApprovalId: approved.find(fresh)?.id ?? null,
    retired: approved.filter((r) => !fresh(r)).map((r) => ({ id: r.id, reason: expired(r) ? "expired" : "context_changed" })),
  };
}

export async function executeGovernedConnectorCall(
  db: Db,
  dataKey: string | undefined,
  args: GovernedConnectorCallArgs,
): Promise<ConnectorAttemptResult> {
  const { userId, connectorId } = args;
  const body = {
    operation: args.operation,
    ...(args.object !== undefined ? { object: args.object } : {}),
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
  } as { operation: "read" | "write"; object?: string; payload?: Record<string, unknown>; projectId?: string };

  const [admissionGeneration] = await db.select().from(governancePolicyEpoch);
  const generationCurrent = async () => {
    const [current] = await db.select().from(governancePolicyEpoch);
    return !!admissionGeneration && current?.epoch === admissionGeneration.epoch;
  };
  let externalRequests = 0;
  const beforeConnectorSend = async () => {
    if (!await generationCurrent()) throw new ConnectorPolicyChangedError();
    externalRequests++;
  };
  const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!connector) return { status: 404, body: { error: "unknown_connector" } };

  // ─────────────────────────────────────────────────────────────────────
  // ADR-0070 amendment (2026-08-15) — THE CONNECTOR SPAN.
  //
  // `connector` was a DECLARED span kind with no writer, which made the
  // vocabulary promise coverage the product did not have. It is emitted here,
  // and it is emitted by a WRAPPER for exactly the reason the dispatch core's
  // span is: this handler has FOURTEEN exits and eleven of them are refusals.
  // A recorder sprinkled through the branches would trace the successes and
  // miss the denials — "a trace of only the successes" is failure mode 2 in
  // the ADR, and on a connector it is the worst one available, because a
  // connector call is where customer data actually moves.
  //
  // So the whole governed body answers into a RECORDER instead of the Fastify
  // reply, and the one span is written from whatever came back. Adding a
  // fifteenth refusal below cannot forget to be traced, because nothing below
  // mentions tracing.
  //
  // WHAT COUNTS AS A REFUSAL, and why the split is where it is: every 4xx this
  // route produces is a DECISION (the entitlement kernel, §8.4 PII, an
  // ADR-0042 guardrail, the ADR-0034/0062 egress guard, a missing credential,
  // an unrecognised provider). Only a 5xx is a fault — a 502 from the upstream
  // connector or a 503 for a missing data key. That is the same line
  // `dispatchOnce` draws when it calls `model_dispatch_failed` the one
  // non-decision, and it is the line ADR-0072 exists to protect: a defence
  // working must never be scored as a defence failing.
  // ─────────────────────────────────────────────────────────────────────
  const projectId = body.projectId ?? null;
  const piiMode = await projectPiiMode(db, projectId);
  const piiIntl = await piiInternationalCategories(db);
  const originalInvocation = { operation: body.operation, object: body.object ?? null, payload: body.payload ?? null };
  let effectiveInvocation = originalInvocation;
  let preparedPii: ReturnType<typeof prepareConnectorPiiAction>["prepared"] | null = null;
  let preparationFailed = false;
  if (piiMode === "redact") {
    try {
      const prepared = prepareConnectorPiiAction(projectId, originalInvocation, piiIntl);
      preparedPii = prepared.prepared;
      effectiveInvocation = prepared.invocation as typeof originalInvocation;
    } catch { preparationFailed = true; }
  }
  let policyChanged = false;
  const policyChangedBody = () => ({ error: "connector_policy_changed", detail: "Connector policy changed; result withheld. Review external effects before retrying.",
    externalRequests, mayHaveExecuted: externalRequests > 0, retrySafe: externalRequests === 0,
    costUsd: sink.costUsd ?? null, withheld: true });
  /** filled at the ONE place the ledger row is written, so the span
   * REFERENCES that row rather than recomputing its figures (rule 1). */
  const sink: { usageEventId?: string | null; costUsd?: number | null } = {};
  let binding: ConnectorWriteBinding | null = null;
  const attempt = async (out: ConnectorReplyRecorder): Promise<ConnectorAttemptResult> => {
    // pillar 5 + ADR-0011: attribution must point at a real project the caller
    // may bill to — mirror the model invoke path. Checked up front, before any
    // execution or metering can happen.
    if (projectId) {
      const attribution = await assertProjectAttribution(db, projectId, userId, args.isAdmin);
      if (!attribution.ok) return out.status(attribution.status).send({ error: attribution.error });
    }

    if (preparationFailed) {
      await db.insert(auditLog).values({ userId, objectType: "connector", objectId: connectorId,
        detail: { phase: "input", operation: body.operation, projectId }, effect: "deny",
        ruleId: "pii-transform-refused", ruleChain: [], reason: "Connector payload or routing identity cannot be safely transformed" });
      return out.status(403).send({ error: "pii_transform_refused", detail: "Connector payload or routing identity cannot be safely transformed." });
    }

    // ADR-0173 batch 2b review — the product's own chat controls are not a
    // connector call's to use: no rewriting a message (`chat.update` is the
    // courier's alone) and no posting a card that carries our reserved
    // approve / confirm controls. Checked on what the CALLER sent, before the
    // kernel, so nothing is queued for approval, executed or billed.
    const reserved = reservedChatControl(connector.providerKind ?? "", body.operation, originalInvocation.payload);
    if (reserved) {
      await db.insert(auditLog).values({ userId, objectType: "connector", objectId: connectorId,
        detail: { phase: "input", operation: body.operation, code: reserved.code, projectId, ...(args.detail ?? {}) }, effect: "deny",
        ruleId: "connector-reserved-chat-control", ruleChain: [], reason: `connector '${connector.name}': ${reserved.detail}` });
      return out.status(403).send({ error: reserved.code, detail: reserved.detail });
    }

    const [grants, roleConnectorGrantsForUser, connectorRevocationsForUser] = await Promise.all([
      db.select().from(connectorGrants).where(eq(connectorGrants.userId, userId)),
      // §5 role-bundled grants (ADR-0014): unioned in the kernel so a narrow
      // direct grant cannot mask a broader role grant.
      loadRoleConnectorGrants(db, userId),
      // ADR-0019: the subtractive bound on that union.
      loadConnectorRevocations(db, userId),
    ]);

    // ADR-0173 batch 2b: the dial WITH its approver, and — only while it holds
    // writes — this write's consent binding (nothing is read otherwise).
    const dial = await loadExecutionDial(db);
    const connectorLiteracy = await literacySlot(db, userId); // ADR-0182 A14
    binding =
      dial.mode === "require_approval" && body.operation === "write"
        ? await connectorWriteBinding(db, {
            userId,
            connector,
            projectId,
            invocation: originalInvocation,
            preparedPii: preparedPii ? { argumentsDigest: preparedPii.argumentsDigest, argumentsPreview: preparedPii.argumentsPreview } : null,
            approverUserId: dial.approverUserId,
          })
        : null;
    const decision = evaluateConnector({
      userId,
      // ADR-0124 — the kill switch on the connector path. A connector has no
      // per-subject halt of its own; the dial governs it.
      execution: { ...postureOf(dial.mode, null), approverUserId: dial.approverUserId, ...connectorLiteracy },
      // this path CAN queue a write (ADR-0173 batch 2b)
      writeApprovalQueue: { approvedApprovalId: binding?.approvedApprovalId ?? null },
      connectorId,
      connectorName: connector.name,
      operation: body.operation,
      object: body.object ?? null,
      connectorGrants: grants,
      roleConnectorGrants: roleConnectorGrantsForUser,
      connectorRevocations: connectorRevocationsForUser,
    });
    recordDecision({ surface: "connector", effect: decision.effect });

    // Order evidence containing routing identity against policy activation.
    const audited = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(governancePolicyEpoch).for("share");
      if (!admissionGeneration || current?.epoch !== admissionGeneration.epoch) return false;
      await tx.insert(auditLog).values({
        userId,
        objectType: "connector",
        objectId: connectorId,
        // ADR-0058 SCOPE, same reason as the MCP tool path: a pack's
        // `audit_decisions` collector reaches a decision only through
        // `detail->>'projectId'`. The PII-block rows on this same path already
        // carried it; the DECISION row did not, so a project-scoped count of
        // connector refusals was structurally zero. Null when unattributed.
        detail: {
          operation: body.operation,
          ...(body.object ? { object: body.object } : {}),
          projectId: projectId ?? null,
          // ADR-0104/0105 forensic half: WHICH payload and WHICH policy, as
          // digests, whenever the write was under the dial's hold
          ...(binding ? { argumentsDigest: binding.argumentsDigest, approvalScope: "action", contextDigest: binding.contextDigest } : {}),
          ...(args.detail ?? {}),
        },
        effect: decision.effect,
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason: decision.reason,
      });
      return true;
    });
    if (!audited) { policyChanged = true; return out.status(409).send(policyChangedBody()); }

    // A DENIED call bills nothing and executes nothing (mirror the model path).
    if (decision.effect === "deny") {
      return out.status(403).send({ decision });
    }

    // PILLAR 5 enforcement, connector path (F02 / ADR-0103 amendment
    // 2026-10-03). An attributed invoke is gated on the project's MEASURED
    // budget here — after the categorical entitlement decision (no budget
    // makes a forbidden call permissible), and strictly BEFORE the credential
    // is read, before PII/guardrail work, before the egress guard, and before
    // the provider is ever contacted — so a budget-blocked call executes
    // nothing, consumes nothing and bills nothing. The gate itself is REUSED
    // from the model and MCP paths, not reimplemented: the compliance
    // ceiling, sanctioned overage, budgetHardBlockPct, warn_only vs block
    // with strictest-wins, and the escalation into the one approvals queue
    // all carry over unchanged. Unattributed calls (projectId null) pass
    // straight through and meter into the disclosed Unattributed bucket.
    const projectBudget = await preDispatchProjectGate(db, projectId, userId);
    if (!projectBudget.ok) {
      await db.insert(auditLog).values({
        userId,
        objectType: "connector",
        objectId: connectorId,
        detail: {
          phase: "project-budget",
          projectId,
          operation: body.operation,
          ...(body.object ? { object: body.object } : {}),
          pricePerCallUsd: connector.pricePerCallUsd ?? null,
        },
        effect: "deny",
        ruleId: "project-budget-cap",
        ruleChain: [],
        reason: `connector '${connector.name}' blocked: ${projectBudget.error} — ${projectBudget.detail ?? "project budget exhausted"}`,
      });
      return out.status(projectBudget.status).send({
        decision,
        error: projectBudget.error,
        ...(projectBudget.detail ? { detail: projectBudget.detail } : {}),
      });
    }

    // ADR-0173 batch 2b — THE HOLD. After the entitlement deny and the budget
    // gate (a write that cannot run is never queued), before the credential,
    // PII, guardrails, egress and the provider: a held write executes nothing.
    if (decision.effect === "require_approval") {
      const b = binding!;
      const superseded = b.retired.length
        ? await supersedeStaleConsent(db, b.retired, { userId, connector: { id: connector.id, name: connector.name }, projectId })
        : [];
      const { approvalTtlHours } = await loadOrgSettings(db);
      // an identical pending call reuses its pending row (the dedup keys on the
      // payload: a different payload is a different consent)
      const [pending] = await db
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.userId, userId),
            eq(approvals.objectType, CONNECTOR_APPROVAL_OBJECT_TYPE),
            eq(approvals.connectorId, connector.id),
            eq(approvals.status, "pending"),
            eq(approvals.argumentsDigest, b.argumentsDigest),
            eq(approvals.contextDigest, b.contextDigest),
            eq(approvals.argumentsPreviewKind, b.argumentsPreviewKind),
          ),
        )
        .orderBy(asc(approvals.requestedAt))
        .limit(1);
      const approvalId =
        pending?.id ??
        (
          await db
            .insert(approvals)
            .values({
              userId,
              objectType: CONNECTOR_APPROVAL_OBJECT_TYPE,
              connectorId: connector.id,
              // the operation and the object a person reads in the queue
              toolName: `${connector.name}.${body.operation}`,
              approverUserId: decision.approverUserId!,
              argumentsDigest: b.argumentsDigest,
              argumentsPreview: b.argumentsPreview,
              argumentsPreviewKind: b.argumentsPreviewKind,
              approvalScope: "action",
              projectId,
              contextDigest: b.contextDigest,
              ...(approvalTtlHours != null ? { expiresAt: new Date(Date.now() + approvalTtlHours * 3_600_000) } : {}),
            })
            .returning({ id: approvals.id })
        )[0]!.id;
      const anyContext = b.retired.some((r) => superseded.includes(r.id) && r.reason === "context_changed");
      const approvalKind = superseded.length ? (anyContext ? "approval_context_stale" : "approval_expired") : "approval_required";
      return out.status(202).send({
        status: "pending_approval",
        approvalId,
        approvalKind,
        ...(superseded.length ? { supersededApprovalIds: superseded } : {}),
        decision,
        detail:
          `approval '${approvalId}' is pending sign-off; nothing ran. Re-submit the identical call once it is approved` +
          (superseded.length ? ` (approval ${superseded.join(", ")} ${anyContext ? "was granted under a policy that has since changed" : "expired"} and was superseded)` : ""),
      });
    }

    // ADR-0173 batch 2b — spend the consent this write was released by, ONCE,
    // atomically, right before anything executes. Losing the race (a second
    // re-submit of the same approved call) runs nothing.
    const consumeHeld = async (): Promise<ConnectorAttemptResult | null> => {
      const approvedId = binding?.approvedApprovalId;
      if (!approvedId || !binding) return null;
      const consumed = await consumeBoundApproval(db, {
        approvalId: approvedId,
        policyEpoch: admissionGeneration!.epoch,
        approvalScope: "action",
        argumentsDigest: binding.argumentsDigest,
        contextDigest: binding.contextDigest,
      });
      if (consumed) return null;
      const [row] = await db.select().from(approvals).where(eq(approvals.id, approvedId));
      if (row && row.status === "approved") {
        const reason: RetiredApproval["reason"] =
          row.expiresAt != null && row.expiresAt.getTime() <= Date.now() ? "expired" : "context_changed";
        const superseded = await supersedeStaleConsent(db, [{ id: row.id, reason }], {
          userId, connector: { id: connector.id, name: connector.name }, projectId,
        });
        return out.status(409).send({
          decision,
          error: reason === "expired" ? "approval_expired" : "approval_context_stale",
          supersededApprovalIds: superseded,
          detail: `approval '${approvedId}' ${reason === "expired" ? "expired before it was used" : "was granted under a policy that has since changed"}; nothing ran — re-submit to raise a fresh one`,
        });
      }
      return out.status(409).send({
        decision,
        error: "approval_consumed_race",
        approvalId: approvedId,
        detail: `approval '${approvedId}' was already used by another call; nothing ran`,
      });
    };

    // EXECUTION runs strictly INSIDE the allow branch, after the audit insert.
    // A connector with no providerKind keeps TODAY'S behaviour exactly:
    // governance-only, no execution, no cost, no usage row.
    if (!connector.providerKind) {
      const spent = await consumeHeld();
      if (spent) return spent;
      return out.send({ decision });
    }
    if (!isConnectorProviderKind(connector.providerKind)) {
      return out.status(409).send({
        decision,
        error: "unknown_connector_provider",
        detail: `connector '${connector.name}' has an unrecognized provider_kind '${connector.providerKind}'`,
      });
    }

    // Resolve the platform credential (connector_credentials → decrypt with the
    // data key). Keyless kinds (mock, unauthenticated generic) skip it; a keyed
    // kind with no stored credential fails explicit like the model path. A
    // credential.baseUrl overrides the connector's, mirroring model_credentials.
    const keylessKinds = new Set(["mock", "generic", "http", "webhook"]);
    let token: string | null = null;
    let baseUrl: string | null = connector.baseUrl ?? null;
    const [cred] = await db
      .select()
      .from(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, connectorId));
    if (cred) {
      if (!dataKey) {
        return out.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
      }
      token = decryptSecret(dataKey, cred.tokenCiphertext);
      if (cred.baseUrl) baseUrl = cred.baseUrl;
    } else if (!keylessKinds.has(connector.providerKind)) {
      return out.status(409).send({
        decision,
        error: "no_connector_credential",
        detail: `connector '${connector.name}' (${connector.providerKind}) has no stored credential`,
      });
    }

    // §8.4 PII ENFORCEMENT (pillar 3), connector path. The effective piiMode
    // comes from the attributed project's cascade; an unattributed or
    // unclassified call falls to the ORG FLOOR (ADR-0021 defaultPiiMode, null
    // when unset). The resolver is called unconditionally — the old
    // `projectId ? … : null` ternary here was exactly the one-keystroke
    // attribution dodge the floor exists to close. The INPUT check runs BEFORE
    // provider.invoke, so a block executes nothing and bills nothing.
    let inputHits: PiiHit[] = [...(preparedPii?.hits ?? [])];
    if (piiMode && piiMode !== "redact") {
      const chk = enforcePII(
        piiMode,
        { input: JSON.stringify({ object: body.object ?? null, payload: body.payload ?? null }) },
        piiIntl,
      );
      inputHits = chk.hits;
      if (chk.action === "block") {
        const reason = `input contains PII: ${piiCategoryList(chk.hits)}`;
        await db.insert(auditLog).values({
          userId,
          objectType: "connector",
          objectId: connectorId,
          detail: {
            phase: "pii",
            pii: { mode: piiMode, action: "block", phase: "input", inputHits: chk.hits, outputHits: [] },
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
          effect: "deny",
          ruleId: "pii-blocked",
          ruleChain: [],
          reason,
        });
        return out.status(403).send({
          decision,
          error: "pii_blocked",
          detail: reason,
          pii: { mode: piiMode, action: "block", inputHits: chk.hits, outputHits: [], withheld: false },
        });
      }
    }

    // ADR-0042 GUARDRAIL ENGINE, connector path — the same two phases, the same
    // exclusion of PII (enforced on its own path above), the same audit rules.
    // Scoped to this connector's override (or the org default), MAX-composed
    // with the attributed project's compliance floor.
    const connectorGuardrails: GuardrailPolicy = await resolveGuardrailPolicy(db, {
      projectId,
      connectorId,
    });
    let cgInput: ReturnType<typeof runGuardrails> | null = null;
    if (connectorGuardrails.active) {
      cgInput = runGuardrails(
        connectorGuardrails,
        "input",
        JSON.stringify({ object: body.object ?? null, payload: body.payload ?? null }),
      );
      const outcome = guardrailOutcome(cgInput);
      if (outcome) {
        await recordGuardrailDecision(db, {
          userId,
          objectType: "connector",
          objectId: connectorId,
          projectId,
          evaluation: cgInput,
          outcome,
          detail: { operation: body.operation, connectorKind: connector.providerKind },
        });
      }
      if (cgInput.action === "block") {
        const reason = `input blocked by guardrail: ${guardrailCategoryList(cgInput.blocking)}`;
        return out.status(403).send({
          decision,
          error: "guardrail_blocked",
          detail: reason,
          guardrails: {
            action: "block",
            phase: "input",
            findings: flattenFindings(cgInput.findings),
            withheld: false,
          },
        });
      }
      if (preparedPii) {
        const effectiveCheck = runGuardrails(connectorGuardrails, "input", JSON.stringify(effectiveInvocation));
        if (effectiveCheck.action === "block") {
          await recordGuardrailDecision(db, { userId, objectType: "connector", objectId: connectorId, projectId,
            evaluation: effectiveCheck, outcome: "blocked", detail: { phase: "effective_input", operation: body.operation } });
          return out.status(403).send({ decision, error: "guardrail_blocked", detail: "Effective connector input blocked by guardrail." });
        }
      }
    }

    // ADR-0034 amendment #2 — THE CONNECTOR `baseUrl`, BEHIND THE EGRESS GUARD.
    //
    // This is the surface both earlier amendments named as the highest-priority
    // one still open, and it is worse than the model paths in one specific way:
    // the `webhook` kind does not READ the URL, it **POSTs `body.payload` to
    // it**. A governed connector call is exactly where customer data lives, so
    // an admin-typed `baseUrl` here is an exfiltration pipe, not merely an SSRF
    // primitive. It is checked HERE, on every invoke — not only at write time —
    // because a write-time verdict is not a fact about the future and because
    // rows written before this guard existed are in the live database now.
    //
    // NO OVERRIDE MEANS NO CHECK: with `baseUrl` null the adapter uses its
    // compiled vendor endpoint (slack/github/jira/... defaults), which nobody
    // can type, so a non-overriding connector behaves byte-identically — the
    // global fetch, no allow-list entry required.
    //
    // ── AMENDED BY ADR-0062 (2026-08-03) ────────────────────────────────────
    // Still true as an SSRF argument, still not an egress policy. A connector
    // is the surface that carries CUSTOMER DATA by construction, so a Slack or
    // GitHub connector running on its compiled endpoint inside an air-gapped
    // install is the exact thing that mode promises does not happen. Under a
    // strict posture the compiled destination is adjudicated against the same
    // `egress_allow_hosts` table; under `hosted` this is byte-identical.
    let connectorFetch: typeof fetch | undefined;
    if (baseUrl) {
      let guarded;
      try {
        guarded = await guardConnectionCall(db, {
          surface: "connector",
          deps: { beforeSend: beforeConnectorSend },
          baseUrl,
          userId,
          objectId: connectorId,
          label: `connector '${connector.name}' (${connector.providerKind})`,
          detail: {
            connectorKind: connector.providerKind,
            operation: body.operation,
            source: cred?.baseUrl ? "connector_credential" : "connector",
            ...(projectId ? { projectId } : {}),
          },
        });
      } catch (err) {
        if (err instanceof ConnectionEgressBlockedError) {
          return out.status(403).send({
            decision,
            error: "egress_blocked",
            code: err.decision.code,
            detail:
              `connector '${connector.name}' (${connector.providerKind}): ${err.decision.reason}` +
              ` (an admin adds permitted destinations under Egress Allow Hosts)`,
          });
        }
        throw err;
      }
      connectorFetch = guarded.fetchImpl;
    } else if (CREDENTIAL_HOST_CONNECTOR_KINDS.has(connector.providerKind)) {
      // ADR-0167 (SEC-01) — a destination NAMED BY THE CREDENTIAL. With no
      // baseUrl these three kinds used to fall into the compiled-default
      // branch below, which (under the default posture) checks nothing and
      // hands the adapter the GLOBAL fetch — so an admin-typed `loginBaseUrl`
      // or snowflake `account` reached the network with no allow-list, no
      // private-range/IMDS check, no DNS pin, redirects followed and no audit
      // row, and the upstream body came back to the non-admin invoker. The
      // typed host is now adjudicated like a typed baseUrl, the vendor's
      // compiled hosts follow the posture exactly as below, and the adapter
      // gets the guarded fetch — which re-checks every URL it is handed.
      let hosts: { typed: string | null; compiled: string[] };
      try {
        hosts = connectorCredentialHosts(connector.providerKind, token);
      } catch (err) {
        if (err instanceof ConnectorProviderError) {
          return out
            .status(400)
            .send({ decision, error: "invalid_connector_credential", detail: err.message });
        }
        throw err;
      }
      const guarded = await guardCredentialDerivedCall(db, {
        surface: "connector",
        kind: connector.providerKind,
        typedBaseUrl: hosts.typed,
        compiledBaseUrls: hosts.compiled,
        userId,
        objectId: connectorId,
        label: `connector '${connector.name}' (${connector.providerKind})`,
        detail: {
          connectorKind: connector.providerKind,
          operation: body.operation,
          source: "connector_credential",
          ...(projectId ? { projectId } : {}),
        },
        deps: { beforeSend: beforeConnectorSend },
      });
      if (!guarded.ok) {
        const alsoReaches =
          connector.providerKind === "snowflake"
            ? ""
            : " (this kind reaches the Microsoft Entra login host as well as the service host — a typed login host needs an Egress Allow Hosts entry)";
        // `guarded.reason` already names the connector (the label above)
        return out.status(403).send({
          decision,
          error: "egress_blocked",
          code: guarded.code,
          detail: `${guarded.reason}${alsoReaches} (an admin adds permitted destinations under Egress Allow Hosts)`,
        });
      }
      connectorFetch = guarded.fetchImpl;
    } else {
      // ADR-0062 — the compiled connector endpoint. Every kind that cannot
      // exist without an explicit baseUrl resolves to "nothing to
      // adjudicate"; a kind whose default this registry cannot name is
      // REFUSED under a strict posture rather than assumed safe. (The
      // credential-derived kinds take the branch above, ADR-0167.)
      const { posture, allowList } = await loadCompiledEgressContext(db);
      const compiled = decideCompiledDefault({
        posture,
        surface: "connector",
        kind: connector.providerKind,
        defaultBaseUrl: connectorDefaultBaseUrl(connector.providerKind),
        allowList,
      });
      if (!compiled.ok) {
        await auditCompiledDefaultDenied(db, {
          userId,
          surface: "connector",
          objectId: connectorId,
          kind: connector.providerKind,
          decision: compiled,
          posture,
          detail: {
            connectorKind: connector.providerKind,
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
        });
        return out.status(403).send({
          decision,
          error: "egress_blocked",
          code: compiled.code,
          detail: `connector '${connector.name}': ${compiled.reason}`,
        });
      }
    }

    // Execute. A FAILED call (ConnectorProviderError) bills NOTHING and
    // surfaces as 502 — the same discipline as a failed model dispatch.
    const spent = await consumeHeld();
    if (spent) return spent;
    let result;
    try {
      if (!await generationCurrent()) throw new ConnectorPolicyChangedError();
      const admittedFetch: typeof fetch = connectorFetch ?? (async (input, init) => {
        await beforeConnectorSend();
        return fetch(input, init);
      });
      const provider = resolveConnectorProvider(
        { kind: connector.providerKind, baseUrl, token },
        admittedFetch as unknown as Parameters<typeof resolveConnectorProvider>[1],
      );
      result = await provider.invoke(effectiveInvocation);
    } catch (err) {
      if (err instanceof ConnectorPolicyChangedError || !await generationCurrent()) {
        policyChanged = true;
        return out.status(409).send(policyChangedBody());
      }
      // ADR-0034 amendment #2 — a refusal raised by the GUARDED FETCH itself
      // (the allow-list withdrawn between the pre-check and the request, or an
      // approved endpoint answering 302 -> IMDS) is a GOVERNANCE decision, not
      // an upstream failure. Without this it would surface as an opaque 500 or
      // be laundered into a 502 "the connector broke", hiding the one fact an
      // operator needs. `egressRefusal` digs it out of whatever the adapter
      // wrapped it in, exactly as the model paths do.
      const refusal = egressRefusal(err);
      if (refusal) {
        const reason = piiMode === "redact" ? "Connector destination refused by egress policy; upstream details withheld"
          : `connector '${connector.name}': ${refusal}`;
        await db.insert(auditLog).values({
          userId,
          objectType: "connector",
          objectId: connectorId,
          detail: {
            phase: "call",
            baseUrl,
            connectorKind: connector.providerKind,
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
          effect: "deny",
          ruleId: "connector-egress-blocked",
          ruleChain: [],
          reason,
        });
        return out.status(403).send({
          decision,
          error: "egress_blocked",
          detail: reason,
        });
      }
      if (piiMode === "redact") {
        return out.status(502).send({ error: "connector_invoke_failed", detail: "Connector call failed; upstream details withheld.",
          externalRequests, mayHaveExecuted: externalRequests > 0, retrySafe: externalRequests === 0 });
      }
      if (err instanceof ConnectorProviderError) {
        return out
          .status(502)
          .send({ decision, error: "connector_invoke_failed", detail: err.message });
      }
      throw err;
    }

    return db.transaction(async (evidenceDb) => {
      const [outputGeneration] = await evidenceDb.select().from(governancePolicyEpoch).for("share");
      // §8.4 OUTPUT check: the call ran, so a block is BILL-AND-WITHHOLD — the
      // usage row records honest spend, but result.body is replaced by the
      // withheld marker and the response is denial-shaped.
      let outputHits: PiiHit[] = [];
      let respBody = result.body;
      let withheld = false;
      let transformRefused = false;
      policyChanged = !admissionGeneration || outputGeneration?.epoch !== admissionGeneration.epoch;
      if (policyChanged) {
        withheld = true;
        respBody = "[WITHHELD: connector policy changed]";
      } else if (piiMode === "redact") {
        try {
          const transformed = redactPiiPayload(result.body ?? null, piiIntl);
          respBody = transformed.value;
          outputHits = transformed.hits;
        } catch {
          transformRefused = withheld = true;
          respBody = "[WITHHELD: connector output cannot be safely transformed]";
        }
      } else if (piiMode) {
        const chk = enforcePII(piiMode, { output: JSON.stringify(result.body ?? null) }, piiIntl);
        outputHits = chk.hits;
        if (chk.action === "block") {
          withheld = true;
          respBody = piiWithheldMarker(chk.hits);
        }
      }
      const anyHits = inputHits.length > 0 || outputHits.length > 0;
      const piiAction: "block" | "warn" | "log" | "redact" = withheld
        ? "block"
        : piiMode === "redact" ? "redact"
        : piiMode === "warn"
          ? "warn"
          : "log";
      const pii =
        piiMode && (anyHits || transformRefused)
          ? { mode: piiMode, action: piiAction, inputHits, outputHits, withheld }
          : null;

      // ADR-0042 OUTPUT phase, connector path — bill-and-withhold, same as PII.
      let cgOutput: ReturnType<typeof runGuardrails> | null = null;
      let cgWithheld = false;
      if (!policyChanged && !transformRefused && connectorGuardrails.active) {
        cgOutput = runGuardrails(connectorGuardrails, "output", JSON.stringify(result.body ?? null));
        if (piiMode === "redact") {
          const effectiveCheck = runGuardrails(connectorGuardrails, "output", JSON.stringify(respBody));
          const rank = { allow: 0, log: 1, warn: 2, block: 3 };
          if (rank[effectiveCheck.action] > rank[cgOutput.action]) cgOutput = effectiveCheck;
        }
        if (cgOutput.action === "block") {
          cgWithheld = true;
          respBody = guardrailWithheldMarker(cgOutput.blocking);
        }
      }
      const cgFindings = [...(cgInput?.findings ?? []), ...(cgOutput?.findings ?? [])];
      const connectorGuardrailView: DispatchGuardrails | null = cgFindings.length
        ? {
            action: cgWithheld ? "block" : cgFindings.some((f) => f.action === "warn") ? "warn" : "log",
            phase: cgWithheld ? "output" : cgInput?.findings.length ? "input" : "output",
            findings: flattenFindings(cgFindings),
            withheld: cgWithheld,
          }
        : null;

      // pillar 5 actuals: an allowed, executed call bills the connector's flat
      // list price. Unpriced → null, never an invented figure (agents' rule).
      const costUsd = connector.pricePerCallUsd ?? null;
      const [connectorUsageRow] = await evidenceDb.insert(usageEvents).values({
        userId,
        objectType: "connector",
        connectorId,
        operation: body.operation,
        costUsd,
        projectId,
        detail: {
          status: result.status,
          ...(!policyChanged && body.object ? { object: body.object } : {}),
          providerKind: connector.providerKind,
          ...(policyChanged ? { withheld: true, reason: "policy_changed" } : {}),
          ...(preparedPii ? { transformation: preparedPii.transformation, argumentsDigest: preparedPii.argumentsDigest,
            originalArgumentsDigest: preparedPii.originalArgumentsDigest, effectiveArgumentsDigest: preparedPii.effectiveArgumentsDigest } : {}),
          // §8.4 COUNTS ONLY — never the matched substrings
          ...(pii ? { pii: { mode: pii.mode, action: pii.action, inputHits, outputHits } } : {}),
          // ADR-0042 COUNTS ONLY, same contract
          ...(connectorGuardrailView
            ? {
                guardrails: {
                  action: connectorGuardrailView.action,
                  findings: connectorGuardrailView.findings,
                  withheld: cgWithheld,
                },
              }
            : {}),
        },
      }).returning({ id: usageEvents.id });
      // ADR-0070 — the span REFERENCES this row and copies its figure from it,
      // in the same call that inserted it. Never a recomputed price.
      sink.usageEventId = connectorUsageRow?.id ?? null;
      sink.costUsd = costUsd;
      if (cgOutput) {
        const outcome = guardrailOutcome(cgOutput);
        if (outcome) {
          await recordGuardrailDecision(evidenceDb, {
            userId,
            objectType: "connector",
            objectId: connectorId,
            projectId,
            evaluation: cgOutput,
            outcome,
            detail: { operation: body.operation, connectorKind: connector.providerKind },
          });
        }
      }
      // §8.4 audit rows for a PII event (never for a clean payload): an OUTPUT
      // block is a deny; a warn is an allow with 'pii-warned'; log is silent
      // (counts already recorded in the usage detail above).
      if (withheld) {
        await evidenceDb.insert(auditLog).values({
          userId,
          objectType: "connector",
          objectId: connectorId,
          detail: {
            phase: "pii",
            pii: { mode: piiMode, action: "block", phase: "output", inputHits, outputHits },
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
          effect: "deny",
          ruleId: policyChanged ? "connector-policy-changed" : transformRefused ? "pii-transform-refused" : "pii-blocked",
          ruleChain: [],
          reason: policyChanged ? "Connector policy changed; billed and withheld" : transformRefused
            ? "Connector output transformation refused; billed and withheld"
            : `output contains PII: ${piiCategoryList(outputHits)} — billed and withheld`,
        });
      } else if (piiMode === "warn" && anyHits) {
        await evidenceDb.insert(auditLog).values({
          userId,
          objectType: "connector",
          objectId: connectorId,
          detail: {
            phase: "pii",
            pii: { mode: piiMode, action: "warn", inputHits, outputHits },
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
          effect: "allow",
          ruleId: "pii-warned",
          ruleChain: [],
          reason: `PII detected (${piiCategoryList([...inputHits, ...outputHits])}) — warned, invoke proceeded`,
        });
      }

      if (policyChanged) return out.status(409).send(policyChangedBody());
      return out.send({
        decision,
        result: { status: result.status, body: respBody },
        costUsd,
        ...(pii ? { pii } : {}),
        ...(connectorGuardrailView ? { guardrails: connectorGuardrailView } : {}),
      });
    });
  };

  const ownTrace = args.trace === undefined;
  const traceCtx = !ownTrace ? (args.trace ?? null) : await beginTrace(db, {
    // a direct connector call is its own one-span trace, grouped by the
    // CONNECTOR as the session — the same idiom the MCP proxy uses for
    // `mcp:<serverId>`.
    kind: "tool",
    name: `connector ${connector.name}.${body.operation}`,
    userId,
    projectId,
    sessionId: `connector:${connectorId}`,
    rootRefId: connectorId,
  });
  const spanStartedAt = new Date();
  let outcome: ConnectorAttemptResult;
  try {
    outcome = await attempt(connectorReplyRecorder());
  } catch (err) {
    // An unexpected throw is still a thing that happened to a governed call.
    await recordSpan(db, traceCtx, {
      kind: "connector",
      name: `${connector.name}.${body.operation}`,
      status: "error",
      statusReason: "Connector call failed; details withheld",
      startedAt: spanStartedAt,
      connectorId,
      attributes: { operation: body.operation, ...(projectId ? { projectId } : {}) },
    });
    if (ownTrace) await finishTrace(db, traceCtx, "error", spanStartedAt);
    if (piiMode === "redact") return { status: 502, body: { error: "connector_invoke_failed", detail: "Connector call failed; details withheld." } };
    throw new Error("Connector call failed; details withheld");
  }

  await db.transaction(async (tx) => {
    // No network is inside this lock. Policy activation and content persistence
    // are ordered so a tightened policy cannot race a stale trace write.
    const [traceGeneration] = await tx.select().from(governancePolicyEpoch).for("share");
    if (!admissionGeneration || traceGeneration?.epoch !== admissionGeneration.epoch) {
      policyChanged = true;
      outcome = { status: 409, body: policyChangedBody() };
    }
    const errCode =
      typeof outcome.body["error"] === "string" ? (outcome.body["error"] as string) : null;
    const outDetail =
      typeof outcome.body["detail"] === "string" ? (outcome.body["detail"] as string) : null;
    const outDecision = outcome.body["decision"] as
      | { reason?: string; ruleId?: string }
      | undefined;
    // a held write (202) executed nothing: it traces as a refusal, not a success
    const held = outcome.status === 202 && typeof outcome.body["approvalId"] === "string";
    const spanStatus: "ok" | "denied" | "error" =
      held ? "denied" : outcome.status < 400 ? "ok" : outcome.status >= 500 ? "error" : "denied";
    // A refusal ABOUT the input does not store the input — storing the very
    // payload a block refused would defeat the block (ADR-0070 rule 3).
    const inputRefused = errCode === "pii_blocked" || errCode === "guardrail_blocked" || errCode === "pii_transform_refused";
    const resultBody = (outcome.body["result"] as { body?: unknown } | undefined)?.body;
    const withheld =
      inputRefused || policyChanged ||
      !!(outcome.body["pii"] as { withheld?: boolean } | undefined)?.withheld ||
      !!(outcome.body["guardrails"] as { withheld?: boolean } | undefined)?.withheld;
    await recordSpan(tx, traceCtx, {
      kind: "connector",
      name: `${connector.name}.${body.operation}`,
      status: spanStatus,
      statusReason: spanStatus === "ok" ? null : (outDetail ?? outDecision?.reason ?? errCode),
      startedAt: spanStartedAt,
      connectorId,
      // THE REFERENCE, and the figure copied from it in the same call.
      usageEventId: sink.usageEventId ?? null,
      costUsd: sink.costUsd ?? null,
      inputText: policyChanged ? null : inputRefused
        ? outDetail
        : JSON.stringify({ object: effectiveInvocation.object, payload: effectiveInvocation.payload }),
      // ALREADY-ADJUDICATED text: the withheld marker is already substituted.
      outputText: resultBody === undefined ? null : JSON.stringify(resultBody),
      contentWithheld: withheld,
      attributes: {
        operation: body.operation,
        httpStatus: outcome.status,
        ...(!policyChanged && !preparationFailed && body.object ? { object: body.object } : {}),
        ...(connector.providerKind ? { providerKind: connector.providerKind } : {}),
        ...(projectId ? { projectId } : {}),
        ...(errCode ? { error: errCode } : {}),
        ...(outDecision?.ruleId ? { ruleId: outDecision.ruleId } : {}),
        ...(held ? { approvalId: outcome.body["approvalId"] } : {}),
      },
    });
    if (ownTrace) await finishTrace(tx, traceCtx, spanStatus, spanStartedAt);
  });
  if (!await generationCurrent()) {
    await recordSpan(db, traceCtx, { kind: "connector", name: `${connector.name}.response-policy`,
      status: "denied", statusReason: "Connector policy changed before response release", startedAt: spanStartedAt,
      connectorId, contentWithheld: true, attributes: { operation: body.operation, error: "connector_policy_changed" } });
    if (ownTrace) await finishTrace(db, traceCtx, "denied", spanStartedAt);
    return { status: 409, body: policyChangedBody() };
  }
  return outcome;
}
