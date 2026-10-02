/**
 * ADR-0061 — CHATOPS APPROVALS, the gateway half.
 *
 *   `packages/shared/src/chatops.ts`  signature verification + the replay
 *                                      window, strict interaction parsing, the
 *                                      sensitivity fence, card composition.
 *                                      Pure — no db, no clock, no network.
 *   THIS FILE                          the workspace + identity-link admin API,
 *                                      the guarded outbound post, and the
 *                                      inbound callback.
 *   `app.ts`                           owns `decideOneApproval`. THIS FILE DOES
 *                                      NOT DECIDE ANYTHING. It calls that one
 *                                      function, exactly as the portal route
 *                                      and the bulk endpoint do.
 *
 * THE FIVE WALLS AN INBOUND CALLBACK PASSES, IN ORDER
 * ---------------------------------------------------
 *  1. **SIGNATURE + REPLAY WINDOW.** Proves the request came from the chat
 *     provider. It says NOTHING about who clicked. Refusal here costs one
 *     indexed connection read and no transaction, no audit write and no
 *     approval read — ADR-0061 is explicit that a flood of forged payloads must
 *     be cheap to reject, and an audit row per forged packet would itself be the
 *     amplification. (Auditing starts at wall 3, where the caller has proved it
 *     is the workspace.)
 *  2. **PARSE.** The payload yields a chat user id, an opaque approval id and
 *     approve/reject — or it yields nothing and is refused. Never guessed at.
 *  3. **MAP.** The chat user id is an ASSERTION. It becomes a RegulAIt human
 *     only through the admin-managed `chat_identity_links` row. An unmapped chat
 *     identity is refused AND AUDITED — the bot never becomes the actor.
 *  4. **SENSITIVITY.** An approval whose project is in PII mode `block` is
 *     in-app only unless the admin opted this workspace in. A chat tap is not a
 *     re-authenticated session and we do not pretend it is.
 *  5. **THE ONE DECIDE PATH.** `decideOne` — the identical function the portal
 *     calls — re-checks named-approver / delegation / admin-override /
 *     self-review / superseded / already-decided server-side, for the mapped
 *     human. Chat cannot be the weaker path because chat runs no checks of its
 *     own; it runs THAT function.
 *
 * WHY THERE IS NO `isAdmin: true` ANYWHERE ON THE INBOUND PATH
 * -----------------------------------------------------------
 * `decideOne` takes `isAdmin`, and passing `true` would let any mapped chat user
 * decide any approval through the admin-override branch. The inbound route
 * passes the MAPPED USER'S OWN `users.is_admin` and nothing else, so a chat
 * decision has exactly the authority that human has in the portal — no more.
 *
 * OUTBOUND IS EGRESS, AND IS GUARDED LIKE EGRESS
 * ----------------------------------------------
 * Posting an approval card to Slack is an outbound request carrying governance
 * content to a third party — precisely the exfiltration shape ADR-0034 exists
 * for. So the destination is validated against the admin egress allow-list and
 * the request is made through `createGuardedFetch` (via `guardConnectionCall`),
 * on EVERY post, with no vendor-default exemption: `slack.com` must be
 * explicitly allow-listed. That is stricter than the ordinary connector-invoke
 * path, deliberately. In an air-gapped deployment there is no allow entry, the
 * post is refused, and ChatOps degrades to in-app only — §8.5's behaviour
 * arriving from the guard rather than from a mode flag.
 *
 * THE BOT TOKEN IS NOT A NEW SECRET STORE. `chatops_connections.connector_id`
 * points at an ordinary connector whose ordinary `connector_credentials` row
 * holds it, and `resolveConnectorProvider` does the posting — the same adapter,
 * the same encrypted-at-rest discipline, the same error envelope. Only the
 * INBOUND signing secret is new, because the connector machinery models
 * credentials we present, not ones we verify with.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  approvals,
  asc,
  auditLog,
  chatIdentityLinks,
  chatopsConnections,
  chatopsInteractions,
  chatopsMessages,
  connectorCredentials,
  connectors,
  desc,
  eq,
  governanceAlerts,
  inArray,
  isNotNull,
  oidcProviders,
  samlProviders,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  CHATOPS_PROVIDERS,
  MONITOR_RULES,
  alertMeetsThreshold,
  composeAlertCard,
  chatContentFenced,
  chatDecidable,
  composeApprovalCard,
  composeDecidedCard,
  parseChatInteraction,
  teamsActivityForCard,
  type ApprovalCard,
  verifyChatSignature,
  type ChatOpsProvider,
} from "@regulait/shared";
import {
  resolveConnectorProvider,
  SLACK_DEFAULT_BASE_URL,
  TEAMS_DEFAULT_BASE_URL,
} from "@regulait/connector-provider";
import { ConnectionEgressBlockedError, guardConnectionCall } from "./connection-egress.js";
import { EgressBlockedError } from "./egress-guard.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { projectPiiMode } from "./projects.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * ADR-0113 — the chat providers this gateway can POST to. Deliberately a
 * SEPARATE list from `CHATOPS_PROVIDERS` (which is what we accept INBOUND):
 * inbound verification and outbound couriering are different capabilities and a
 * provider can honestly have one without the other, which is exactly the state
 * Teams was in between ADR-0061 and ADR-0113. Keeping the lists separate is
 * what stops the next inbound-only provider from being silently assumed
 * postable.
 */
export const CHATOPS_OUTBOUND_PROVIDERS: readonly ChatOpsProvider[] = ["slack", "teams"];

/** stable rule ids — the strings an operator greps the audit log for */
export const CHATOPS_RULE_IDS = {
  connectionRegistered: "chatops-connection-registered",
  connectionDeleted: "chatops-connection-deleted",
  identityLinked: "chatops-identity-linked",
  identityUnlinked: "chatops-identity-unlinked",
  approvalPosted: "chatops-approval-posted",
  postRefusedEgress: "chatops-post-refused-egress",
  decideRefusedUnmapped: "chatops-decide-refused-unmapped-identity",
  decideRefusedSensitivity: "chatops-decide-refused-sensitivity-fence",
  decideRefusedByDecidePath: "chatops-decide-refused-by-decide-path",
  decided: "chatops-decided",
  decideIdempotentReplay: "chatops-decide-idempotent-replay",
  /** ADR-0162 */
  alertPosted: "chatops-alert-posted",
  alertPostFailed: "chatops-alert-post-failed",
  alertSettingsChanged: "chatops-alert-settings-changed",
} as const;

/**
 * ADR-0162 — the governance monitor reaches chat through the ONE guarded
 * courier this file owns. `registerChatOpsRoutes` registers a notifier per
 * database handle; the monitor (route or scheduler — both run on the same
 * handle) calls `notifyGovernanceAlerts` with the ids it just RAISED. A
 * deployment that never registered ChatOps simply notifies nobody.
 */
export type AlertNotifier = (alertIds: string[], actorUserId: string | null) => Promise<{ posted: number; failed: number }>;
const alertNotifiers = new WeakMap<object, AlertNotifier>();
export async function notifyGovernanceAlerts(db: Db, alertIds: string[], actorUserId: string | null) {
  const notify = alertNotifiers.get(db as object);
  if (!notify || alertIds.length === 0) return { posted: 0, failed: 0 };
  return notify(alertIds, actorUserId);
}

/** the ONE decide function, handed in by app.ts. Chat never gets its own. */
export type DecideOne = (input: {
  approvalId: string;
  deciderUserId: string | null;
  isAdmin: boolean;
  body: { decision: "approved" | "denied"; reason?: string };
}) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }>;

export interface ChatOpsRouteOptions {
  decideOne: DecideOne;
  dataKey?: string;
}

const createConnectionSchema = z
  .object({
    name: z.string().min(1).max(200),
    provider: z.enum(CHATOPS_PROVIDERS),
    connectorId: z.string().uuid(),
    /** ADR-0121 — OPTIONAL on the wire, and conditionally required below.
     * Slack and teams must carry one (it verifies their inbound callbacks);
     * outlook must NOT (it has no inbound path, so a secret here would be a
     * field that looks like a security control and verifies nothing). */
    signingSecret: z.string().min(8).max(500).optional(),
    defaultChannel: z.string().min(1).max(200),
    allowFencedDecide: z.boolean().default(false),
    /** ADR-0162 — opt-in; null/absent = governance alerts are not posted here */
    notifyAlertMinSeverity: z.enum(["medium", "high"]).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

const linkSchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    chatUserId: z.string().min(1).max(200),
    /** the email the binding is made THROUGH — it must name an existing user */
    email: z.string().min(3).max(320),
  })
  .strict();

const postSchema = z.object({ connectionName: z.string().min(1).max(200).optional(), channel: z.string().max(200).optional() }).strict();

export function registerChatOpsRoutes(app: FastifyInstance, db: Db, opts: ChatOpsRouteOptions): void {
  // The clock is NOT injectable. The replay window is exercised by signing a
  // genuinely old timestamp, so the suite proves the real wall rather than a
  // test seam that could be true while the shipped path is not.
  const now = () => Math.floor(Date.now() / 1000);

  const audit = (
    actorUserId: string | null,
    objectType: "chatops_connection" | "chat_identity_link" | "workflow" | "mcp_tool",
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType,
      objectId,
      detail: { subsystem: "chatops", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  const portalUrl = (approvalId: string) => `/admin/review-workbench?approval=${approvalId}`;

  // =======================================================================
  // Admin: the workspace
  // =======================================================================

  app.get("/v1/chatops/connections", async () => {
    const rows = await db.select().from(chatopsConnections);
    return {
      connections: rows.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        connectorId: r.connectorId,
        defaultChannel: r.defaultChannel,
        allowFencedDecide: r.allowFencedDecide,
        enabled: r.enabled,
        createdAt: r.createdAt,
        // the signing secret is NEVER returned: a reader who could see it could
        // forge callbacks, which is strictly worse than reading a bot token
        // ADR-0121 — read from the column, not hard-coded: a send-only
        // outlook connection legitimately holds none, and reporting `true`
        // for it would assert a control that does not exist.
        signingSecretSet: r.signingSecretCiphertext !== null,
      })),
      posture:
        "The chat surface is a COURIER. Every decision goes through the same decide function the portal calls, " +
        "recorded against the mapped human — never the bot. Outbound posts pass the egress allow-list, so an " +
        "air-gapped deployment simply has no chat courier and the in-app queue is unaffected.",
    };
  });

  app.post("/v1/chatops/connections", async (req, reply) => {
    const body = createConnectionSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(400).send({
        error: "data_key_required",
        detail: "REGULAIT_DATA_KEY must be set: the inbound signing secret is stored encrypted, never in plaintext",
      });
    }
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, body.connectorId));
    if (!connector) return reply.status(400).send({ error: "invalid_reference", detail: "connectorId names no connector" });
    // the OUTBOUND credential must already live in the ordinary connector store
    if (connector.providerKind !== body.provider) {
      return reply.status(400).send({
        error: "connector_kind_mismatch",
        detail: `connector '${connector.name}' has providerKind '${connector.providerKind ?? "null"}', not '${body.provider}' — ChatOps posts through the existing connector adapter and its existing credential`,
      });
    }
    // ADR-0121 — THE SIGNING SECRET IS PER-PROVIDER, AND BOTH DIRECTIONS ARE
    // REFUSED RATHER THAN QUIETLY TOLERATED.
    //
    // Missing on slack/teams would register a workspace whose callbacks can
    // never be verified — a courier that can post and can never be answered.
    // Supplied on outlook is the more interesting error: it means the operator
    // believes there is an inbound path to secure. There is not, by decision,
    // so the refusal names the decision instead of storing the secret and
    // letting them find out when no reply is ever acted on.
    if (body.provider === "outlook" && body.signingSecret !== undefined) {
      return reply.status(400).send({
        error: "signing_secret_not_applicable",
        detail:
          "outlook is send-only: a signing secret verifies an INBOUND callback's HMAC and outlook has no " +
          "inbound path — an email is an unauthenticated assertion, not a signed callback. Register it with " +
          "no signing secret; approvals are decided from the portal link the message carries.",
      });
    }
    if (body.provider !== "outlook" && body.signingSecret === undefined) {
      return reply.status(400).send({
        error: "signing_secret_required",
        detail: `${body.provider} callbacks are HMAC-verified against this secret — registering without one would create a workspace that can post and can never be answered`,
      });
    }

    const [row] = await db
      .insert(chatopsConnections)
      .values({
        name: body.name,
        provider: body.provider,
        connectorId: body.connectorId,
        signingSecretCiphertext:
          body.signingSecret === undefined ? null : encryptSecret(opts.dataKey, body.signingSecret),
        defaultChannel: body.defaultChannel,
        allowFencedDecide: body.allowFencedDecide,
        notifyAlertMinSeverity: body.notifyAlertMinSeverity ?? null,
        enabled: body.enabled,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(req.authCtx.userId, "chatops_connection", row!.id, CHATOPS_RULE_IDS.connectionRegistered, "allow",
      `registered ${body.provider} ChatOps workspace '${body.name}' on connector '${connector.name}'${body.allowFencedDecide ? " WITH fenced-approval chat decide enabled" : ""}`,
      { provider: body.provider, connectorId: body.connectorId, allowFencedDecide: body.allowFencedDecide });
    return reply.status(201).send({ id: row!.id, name: row!.name, provider: row!.provider });
  });

  app.delete("/v1/chatops/connections/:connectionId", async (req, reply) => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(chatopsConnections).where(eq(chatopsConnections.id, connectionId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_connection" });
    await audit(req.authCtx.userId, "chatops_connection", connectionId, CHATOPS_RULE_IDS.connectionDeleted, "allow",
      `removed ChatOps workspace '${row.name}' — its identity links and posted-message records go with it`, { provider: row.provider });
    return { deleted: true, id: connectionId };
  });

  // =======================================================================
  // Admin: the identity link — the trust artifact
  // =======================================================================

  app.get("/v1/chatops/identity-links", async () => {
    const rows = await db
      .select({
        id: chatIdentityLinks.id,
        connectionId: chatIdentityLinks.connectionId,
        chatUserId: chatIdentityLinks.chatUserId,
        chatUserEmail: chatIdentityLinks.chatUserEmail,
        userId: chatIdentityLinks.userId,
        emailVerifiedSource: chatIdentityLinks.emailVerifiedSource,
        createdAt: chatIdentityLinks.createdAt,
      })
      .from(chatIdentityLinks);
    return {
      links: rows,
      posture:
        "A chat user id is an ASSERTION delivered by the bot's connection. It becomes a RegulAIt human only through " +
        "one of these admin-created rows. `emailVerifiedSource: admin_asserted` means this deployment had no " +
        "federated identity to bind to — visibly weaker than `idp`, rather than a verification we did not perform.",
    };
  });

  app.post("/v1/chatops/identity-links", async (req, reply) => {
    const body = linkSchema.parse(req.body);
    const [conn] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, body.connectionName));
    if (!conn) return reply.status(400).send({ error: "invalid_reference", detail: "connectionName names no ChatOps workspace" });
    const email = body.email.trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    // AN ADMIN MAY BIND AN EXISTING PRINCIPAL, NEVER INVENT ONE. No JIT user
    // creation here: a chat workspace must not be a way to mint RegulAIt users.
    if (!user) {
      return reply.status(400).send({
        error: "unknown_user",
        detail: "the email must name an existing RegulAIt user — a chat identity link binds an existing principal, it never creates one",
      });
    }
    if (user.disabledAt) {
      return reply.status(422).send({ error: "user_disabled", detail: "a disabled user cannot be bound to a chat identity" });
    }
    // the honesty column: what did this deployment actually verify?
    const [oidcEnabled] = await db.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true)).limit(1);
    const [samlEnabled] = await db.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true)).limit(1);
    const verifiedSource = user.scimExternalId ? "scim" : oidcEnabled || samlEnabled ? "idp" : "admin_asserted";

    const [row] = await db
      .insert(chatIdentityLinks)
      .values({
        connectionId: conn.id,
        chatUserId: body.chatUserId,
        chatUserEmail: email,
        userId: user.id,
        emailVerifiedSource: verifiedSource,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      return reply.status(409).send({
        error: "identity_link_exists",
        detail:
          "this chat identity, or this user, is already linked on this workspace — one chat identity maps to one human and one human is reachable through one chat identity, or 'who decided?' would have two answers",
      });
    }
    await audit(req.authCtx.userId, "chat_identity_link", row.id, CHATOPS_RULE_IDS.identityLinked, "allow",
      `bound ${conn.provider} identity '${body.chatUserId}' to RegulAIt user ${email} (verification: ${verifiedSource})`,
      { connectionId: conn.id, chatUserId: body.chatUserId, userId: user.id, emailVerifiedSource: verifiedSource });
    return reply.status(201).send({ id: row.id, userId: user.id, emailVerifiedSource: verifiedSource });
  });

  app.delete("/v1/chatops/identity-links/:linkId", async (req, reply) => {
    const { linkId } = z.object({ linkId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(chatIdentityLinks).where(eq(chatIdentityLinks.id, linkId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_link" });
    await audit(req.authCtx.userId, "chat_identity_link", linkId, CHATOPS_RULE_IDS.identityUnlinked, "allow",
      `removed the chat identity link for '${row.chatUserId}' — that chat identity can no longer decide anything`,
      { chatUserId: row.chatUserId, userId: row.userId });
    return { deleted: true, id: linkId };
  });

  // =======================================================================
  // Outbound: the courier post
  // =======================================================================

  /** the sensitivity context for one approval: the fence, and whether an admin
   * has opted this workspace into deciding fenced approvals from chat */
  async function fenceFor(approvalRow: typeof approvals.$inferSelect): Promise<boolean> {
    let projectId = approvalRow.projectId ?? null;
    if (!projectId && approvalRow.instanceId) {
      const [inst] = await db
        .select({ projectId: workflowInstances.projectId })
        .from(workflowInstances)
        .where(eq(workflowInstances.id, approvalRow.instanceId));
      projectId = inst?.projectId ?? null;
    }
    return chatContentFenced(await projectPiiMode(db, projectId));
  }

  async function postCard(
    conn: typeof chatopsConnections.$inferSelect,
    channel: string,
    card: ApprovalCard,
    actorUserId: string | null,
    label: string,
  ): Promise<{ ok: true; messageRef: string | null } | { ok: false; status: number; body: Record<string, unknown> }> {
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, conn.connectorId));
    if (!connector) return { ok: false, status: 400, body: { error: "invalid_reference", detail: "the ChatOps connector was deleted" } };
    // ADR-0113 — TEAMS OUTBOUND EXISTS NOW. `connector-provider` grew a real
    // Bot Framework Connector adapter, so the courier routes through the
    // RESOLVED provider for the connection's own provider rather than assuming
    // Slack. THE GUARD IS NOT WEAKENED: a provider ChatOps has no outbound
    // adapter for still refuses loudly here rather than silently posting
    // nothing — this is a widened allow-list, not a pass-through.
    if (!CHATOPS_OUTBOUND_PROVIDERS.includes(conn.provider as ChatOpsProvider)) {
      return {
        ok: false,
        status: 501,
        body: {
          error: "outbound_provider_unsupported",
          detail:
            `connector-provider has no outbound adapter for '${conn.provider}', so its cards cannot be posted. ` +
            `Inbound callbacks for a verified provider ARE verified and decided; only the outbound courier is missing.`,
        },
      };
    }
    const [cred] = await db.select().from(connectorCredentials).where(eq(connectorCredentials.connectorId, conn.connectorId));
    const token = cred && opts.dataKey ? decryptSecret(opts.dataKey, cred.tokenCiphertext) : null;
    if (!cred || !token) {
      return { ok: false, status: 400, body: { error: "connector_credential_missing", detail: "the ChatOps connector has no decryptable bot token" } };
    }
    const baseUrl =
      cred.baseUrl ??
      connector.baseUrl ??
      (conn.provider === "teams" ? TEAMS_DEFAULT_BASE_URL : SLACK_DEFAULT_BASE_URL);

    // EVERY post is guarded — no vendor-default exemption. Posting approval
    // content to a third party is exactly the shape ADR-0034 exists for, so
    // `slack.com` has to be an explicit allow entry. In an air-gapped install
    // there is none and the courier is simply absent.
    let guarded;
    try {
      guarded = await guardConnectionCall(db, {
        surface: "connector",
        baseUrl,
        userId: actorUserId,
        objectId: conn.connectorId,
        label: `chatops workspace '${conn.name}' (${conn.provider})`,
        detail: { chatopsConnection: conn.name, purpose: label },
      });
    } catch (err) {
      if (err instanceof ConnectionEgressBlockedError) {
        await audit(actorUserId, "chatops_connection", conn.id, CHATOPS_RULE_IDS.postRefusedEgress, "deny",
          `ChatOps post to '${conn.name}' refused by the egress guard: ${err.decision.reason}`,
          { code: err.decision.code, baseUrl });
        return {
          ok: false,
          status: 403,
          body: {
            error: "egress_blocked",
            code: err.decision.code,
            detail: `chatops workspace '${conn.name}': ${err.decision.reason} (an admin adds permitted destinations under Egress Allow Hosts)`,
          },
        };
      }
      throw err;
    }

    const provider = resolveConnectorProvider(
      { kind: conn.provider as "slack" | "teams", baseUrl, token },
      guarded.fetchImpl as unknown as Parameters<typeof resolveConnectorProvider>[1],
    );

    // The SAME composed card, rendered for the provider that will show it. The
    // fence decision is NOT re-taken here: `card.actions` is already empty when
    // `chatDecidable` said no, and both renderers read that one field.
    const payload =
      conn.provider === "teams"
        ? { op: "conversations.sendToConversation", ...teamsActivityForCard(card) }
        : { op: "chat.postMessage", text: card.text, blocks: card.blocks };

    let result;
    try {
      result = await provider.invoke({ operation: "write", object: channel, payload });
    } catch (err) {
      // ADR-0113: a Teams post touches TWO hosts — the Entra login host and the
      // Bot Connector service host — and `guarded.fetchImpl` re-adjudicates
      // every request URL, so the SECOND host can be refused after the first
      // was permitted. That refusal arrives here as an EgressBlockedError from
      // inside the adapter rather than from `guardConnectionCall` above, and it
      // must become the same honest 403, not an opaque 500.
      if (err instanceof EgressBlockedError) {
        await audit(actorUserId, "chatops_connection", conn.id, CHATOPS_RULE_IDS.postRefusedEgress, "deny",
          `ChatOps post to '${conn.name}' refused by the egress guard mid-call: ${err.decision.reason}`,
          { code: err.decision.code, baseUrl, phase: "adapter" });
        return {
          ok: false,
          status: 403,
          body: {
            error: "egress_blocked",
            code: err.decision.code,
            detail:
              `chatops workspace '${conn.name}': ${err.decision.reason} (a Teams post reaches the Microsoft Entra ` +
              `login host as well as the Bot Connector service host — BOTH need an Egress Allow Hosts entry)`,
          },
        };
      }
      throw err;
    }
    const body = (result.body ?? {}) as Record<string, unknown>;
    // Slack returns `{ok, ts}`; the Bot Connector returns a ResourceResponse
    // `{id}`. Both are "the handle this message is known by", which is what
    // `chatops_messages.message_ref` stores — but the field is read PER
    // PROVIDER rather than by a `ts ?? id` fallback, so a response that happens
    // to carry both cannot silently make one provider read the other's handle.
    const refField = conn.provider === "teams" ? "id" : "ts";
    const messageRef = typeof body[refField] === "string" ? (body[refField] as string) : null;
    return { ok: true, messageRef };
  }

  app.post("/v1/chatops/approvals/:approvalId/post", async (req, reply) => {
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = postSchema.parse(req.body ?? {});
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return reply.status(404).send({ error: "unknown_approval" });

    const [conn] = body.connectionName
      ? await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, body.connectionName))
      : // ADR-0107 (F01): `chatops_connections` is UNIQUE on `name`, not on
        // `enabled` — a deployment may have Slack and Teams both switched on.
        // Unordered, WHICH CHAT WORKSPACE an approval card was posted into was
        // arbitrary, and an approver could find the card in a different place
        // on two identical mirrors. Oldest-created wins: the first connection a
        // deployment configured is its default destination, and an operator who
        // wants another one names it explicitly (the branch above).
        await db
          .select()
          .from(chatopsConnections)
          .where(eq(chatopsConnections.enabled, true))
          .orderBy(asc(chatopsConnections.createdAt), asc(chatopsConnections.id))
          .limit(1);
    if (!conn) return reply.status(400).send({ error: "no_chatops_connection" });
    if (!conn.enabled) return reply.status(422).send({ error: "connection_disabled" });

    const fenced = await fenceFor(row);
    const decidable = chatDecidable({ fenced, allowFencedDecide: conn.allowFencedDecide });
    const [requester] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
    const [approver] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.approverUserId));

    const card = composeApprovalCard({
      approvalId,
      objectType: row.objectType,
      toolName: row.toolName,
      stageId: row.stageId,
      requesterLabel: requester?.email ?? null,
      approverLabel: approver?.email ?? null,
      portalUrl: portalUrl(approvalId),
      fenced,
      decidable,
    });

    const channel = body.channel ?? conn.defaultChannel;
    const posted = await postCard(conn, channel, card, req.authCtx.userId, "approval-mirror");
    if (!posted.ok) return reply.status(posted.status).send(posted.body);

    const [msg] = await db
      .insert(chatopsMessages)
      .values({ connectionId: conn.id, approvalId, channel, messageRef: posted.messageRef, redacted: card.redacted, decidable })
      .returning();
    await audit(req.authCtx.userId, "chatops_connection", conn.id, CHATOPS_RULE_IDS.approvalPosted, "allow",
      `approval ${approvalId} mirrored to ${conn.provider} channel ${channel}${card.redacted ? " with its CONTENT WITHHELD (sensitivity fence): a link was posted, not the payload" : ""}${decidable ? "" : " and WITHOUT decide buttons (in-app only)"}`,
      { approvalId, channel, redacted: card.redacted, decidable });
    return { messageId: msg!.id, redacted: card.redacted, decidable, messageRef: posted.messageRef };
  });

  // =======================================================================
  // ADR-0162 — governance-monitor alerts to chat (information only)
  // =======================================================================

  const alertPortalUrl = (alertId: string) => `/admin/governance/alerts?alert=${alertId}`;

  async function postAlert(
    alert: typeof governanceAlerts.$inferSelect,
    conn: typeof chatopsConnections.$inferSelect,
    channel: string,
    actorUserId: string | null,
  ): Promise<boolean> {
    const card = composeAlertCard({
      alertId: alert.id,
      severity: alert.severity,
      ruleLabel: (MONITOR_RULES as Record<string, { label: string }>)[alert.ruleId]?.label ?? alert.ruleId,
      title: alert.title,
      portalUrl: alertPortalUrl(alert.id),
    });
    let posted: Awaited<ReturnType<typeof postCard>>;
    try {
      posted = await postCard(conn, channel, card, actorUserId, "monitor-alert");
    } catch (err) {
      posted = { ok: false, status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    await audit(
      actorUserId,
      "chatops_connection",
      conn.id,
      posted.ok ? CHATOPS_RULE_IDS.alertPosted : CHATOPS_RULE_IDS.alertPostFailed,
      posted.ok ? "allow" : "deny",
      posted.ok
        ? `governance alert ${alert.id} (${alert.severity}) posted to ${conn.provider} channel ${channel}`
        : `governance alert ${alert.id} NOT posted to '${conn.name}': ${String(posted.body.error ?? posted.status)}`,
      { alertId: alert.id, ruleId: alert.ruleId, severity: alert.severity, channel, ...(posted.ok ? {} : { status: posted.status }) },
    );
    return posted.ok;
  }

  alertNotifiers.set(db as object, async (alertIds, actorUserId) => {
    const out = { posted: 0, failed: 0 };
    const conns = await db
      .select()
      .from(chatopsConnections)
      .where(and(eq(chatopsConnections.enabled, true), isNotNull(chatopsConnections.notifyAlertMinSeverity)));
    if (conns.length === 0) return out;
    const alerts = await db.select().from(governanceAlerts).where(inArray(governanceAlerts.id, alertIds));
    for (const alert of alerts) {
      for (const conn of conns) {
        if (!alertMeetsThreshold(alert.severity, conn.notifyAlertMinSeverity)) continue;
        if (await postAlert(alert, conn, conn.defaultChannel, actorUserId)) out.posted += 1;
        else out.failed += 1;
      }
    }
    return out;
  });

  /** opt a workspace in or out of alert delivery (admin) */
  app.patch("/v1/chatops/connections/:connectionId", async (req, reply) => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(req.params);
    const body = z.object({ notifyAlertMinSeverity: z.enum(["medium", "high"]).nullable() }).strict().parse(req.body);
    const [before] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.id, connectionId));
    if (!before) return reply.status(404).send({ error: "not_found" });
    const [after] = await db
      .update(chatopsConnections)
      .set({ notifyAlertMinSeverity: body.notifyAlertMinSeverity })
      .where(eq(chatopsConnections.id, connectionId))
      .returning();
    await audit(req.authCtx.userId, "chatops_connection", connectionId, CHATOPS_RULE_IDS.alertSettingsChanged, "allow",
      `governance alerts to '${before.name}': ${before.notifyAlertMinSeverity ?? "off"} → ${body.notifyAlertMinSeverity ?? "off"}`,
      { from: before.notifyAlertMinSeverity, to: body.notifyAlertMinSeverity });
    return { id: after!.id, name: after!.name, notifyAlertMinSeverity: after!.notifyAlertMinSeverity };
  });

  /** post one alert now, regardless of the threshold (admin) */
  app.post("/v1/governance/alerts/:alertId/post", async (req, reply) => {
    const { alertId } = z.object({ alertId: z.string().uuid() }).parse(req.params);
    const body = postSchema.parse(req.body ?? {});
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, alertId));
    if (!alert) return reply.status(404).send({ error: "not_found" });
    const [conn] = body.connectionName
      ? await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, body.connectionName))
      : await db
          .select()
          .from(chatopsConnections)
          .where(eq(chatopsConnections.enabled, true))
          .orderBy(asc(chatopsConnections.createdAt), asc(chatopsConnections.id))
          .limit(1);
    if (!conn) return reply.status(400).send({ error: "no_chatops_connection" });
    if (!conn.enabled) return reply.status(422).send({ error: "connection_disabled" });
    const ok = await postAlert(alert, conn, body.channel ?? conn.defaultChannel, req.authCtx.userId);
    if (!ok) return reply.status(502).send({ error: "post_failed", detail: "see the chatops-alert-post-failed audit row" });
    return { posted: true, connection: conn.name, channel: body.channel ?? conn.defaultChannel };
  });

  // =======================================================================
  // Inbound: the callback. THE COURIER DELIVERS A REQUEST, NOT A DECISION.
  // =======================================================================

  app.register(async (scope) => {
    // HMAC verification needs the EXACT raw bytes. This route — and only this
    // route — swaps the JSON parser for a raw-string capture, exactly as the PM
    // webhook does. Global JSON parsing is untouched.
    const keepRaw = (_req: unknown, raw: string, done: (err: Error | null, result?: unknown) => void) => done(null, raw);
    scope.addContentTypeParser("application/json", { parseAs: "string" }, keepRaw);
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, keepRaw);
    scope.addContentTypeParser("*", { parseAs: "string" }, keepRaw);

    scope.post("/v1/chatops/:connectionName/interactions", async (req, reply) => {
      const { connectionName } = z.object({ connectionName: z.string().min(1).max(200) }).parse(req.params);
      const [conn] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, connectionName));
      // an unknown or disabled workspace, and a deployment with no data key,
      // all answer the same 401: an unauthenticated prober learns nothing about
      // which workspaces exist
      if (!conn || !conn.enabled || !opts.dataKey) return reply.status(401).send({ error: "unauthenticated" });

      const rawBody = typeof req.body === "string" ? req.body : "";
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;

      // ---- WALL 0: a provider with no inbound path is refused HERE ---------
      // ADR-0121. This is ordered before the decrypt for two reasons, and the
      // second is the load-bearing one:
      //
      //  - a send-only connection holds NO signing secret (it is null by DB
      //    check), so decrypting first would throw on a public, unauthenticated
      //    route and turn a designed refusal into a 500;
      //  - refusing before any cryptographic work is the same cheapness rule
      //    WALL 1 keeps: an unsolicited packet aimed at this path must cost us
      //    nothing.
      //
      // The 401 matches every other unverifiable inbound, so a prober still
      // learns nothing about which workspaces exist or what kind they are.
      if (conn.provider === "outlook" || conn.signingSecretCiphertext === null) {
        return reply.status(401).send({ error: "unauthenticated", code: "inbound_unsupported_by_design" });
      }

      // ---- WALL 1: signature + replay window, before ANY other work --------
      const signingSecret = decryptSecret(opts.dataKey, conn.signingSecretCiphertext);
      const sig = verifyChatSignature({
        provider: conn.provider as ChatOpsProvider,
        rawBody,
        headers,
        signingSecret,
        nowSeconds: now(),
      });
      if (!sig.ok) {
        // NO audit row and NO db write: an unsigned or replayed packet must be
        // cheap to reject, and one audit insert per forged packet would be the
        // amplification ADR-0061's rate-limiting clause warns about. The refusal
        // is still visible — it is an HTTP 401 on a public route behind the
        // ordinary rate limiter (ADR-0031).
        return reply.status(401).send({ error: "unauthenticated", code: sig.code });
      }

      // ---- WALL 2: parse. An unreadable payload is refused, never guessed ---
      const interaction = parseChatInteraction(conn.provider as ChatOpsProvider, rawBody);
      if (!interaction) return reply.status(400).send({ error: "unreadable_interaction" });

      // ---- WALL 3: MAP. The chat user id is an assertion. -------------------
      const [link] = await db
        .select()
        .from(chatIdentityLinks)
        .where(and(eq(chatIdentityLinks.connectionId, conn.id), eq(chatIdentityLinks.chatUserId, interaction.chatUserId)));
      if (!link) {
        await audit(null, "chat_identity_link", null, CHATOPS_RULE_IDS.decideRefusedUnmapped, "deny",
          `${conn.provider} identity '${interaction.chatUserId}' attempted to ${interaction.action} approval ${interaction.approvalId} but maps to no RegulAIt user — the courier delivered the request, the server denied the authority`,
          { chatUserId: interaction.chatUserId, approvalId: interaction.approvalId, action: interaction.action, connection: conn.name });
        return reply.status(403).send({
          error: "unmapped_chat_identity",
          detail: "this chat identity is not linked to a RegulAIt user; an admin must create the link before it can decide anything",
        });
      }
      const [decider] = await db.select().from(users).where(eq(users.id, link.userId));
      if (!decider || decider.disabledAt) {
        await audit(link.userId, "chat_identity_link", link.id, CHATOPS_RULE_IDS.decideRefusedUnmapped, "deny",
          `${conn.provider} identity '${interaction.chatUserId}' maps to a disabled or missing RegulAIt user — refused`,
          { chatUserId: interaction.chatUserId, approvalId: interaction.approvalId });
        return reply.status(403).send({ error: "unmapped_chat_identity" });
      }

      // ---- IDEMPOTENCY: has this identity already decided this, this way? ---
      const [prior] = await db
        .select()
        .from(chatopsInteractions)
        .where(
          and(
            eq(chatopsInteractions.connectionId, conn.id),
            eq(chatopsInteractions.approvalId, interaction.approvalId),
            eq(chatopsInteractions.chatUserId, interaction.chatUserId),
            eq(chatopsInteractions.action, interaction.action),
          ),
        );
      if (prior) {
        // A DOUBLE-CLICK IS A NO-OP. Not a second decide (the status machine
        // already prevents that) and not a second AUDIT ROW, which is the part
        // the status machine does not cover.
        return reply.status(200).send({
          ok: true,
          idempotent: true,
          outcome: prior.outcome,
          decidedBy: prior.decidedByUserId,
          detail: "this interaction was already processed; the approval was not decided again",
        });
      }

      const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, interaction.approvalId));
      if (!approvalRow) return reply.status(404).send({ error: "unknown_approval" });

      // ---- WALL 4: SENSITIVITY. A chat tap is not a re-authenticated session.
      const fenced = await fenceFor(approvalRow);
      if (!chatDecidable({ fenced, allowFencedDecide: conn.allowFencedDecide })) {
        await audit(decider.id, "chat_identity_link", link.id, CHATOPS_RULE_IDS.decideRefusedSensitivity, "deny",
          `${decider.email} attempted to ${interaction.action} approval ${interaction.approvalId} from ${conn.provider}, but this approval's compliance classification makes it in-app only — a chat tap is not a re-authenticated session`,
          { approvalId: interaction.approvalId, chatUserId: interaction.chatUserId, fenced: true });
        return reply.status(403).send({
          error: "chat_decide_not_permitted_for_sensitivity",
          detail: "this approval must be decided in the portal; its project's compliance classification blocks chat decisions",
        });
      }

      // ---- WALL 5: THE ONE DECIDE PATH ------------------------------------
      // Not "the same checks" — literally the same function the portal route
      // calls, with the mapped human's OWN admin flag. Chat cannot be weaker
      // because chat runs no checks of its own.
      const outcome = await opts.decideOne({
        approvalId: interaction.approvalId,
        deciderUserId: decider.id,
        isAdmin: decider.isAdmin,
        body: {
          decision: interaction.action === "approve" ? "approved" : "denied",
          reason: `decided via ${conn.provider} (ChatOps) by the mapped RegulAIt user`,
        },
      });

      if (!outcome.ok) {
        await audit(decider.id, "chat_identity_link", link.id, CHATOPS_RULE_IDS.decideRefusedByDecidePath, "deny",
          `${decider.email} attempted to ${interaction.action} approval ${interaction.approvalId} from ${conn.provider} and the one decide path refused it: ${String(outcome.body.error ?? "refused")}`,
          { approvalId: interaction.approvalId, chatUserId: interaction.chatUserId, refusal: outcome.body });
        return reply.status(outcome.status).send(outcome.body);
      }

      await db.insert(chatopsInteractions).values({
        connectionId: conn.id,
        approvalId: interaction.approvalId,
        chatUserId: interaction.chatUserId,
        action: interaction.action,
        decidedByUserId: decider.id,
        outcome: "decided",
        detail: { messageRef: interaction.messageRef, channel: interaction.channel },
      });
      await audit(decider.id, "chat_identity_link", link.id, CHATOPS_RULE_IDS.decided, "allow",
        `approval ${interaction.approvalId} ${interaction.action === "approve" ? "approved" : "denied"} from ${conn.provider} by ${decider.email} — recorded against the human, never the bot`,
        { approvalId: interaction.approvalId, chatUserId: interaction.chatUserId, decidedBy: decider.id });

      // retire the card. A post failure never unwinds a durable decision — it
      // is reported, exactly as the PM mirror failure is.
      let cardUpdate: string | null = null;
      const [msg] = await db
        .select()
        .from(chatopsMessages)
        .where(eq(chatopsMessages.approvalId, interaction.approvalId))
        .orderBy(desc(chatopsMessages.postedAt))
        .limit(1);
      if (msg) {
        try {
          const decided = composeDecidedCard({
            approvalId: interaction.approvalId,
            decision: interaction.action === "approve" ? "approved" : "denied",
            deciderLabel: decider.displayName || decider.email,
            portalUrl: portalUrl(interaction.approvalId),
          });
          const res = await postCard(conn, msg.channel, decided, decider.id, "decision-retire");
          if (res.ok) {
            await db.update(chatopsMessages).set({ retiredAt: new Date() }).where(eq(chatopsMessages.id, msg.id));
          } else {
            cardUpdate = String(res.body.error ?? "post_failed");
          }
        } catch (err) {
          cardUpdate = err instanceof Error ? err.message : String(err);
        }
      }

      return {
        ok: true,
        approval: outcome.body,
        decidedBy: decider.id,
        via: conn.provider,
        ...(cardUpdate ? { cardUpdateError: cardUpdate } : {}),
      };
    });
  });
}
