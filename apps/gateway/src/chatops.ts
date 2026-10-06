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
  escapeSlackText,
  parseChatInteraction,
  parseSlackEvent,
  parseSlackStepInteraction,
  parseTeamsBotActivity,
  parseTeamsMessage,
  CHATOPS_MAX_BODY_BYTES,
  SLACK_RETRY_NUM_HEADER,
  teamsActivityForCard,
  teamsActivityFreshness,
  outlookMessageForAlert,
  outlookMessageForCard,
  type OutlookMessagePayload,
  type ApprovalCard,
  verifyChatSignature,
  type ChatOpsProvider,
} from "@regulait/shared";
import {
  acceptInboundMessage,
  acceptStepInteraction,
  drainChannelWork,
  registerBuilderChannelRoutes,
  scheduleChannelWork,
  type ChannelDeps,
  type ChannelPoster,
  type InboundResult,
} from "./builder-channels.js";
import {
  ConnectorProviderError,
  OUTLOOK_DEFAULT_GRAPH_BASE_URL,
  parseOutlookCredential,
  resolveConnectorProvider,
  SlackConnectorProvider,
  SLACK_DEFAULT_BASE_URL,
  TEAMS_DEFAULT_BASE_URL,
} from "@regulait/connector-provider";
import { ConnectionEgressBlockedError, guardConnectionCall } from "./connection-egress.js";
import { EgressBlockedError } from "./egress-guard.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { projectPiiMode } from "./projects.js";
import { baseUrlFor } from "./mcp-auth-metadata.js";
import { verifyTeamsBotToken } from "./teams-bot-auth.js";
// ADR-0182 S5 (PF-14): the alert-SLA sweep posts through this file's courier
import { registerAlertSlaCourier } from "./alert-ownership.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** the courier's request to rewrite one of ITS OWN Slack messages: a symbol
 * key, so no JSON payload (a user's or an agent's) can ever carry one */
const OWN_MESSAGE_UPDATE: unique symbol = Symbol("own-message-update");
type OwnMessageUpdate = { [OWN_MESSAGE_UPDATE]: { ts: string; text: string; blocks?: Array<Record<string, unknown>> } };

/**
 * ADR-0113 — the chat providers this gateway can POST to. Deliberately a
 * SEPARATE list from `CHATOPS_PROVIDERS` (which is what we accept INBOUND):
 * inbound verification and outbound couriering are different capabilities and a
 * provider can honestly have one without the other, which is exactly the state
 * Teams was in between ADR-0061 and ADR-0113. Keeping the lists separate is
 * what stops the next inbound-only provider from being silently assumed
 * postable.
 *
 * ADR-0121 amendment (ADR-0183 batch 2.6): outlook joins — the SEND half only.
 * Its courier is a Microsoft Graph `sendMail` carrying the request summary and
 * the portal link; inbound stays `inbound_unsupported_by_design`.
 */
export const CHATOPS_OUTBOUND_PROVIDERS: readonly ChatOpsProvider[] = ["slack", "teams", "outlook"];

/** the providers a card is posted to as MAIL: no decide affordance, ever */
const MAIL_PROVIDERS: readonly ChatOpsProvider[] = ["outlook"];
/** an outlook "channel" is one recipient mailbox */
const mailboxSchema = z.string().email().max(200);

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
  /** ADR-0173 batch 2b — the Teams Bot Framework endpoint */
  botSettingsChanged: "chatops-bot-settings-changed",
  botRefusedTenant: "chatops-bot-refused-tenant",
  /** ADR-0173 batch 2b review — the Slack workspace pin */
  slackTeamChanged: "chatops-slack-team-changed",
  slackRefusedTeam: "chatops-slack-refused-team",
} as const;

/** ADR-0173 batch 2b review — the Slack workspace (team) a signed body came
 * from: `team_id` on an Events API envelope, `team.id` on an interaction
 * payload (form-encoded `payload=`). null when it names none. Pure. */
export function slackTeamIdOf(rawBody: string): string | null {
  const nonEmpty = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  try {
    const formPayload = rawBody.trimStart().startsWith("{") ? null : new URLSearchParams(rawBody).get("payload");
    const json = JSON.parse(formPayload ?? rawBody) as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return null;
    const team = json.team as Record<string, unknown> | undefined;
    return nonEmpty(json.team_id) ?? nonEmpty(team && typeof team === "object" ? team.id : null);
  } catch {
    return null;
  }
}

/** a Slack team id as Slack writes one (T… / E… for an org) */
const slackTeamIdField = z.string().trim().regex(/^[A-Z0-9]{2,40}$/, "a Slack team id, e.g. T0123ABCD").nullable().optional();

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

/** ADR-0173 batch 2b — a Teams workspace's registered bot */
const botFields = {
  /** the bot's app id: the audience its Bot Framework tokens must carry */
  botAppId: z.string().trim().min(1).max(200).nullable().optional(),
  /** optional: the one tenant whose activities are accepted */
  botTenantId: z.string().trim().min(1).max(200).nullable().optional(),
  /** optional: OpenID metadata naming the token issuer and JWKS (default: the platform's published document) */
  botOpenidMetadataUrl: z.string().trim().url().max(2000).nullable().optional(),
};

/** the bot settings must hang together: Teams only, and nothing without an app id */
function botSettingsProblem(
  provider: string,
  bot: { botAppId?: string | null | undefined; botTenantId?: string | null | undefined; botOpenidMetadataUrl?: string | null | undefined },
): { error: string; detail: string } | null {
  const any = !!(bot.botAppId || bot.botTenantId || bot.botOpenidMetadataUrl);
  if (any && provider !== "teams") {
    return { error: "bot_fields_teams_only", detail: "a Bot Framework app id, tenant and metadata URL apply to a teams workspace only" };
  }
  if ((bot.botTenantId || bot.botOpenidMetadataUrl) && !bot.botAppId) {
    return { error: "bot_app_id_required", detail: "the bot endpoint is off until an app id is set; set botAppId with the tenant or metadata URL" };
  }
  return null;
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
    ...botFields,
    /** ADR-0173 batch 2b review — optional, slack only: the one workspace accepted */
    slackTeamId: slackTeamIdField,
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

  /**
   * ADR-0173 batch 2b review — THE SLACK WORKSPACE PIN. A signing secret
   * belongs to a Slack APP, and one app can be installed in several
   * workspaces, so a valid signature proves "Slack sent this for our app", not
   * "from the workspace this connection serves". When an admin pinned a team,
   * a signed body naming another team (or none) is refused here — after the
   * signature (so only Slack itself can cause the audit row), before anything
   * is acted on.
   */
  const slackTeamRefusal = async (
    conn: typeof chatopsConnections.$inferSelect,
    rawBody: string,
    kind: "event" | "interaction",
  ): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    if (conn.provider !== "slack" || !conn.slackTeamId) return null;
    const teamId = slackTeamIdOf(rawBody);
    if (teamId === conn.slackTeamId) return null;
    await audit(null, "chatops_connection", conn.id, CHATOPS_RULE_IDS.slackRefusedTeam, "deny",
      `a signed Slack ${kind} on '${conn.name}' came from team '${teamId ?? "none"}', not the workspace's pinned team — nothing ran`,
      { teamId, expectedTeamId: conn.slackTeamId, kind });
    return { status: 403, body: { error: "team_not_allowed", detail: "this workspace accepts events and interactions from its pinned Slack team only" } };
  };

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
        // ADR-0162 — the alert threshold, so a saved selection survives reload
        notifyAlertMinSeverity: r.notifyAlertMinSeverity,
        createdAt: r.createdAt,
        // the signing secret is NEVER returned: a reader who could see it could
        // forge callbacks, which is strictly worse than reading a bot token
        // ADR-0121 — read from the column, not hard-coded: a send-only
        // outlook connection legitimately holds none, and reporting `true`
        // for it would assert a control that does not exist.
        signingSecretSet: r.signingSecretCiphertext !== null,
        // ADR-0179 (AER-015) — whether a card can be posted here at all. Every
        // registrable provider can since ADR-0183 2.6 gave outlook its sender;
        // false would mark a provider registered inbound-first.
        outboundSupported: CHATOPS_OUTBOUND_PROVIDERS.includes(r.provider as ChatOpsProvider),
        // ADR-0173 batch 2b — the Teams bot (identifiers, not secrets)
        botAppId: r.botAppId,
        botTenantId: r.botTenantId,
        botOpenidMetadataUrl: r.botOpenidMetadataUrl,
        botEndpoint: r.botAppId ? `/v1/chatops/${encodeURIComponent(r.name)}/bot` : null,
        slackTeamId: r.slackTeamId,
      })),
      posture:
        "The chat surface is a COURIER. Every decision goes through the same decide function the portal calls, " +
        "recorded against the mapped human — never the bot. Outbound posts pass the egress allow-list, so an " +
        "air-gapped deployment simply has no chat courier and the in-app queue is unaffected.",
    };
  });

  app.post("/v1/chatops/connections", async (req, reply) => {
    const body = createConnectionSchema.parse(req.body);
    // ADR-0179 (AER-015) — A WORKSPACE THAT CAN NEVER DELIVER A CARD IS REFUSED.
    //
    // A ChatOps workspace exists to carry approval cards out. Outlook was
    // registrable (ADR-0121, send-only) but no outbound sender exists for it, so
    // every card posted to one answered 501 `outbound_provider_unsupported` —
    // after the admin had registered it and been told it was connected. The
    // refusal now happens here, FIRST, before the connector or the data key is
    // looked at, because nothing else about the request can make it work.
    // Read from the outbound list rather than naming outlook, so it lifted the
    // day a sender landed (ADR-0183 2.6: outlook now sends). It stays as the
    // wall for any future provider registered inbound-first.
    if (!CHATOPS_OUTBOUND_PROVIDERS.includes(body.provider)) {
      return reply.status(422).send({
        error: "outbound_provider_unavailable",
        detail:
          `${body.provider} cannot be registered for ChatOps approval cards yet: there is no outbound sender for it, ` +
          `so a workspace registered now could never deliver a card. Inbound ${body.provider} stays refused by ` +
          `design (ADR-0121). Use slack or teams, or decide approvals in the portal.`,
      });
    }
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
    // ADR-0183 2.6 — AN OUTLOOK WORKSPACE IS REGISTERED ONLY WHEN IT CAN SEND.
    // Strict by default: the recipient must be one mailbox, a mail approval
    // can never be chat-decidable, and the connector must already hold the
    // app registration (tenant, client id, client secret, sender mailbox) in
    // the encrypted connector credential store — checked by parsing it, so a
    // workspace that would fail its first send is refused now, by name.
    if (body.provider === "outlook") {
      if (!mailboxSchema.safeParse(body.defaultChannel).success) {
        return reply.status(400).send({
          error: "invalid_recipient",
          detail: "an outlook workspace's default channel is the ONE mailbox approval mail is sent to (e.g. approvers@acme.com)",
        });
      }
      if (body.allowFencedDecide) {
        return reply.status(400).send({
          error: "fenced_decide_not_applicable",
          detail:
            "outlook carries no decision of any kind (ADR-0121): approvals are decided in the portal, so there is no " +
            "chat decide to allow for sensitive approvals",
        });
      }
      const [cred] = await db.select().from(connectorCredentials).where(eq(connectorCredentials.connectorId, connector.id));
      if (!cred) {
        return reply.status(400).send({
          error: "connector_credential_missing",
          detail:
            `connector '${connector.name}' holds no credential: set its app registration first ` +
            `({appId, appPassword, tenantId, senderUpn} — the client id, client secret, tenant and sender mailbox)`,
        });
      }
      try {
        parseOutlookCredential(decryptSecret(opts.dataKey, cred.tokenCiphertext));
      } catch (err) {
        if (err instanceof ConnectorProviderError) {
          return reply.status(400).send({ error: "invalid_connector_credential", detail: err.message });
        }
        throw err;
      }
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
    const botProblem = botSettingsProblem(body.provider, body);
    if (botProblem) return reply.status(400).send(botProblem);
    if (body.slackTeamId && body.provider !== "slack") {
      return reply.status(400).send({ error: "slack_team_slack_only", detail: "a Slack team id applies to a slack workspace only" });
    }
    // ADR-0173 batch 2b: a teams workspace reached only through its registered
    // bot verifies inbound tokens against the platform's keys, not a secret
    if (body.provider !== "outlook" && body.signingSecret === undefined && !(body.provider === "teams" && body.botAppId)) {
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
        botAppId: body.botAppId ?? null,
        botTenantId: body.botTenantId ?? null,
        botOpenidMetadataUrl: body.botOpenidMetadataUrl ?? null,
        slackTeamId: body.slackTeamId ?? null,
        createdByUserId: req.authCtx.userId ?? null,
      })
      .returning();
    await audit(req.authCtx.userId, "chatops_connection", row!.id, CHATOPS_RULE_IDS.connectionRegistered, "allow",
      `registered ${body.provider} ChatOps workspace '${body.name}' on connector '${connector.name}'${body.allowFencedDecide ? " WITH fenced-approval chat decide enabled" : ""}${body.botAppId ? " with its Bot Framework endpoint on" : ""}${body.slackTeamId ? ` pinned to Slack team ${body.slackTeamId}` : ""}`,
      {
        provider: body.provider,
        connectorId: body.connectorId,
        allowFencedDecide: body.allowFencedDecide,
        ...(body.botAppId ? { botAppId: body.botAppId, botTenantId: body.botTenantId ?? null, botOpenidMetadataUrl: body.botOpenidMetadataUrl ?? null } : {}),
        ...(body.slackTeamId ? { slackTeamId: body.slackTeamId } : {}),
      });
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
    /** ADR-0183 2.6: the mail an outlook workspace sends for this card; null =
     * this kind of card is not sent as mail (a decided card: outlook has no
     * inbound decision to retire) */
    mail: OutlookMessagePayload | null = null,
  ): Promise<{ ok: true; messageRef: string | null } | { ok: false; status: number; body: Record<string, unknown> }> {
    // The SAME composed card, rendered for the provider that will show it. The
    // fence decision is NOT re-taken here: `card.actions` is already empty when
    // `chatDecidable` said no, and both renderers read that one field. The mail
    // renderer reads no action at all (ADR-0121 §2).
    return postToChat(
      conn,
      channel,
      (provider) =>
        provider === "outlook"
          ? mail && { op: "sendMail", ...mail }
          : provider === "teams"
            ? { op: "conversations.sendToConversation", ...teamsActivityForCard(card) }
            : { op: "chat.postMessage", text: card.text, blocks: card.blocks },
      actorUserId,
      label,
    );
  }

  /**
   * THE ONE COURIER. Every chat post — an approval card, a decided card, a
   * governance alert, a builder agent's reply (ADR-0173) — goes through here:
   * the connector's own credential, the egress guard on every request URL, the
   * connector-provider adapter. `payloadFor` only shapes the provider's message
   * body; it cannot choose the destination host or skip the guard.
   */
  async function postToChat(
    conn: typeof chatopsConnections.$inferSelect,
    channel: string,
    payloadFor: (provider: "slack" | "teams" | "outlook") => Record<string, unknown> | OwnMessageUpdate | null,
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
      (conn.provider === "teams"
        ? TEAMS_DEFAULT_BASE_URL
        : conn.provider === "outlook"
          ? OUTLOOK_DEFAULT_GRAPH_BASE_URL
          : SLACK_DEFAULT_BASE_URL);
    const kind = conn.provider as "slack" | "teams" | "outlook";
    // an outlook "channel" is ONE recipient mailbox, whoever named it
    if (kind === "outlook" && !mailboxSchema.safeParse(channel).success) {
      return { ok: false, status: 400, body: { error: "invalid_recipient", detail: "an outlook message is sent to ONE mailbox address" } };
    }
    const payload = payloadFor(kind);
    if (payload === null) {
      return {
        ok: false,
        status: 501,
        body: {
          error: "message_kind_unsupported",
          detail: `this kind of message is not sent to ${conn.provider} workspaces ('${label}')`,
        },
      };
    }

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

    let provider;
    try {
      provider = resolveConnectorProvider(
        { kind, baseUrl, token },
        guarded.fetchImpl as unknown as Parameters<typeof resolveConnectorProvider>[1],
      );
    } catch (err) {
      // a credential the adapter cannot parse (ADR-0023 structured JSON):
      // its message names the shape, never the values
      if (err instanceof ConnectorProviderError) {
        return { ok: false, status: 400, body: { error: "invalid_connector_credential", detail: err.message } };
      }
      throw err;
    }

    let result;
    try {
      // ADR-0173 batch 2b review: rewriting one of OUR messages is not an
      // invoke() op (no governed connector call can reach it); the courier asks
      // for it with a symbol key no JSON payload can carry
      const own = (payload as Partial<OwnMessageUpdate>)[OWN_MESSAGE_UPDATE];
      if (own) {
        if (!(provider instanceof SlackConnectorProvider)) {
          return { ok: false, status: 501, body: { error: "message_update_unsupported", detail: `${conn.provider} messages are not rewritten in place` } };
        }
        result = await provider.updateOwnMessage({ channel, ...own });
      } else {
        result = await provider.invoke({ operation: "write", object: channel, payload: payload as Record<string, unknown> });
      }
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
              `chatops workspace '${conn.name}': ${err.decision.reason} (` +
              (conn.provider === "outlook"
                ? "an Outlook send reaches the Microsoft Entra login host as well as Microsoft Graph"
                : "a Teams post reaches the Microsoft Entra login host as well as the Bot Connector service host") +
              " — BOTH need an Egress Allow Hosts entry)",
          },
        };
      }
      // ADR-0183 2.6: a provider refusal (a bad client secret, Graph's 4xx, a
      // 429) is a named 502, not an opaque 500. The adapter's message names the
      // upstream's error code and description, never the credential.
      if (err instanceof ConnectorProviderError) {
        return {
          ok: false,
          status: 502,
          body: { error: "chatops_post_failed", upstreamStatus: err.status ?? null, detail: err.message },
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
    // Graph's sendMail answers 202 with no handle at all: outlook has none.
    const refField = conn.provider === "teams" ? "id" : conn.provider === "outlook" ? null : "ts";
    const messageRef = refField && typeof body[refField] === "string" ? (body[refField] as string) : null;
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
    const mail = MAIL_PROVIDERS.includes(conn.provider as ChatOpsProvider);
    // ADR-0121 §2: mail is never decidable, whatever the fence or the workspace says
    const decidable = !mail && chatDecidable({ fenced, allowFencedDecide: conn.allowFencedDecide });
    const [requester] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId));
    const [approver] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.approverUserId));

    const card = composeApprovalCard({
      approvalId,
      objectType: row.objectType,
      toolName: row.toolName,
      stageId: row.stageId,
      requesterLabel: requester?.email ?? null,
      approverLabel: approver?.email ?? null,
      // mail is read away from the portal, so it carries an ABSOLUTE link on the
      // origin this request reached the gateway on (`baseUrlFor`, the same
      // derivation the builder-channel links and SSO redirect URIs use — there
      // is no configured public URL). The link is the approval's page, never a
      // token: opening it means signing in.
      portalUrl: mail ? `${baseUrlFor(req)}/ui${portalUrl(approvalId)}` : portalUrl(approvalId),
      fenced,
      decidable,
    });

    const channel = body.channel ?? conn.defaultChannel;
    const posted = await postCard(conn, channel, card, req.authCtx.userId, "approval-mirror", mail ? outlookMessageForCard(card) : null);
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
      posted = await postCard(
        conn,
        channel,
        card,
        actorUserId,
        "monitor-alert",
        outlookMessageForAlert({
          severity: alert.severity,
          ruleLabel: (MONITOR_RULES as Record<string, { label: string }>)[alert.ruleId]?.label ?? alert.ruleId,
          title: alert.title,
          portalUrl: `/ui${alertPortalUrl(alert.id)}`,
        }),
      );
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

  // ADR-0182 S5 (PF-14): the SLA sweep's breach and unowned escalations, to
  // the same opted-in workspaces, with the sweep's own PII-free text in place
  // of the alert's title
  registerAlertSlaCourier(db, async (message, actorUserId) => {
    const out = { posted: 0, failed: 0 };
    const conns = await db
      .select()
      .from(chatopsConnections)
      .where(and(eq(chatopsConnections.enabled, true), isNotNull(chatopsConnections.notifyAlertMinSeverity)));
    const [alert] = conns.length ? await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, message.alertId)) : [];
    if (!alert) return out;
    for (const conn of conns) {
      if (!alertMeetsThreshold(message.severity, conn.notifyAlertMinSeverity)) continue;
      if (await postAlert({ ...alert, title: message.text }, conn, conn.defaultChannel, actorUserId)) out.posted += 1;
      else out.failed += 1;
    }
    return out;
  });

  /** opt a workspace in or out of alert delivery (admin) */
  app.patch("/v1/chatops/connections/:connectionId", async (req, reply) => {
    const { connectionId } = z.object({ connectionId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({ notifyAlertMinSeverity: z.enum(["medium", "high"]).nullable().optional(), ...botFields, slackTeamId: slackTeamIdField })
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: "nothing to change" })
      .parse(req.body);
    const [before] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.id, connectionId));
    if (!before) return reply.status(404).send({ error: "not_found" });
    if (body.slackTeamId && before.provider !== "slack") {
      return reply.status(400).send({ error: "slack_team_slack_only", detail: "a Slack team id applies to a slack workspace only" });
    }
    const botChange = body.botAppId !== undefined || body.botTenantId !== undefined || body.botOpenidMetadataUrl !== undefined;
    const bot = {
      botAppId: body.botAppId !== undefined ? body.botAppId : before.botAppId,
      botTenantId: body.botTenantId !== undefined ? body.botTenantId : before.botTenantId,
      botOpenidMetadataUrl: body.botOpenidMetadataUrl !== undefined ? body.botOpenidMetadataUrl : before.botOpenidMetadataUrl,
    };
    if (botChange) {
      const problem = botSettingsProblem(before.provider, bot);
      if (problem) return reply.status(400).send(problem);
      // switching the bot off must not leave a workspace that can be answered by nothing
      if (!bot.botAppId && before.signingSecretCiphertext === null && before.provider === "teams") {
        return reply.status(400).send({
          error: "signing_secret_required",
          detail: "this workspace has no signing secret, so its bot is its only inbound path; register a new workspace to change that",
        });
      }
    }
    const [after] = await db
      .update(chatopsConnections)
      .set({
        ...(body.notifyAlertMinSeverity !== undefined ? { notifyAlertMinSeverity: body.notifyAlertMinSeverity } : {}),
        ...(botChange ? bot : {}),
        ...(body.slackTeamId !== undefined ? { slackTeamId: body.slackTeamId } : {}),
      })
      .where(eq(chatopsConnections.id, connectionId))
      .returning();
    if (body.slackTeamId !== undefined) {
      await audit(req.authCtx.userId, "chatops_connection", connectionId, CHATOPS_RULE_IDS.slackTeamChanged, "allow",
        `Slack workspace pin on '${before.name}': ${before.slackTeamId ?? "any team"} → ${body.slackTeamId ?? "any team"}`,
        { from: before.slackTeamId, to: body.slackTeamId });
    }
    if (body.notifyAlertMinSeverity !== undefined) {
      await audit(req.authCtx.userId, "chatops_connection", connectionId, CHATOPS_RULE_IDS.alertSettingsChanged, "allow",
        `governance alerts to '${before.name}': ${before.notifyAlertMinSeverity ?? "off"} → ${body.notifyAlertMinSeverity ?? "off"}`,
        { from: before.notifyAlertMinSeverity, to: body.notifyAlertMinSeverity });
    }
    if (botChange) {
      await audit(req.authCtx.userId, "chatops_connection", connectionId, CHATOPS_RULE_IDS.botSettingsChanged, "allow",
        `Teams bot endpoint on '${before.name}': ${before.botAppId ? "on" : "off"} → ${bot.botAppId ? "on" : "off"}`,
        {
          from: { botAppId: before.botAppId, botTenantId: before.botTenantId, botOpenidMetadataUrl: before.botOpenidMetadataUrl },
          to: bot,
        });
    }
    return {
      id: after!.id,
      name: after!.name,
      notifyAlertMinSeverity: after!.notifyAlertMinSeverity,
      botAppId: after!.botAppId,
      botTenantId: after!.botTenantId,
      botOpenidMetadataUrl: after!.botOpenidMetadataUrl,
      slackTeamId: after!.slackTeamId,
    };
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
  // ADR-0173 §2 — builder agents over chat: the reply courier and the routes
  // =======================================================================

  /** a builder agent's reply, threaded under the message it answers. The text
   * is MODEL OUTPUT, so it is rendered inert for the platform: Slack gets its
   * control characters escaped (no `<!channel>`, `<@U…>` or disguised
   * `<url|label>` link can be produced), Teams gets it as plain text (no
   * markdown/HTML rendering, so no disguised link; a Teams mention needs an
   * `entities` entry, which this never sends). */
  const postBuilderReply: ChannelPoster = (conn, input, actorUserId, label) =>
    postToChat(
      conn,
      input.target,
      (provider) =>
        // outlook has no inbound conversation to reply into (ADR-0121)
        provider === "outlook"
          ? null
          : provider === "teams"
            ? input.threadRef
              ? { op: "conversations.replyToActivity", text: input.text, textFormat: "plain", replyToId: input.threadRef }
              : { op: "conversations.sendToConversation", text: input.text, textFormat: "plain" }
            : input.updateRef
              ? // ADR-0173 batch 2b: an answered "Ask first" message is
                // rewritten in place, through the courier-only update
                ({
                  [OWN_MESSAGE_UPDATE]: {
                    ts: input.updateRef,
                    text: escapeSlackText(input.text),
                    ...(input.blocks ? { blocks: input.blocks } : {}),
                  },
                } satisfies OwnMessageUpdate)
              : {
                  // an "Ask first" pause carries Block Kit buttons (composed
                  // inert in shared)
                  op: "chat.postMessage",
                  text: escapeSlackText(input.text),
                  ...(input.blocks ? { blocks: input.blocks } : {}),
                  ...(input.threadRef ? { thread_ts: input.threadRef } : {}),
                },
      actorUserId,
      label,
    );
  const channelDeps: ChannelDeps = { dataKey: opts.dataKey, post: postBuilderReply, log: app.log };
  // the routes, and the ONE subscriber that posts a resumed channel turn back
  registerBuilderChannelRoutes(app, db, channelDeps);
  // a closing app waits for the turns it already acknowledged
  app.addHook("onClose", async () => drainChannelWork(db));

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

      // ---- the workspace pin (batch 2b review), before anything is acted on
      const offTeam = await slackTeamRefusal(conn, rawBody, "interaction");
      if (offTeam) return reply.status(offTeam.status).send(offTeam.body);

      // ---- ADR-0173 batch 2b: an "Ask first" button, not an approval card --
      // The same first walls (above) proved the platform. A step click is NOT
      // an approval decision: it is answered by the thread's own person, and
      // builder-channels.ts runs the rest (identity link, thread person,
      // fence, claim once, then the web route's confirm logic).
      if (conn.provider === "slack") {
        const click = parseSlackStepInteraction(rawBody);
        if (click) {
          const answered = await acceptStepInteraction(db, channelDeps, conn, click);
          if (answered.work) scheduleChannelWork(db, answered.work, app.log);
          return reply.status(answered.ack.status).send(answered.ack.body);
        }
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

    // =====================================================================
    // ADR-0173 §2 — INBOUND CONVERSATIONS to builder agents.
    //
    // The same first walls as the interaction callback, in the same order and
    // with the same cheapness rule: an unknown/disabled/send-only workspace and
    // an unverifiable body are refused with a bare 401 before any write or any
    // audit row. Everything after the platform is proved — de-duplication,
    // routing, identity, visibility, the turn and the reply — lives in
    // builder-channels.ts, and the turn runs AFTER the response.
    // =====================================================================

    type Verified = { conn: typeof chatopsConnections.$inferSelect; rawBody: string; headers: Record<string, string | undefined> };
    const verifyInbound = async (
      connectionName: string,
      provider: "slack" | "teams",
      rawBodyIn: unknown,
      rawHeaders: Record<string, string | string[] | undefined>,
    ): Promise<{ ok: true; v: Verified } | { ok: false; code?: string }> => {
      const [conn] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, connectionName));
      // unknown, disabled, no data key, or a workspace of another provider:
      // one indistinguishable 401, so a prober learns nothing
      if (!conn || !conn.enabled || !opts.dataKey || conn.provider !== provider) return { ok: false };
      // WALL 0 — no secret, no inbound (ADR-0121); refused before any decrypt
      if (conn.signingSecretCiphertext === null) return { ok: false, code: "inbound_unsupported_by_design" };
      const rawBody = typeof rawBodyIn === "string" ? rawBodyIn : "";
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      // WALL 1 — signature (+ Slack's signed-timestamp replay window)
      const sig = verifyChatSignature({
        provider,
        rawBody,
        headers,
        signingSecret: decryptSecret(opts.dataKey, conn.signingSecretCiphertext),
        nowSeconds: now(),
      });
      if (!sig.ok) return { ok: false, code: sig.code };
      return { ok: true, v: { conn, rawBody, headers } };
    };

    const run = (result: InboundResult) => {
      if (result.work) scheduleChannelWork(db, result.work, app.log);
      return result.ack;
    };

    scope.post("/v1/chatops/:connectionName/events", async (req, reply) => {
      const { connectionName } = z.object({ connectionName: z.string().min(1).max(200) }).parse(req.params);
      const checked = await verifyInbound(connectionName, "slack", req.body, req.headers);
      if (!checked.ok) return reply.status(401).send({ error: "unauthenticated", ...(checked.code ? { code: checked.code } : {}) });
      const { conn, rawBody, headers } = checked.v;

      // WALL 2 — parse; unreadable is refused, never guessed
      const parsed = parseSlackEvent(rawBody);
      if (!parsed) return reply.status(400).send({ error: "unreadable_event" });
      // Slack's handshake when the Events URL is saved — signed like any event
      if (parsed.kind === "url_verification") return reply.status(200).send({ challenge: parsed.challenge });
      // the workspace pin (batch 2b review): the handshake above names no
      // team and runs nothing; every event after it must be the pinned team's
      const offTeam = await slackTeamRefusal(conn, rawBody, "event");
      if (offTeam) return reply.status(offTeam.status).send(offTeam.body);
      if (parsed.kind === "ignored") return reply.status(200).send({ ok: true, ignored: parsed.reason });

      const retryRaw = headers[SLACK_RETRY_NUM_HEADER];
      const retryNum = retryRaw && /^\d{1,4}$/.test(retryRaw) ? Number(retryRaw) : null;
      const ack = run(await acceptInboundMessage(db, channelDeps, conn, parsed.message, retryNum, baseUrlFor(req)));
      return reply.status(ack.status).send(ack.body);
    });

    scope.post("/v1/chatops/:connectionName/messages", async (req, reply) => {
      const { connectionName } = z.object({ connectionName: z.string().min(1).max(200) }).parse(req.params);
      const checked = await verifyInbound(connectionName, "teams", req.body, req.headers);
      if (!checked.ok) return reply.status(401).send({ error: "unauthenticated", ...(checked.code ? { code: checked.code } : {}) });
      const { conn, rawBody } = checked.v;

      const parsed = parseTeamsMessage(rawBody);
      if (!parsed) return reply.status(400).send({ error: "unreadable_message" });
      // THE TEAMS REPLAY GUARD: the HMAC covers the body and the body carries
      // the activity's timestamp, so a captured message re-sent after the
      // window is refused here; one re-sent inside it is caught by the
      // activity-id de-duplication record in builder-channels.ts.
      const fresh = teamsActivityFreshness(parsed.timestamp, now());
      if (!fresh.ok) return reply.status(401).send({ error: "unauthenticated", code: fresh.code });

      const ack = run(await acceptInboundMessage(db, channelDeps, conn, parsed.message, null, baseUrlFor(req)));
      return reply.status(ack.status).send(ack.body);
    });

    // =====================================================================
    // ADR-0173 batch 2b — THE TEAMS BOT FRAMEWORK ENDPOINT.
    //
    // A registered bot (the workspace's `bot_app_id`) beside the outgoing
    // webhook. The platform is proved by the Bearer JWT the Bot Framework
    // sends — issuer and keys from the configured OpenID metadata, audience =
    // the app id, expiry, and the token's `serviceUrl` = the activity's
    // (teams-bot-auth.ts, on `jose`). Every refusal up to there is a bare 401
    // with no write and no audit row, the same cheapness rule as the HMAC
    // routes. After it, the tenant pin, then routing and identity exactly as
    // for an outgoing-webhook message; the reply goes out through the courier
    // (the Bot Framework ignores a response body).
    // =====================================================================
    scope.post("/v1/chatops/:connectionName/bot", async (req, reply) => {
      const { connectionName } = z.object({ connectionName: z.string().min(1).max(200) }).parse(req.params);
      const [conn] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, connectionName));
      // unknown, disabled, not teams, no bot registered, no data key: one 401
      if (!conn || !conn.enabled || conn.provider !== "teams" || !conn.botAppId || !opts.dataKey) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      if (!authorization) return reply.status(401).send({ error: "unauthenticated", code: "missing_token" });
      const rawBody = typeof req.body === "string" ? req.body : "";
      if (Buffer.byteLength(rawBody, "utf8") > CHATOPS_MAX_BODY_BYTES) {
        return reply.status(401).send({ error: "unauthenticated", code: "body_too_large" });
      }
      // the token is bound to the activity (its serviceUrl), so the body is
      // read first — but an unreadable one is refused like a bad token
      const activity = parseTeamsBotActivity(rawBody);
      if (!activity) return reply.status(401).send({ error: "unauthenticated", code: "unreadable_activity" });
      const verified = await verifyTeamsBotToken(db, {
        authorization,
        appId: conn.botAppId,
        metadataUrl: conn.botOpenidMetadataUrl,
        connectorId: conn.connectorId,
        connectionName: conn.name,
        activity: { serviceUrl: activity.serviceUrl, channelId: activity.channelId },
      });
      if (!verified.ok) return reply.status(401).send({ error: "unauthenticated", code: verified.code });

      // the platform is proved: from here on a refusal is audited
      if (conn.botTenantId && activity.tenantId !== conn.botTenantId) {
        await audit(null, "chatops_connection", conn.id, CHATOPS_RULE_IDS.botRefusedTenant, "deny",
          `a Teams bot activity on '${conn.name}' came from tenant '${activity.tenantId ?? "none"}', not the workspace's pinned tenant — nothing ran`,
          { tenantId: activity.tenantId, expectedTenantId: conn.botTenantId });
        return reply.status(403).send({ error: "tenant_not_allowed", detail: "this bot accepts activities from its pinned tenant only" });
      }
      if (activity.kind === "ignored") return reply.status(200).send({ ok: true, ignored: activity.reason });
      const ack = run(await acceptInboundMessage(db, channelDeps, conn, activity.message, null, baseUrlFor(req), "courier"));
      return reply.status(ack.status).send(ack.body);
    });
  });
}
