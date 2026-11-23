/**
 * ADR-0334 (lane E16): THE MANAGED BROWSER EXTENSION'S GATEWAY ROUTES.
 *
 * STRICT DEFAULT (ADR-0180). Nothing works until an admin turns browser governance on, which is a `settings_relax`
 * step-up (audited). While it is off every extension route refuses `browser_governance_disabled`, and an extension
 * with no valid policy blocks every governed site (it fails closed on its own side too).
 *
 * The extension channel (bodies at most 64 KiB). The device is a workload identity of kind `browser_extension`, the
 * endpoint agent's pattern (ADR-0195 SD4b): S6 binds its key, S7 mints its DPoP-bound self token at the token
 * endpoint, and the shared OAuth layer verifies that token, its DPoP proof (one-use `jti`, the gateway nonce) and the
 * device on every request before a handler runs; the route ceiling keeps the token to the three routes below.
 *   POST /v1/browser-extension/register         auth-exempt: the bulk enrolment token (`rgbe_`, SHA-256); capped
 *   POST /v1/browser-extension/policy           self token; answers the signed per-user policy (EdDSA JWS)
 *   POST /v1/browser-extension/events           self token; policy breaches (codes and ids, never prompt text)
 *   POST /v1/browser-extension/prompt-captures  self token; only while prompt capture is on (a step-up relaxation)
 * Every refusal is a fixed code and is audited with ids and the code only.
 *
 * Admin routes (the default admin gate; relaxations are step-ups, every write audited):
 *   GET  /v1/browser-governance                            settings and the policy key's public half
 *   PUT  /v1/browser-governance/settings                   on/off, enforce/audit, prompt capture
 *   GET  /v1/browser-governance/sites                      the catalogue sites and their rules
 *   PUT  /v1/browser-governance/sites/:siteId              allow (a step-up) or deny, with account domains
 *   POST /v1/browser-governance/enrolment-tokens           issue (capped, at most 30 days; shown once)
 *   GET  /v1/browser-governance/enrolment-tokens           list (never the token)
 *   POST /v1/browser-governance/enrolment-tokens/:tokenId/revoke
 *   GET  /v1/browser-governance/devices
 *   POST /v1/browser-governance/devices/:deviceId/revoke
 *   GET  /v1/browser-governance/events                     breach events, pseudonymous
 *   GET  /v1/browser-governance/prompt-captures/:captureId one captured prompt (a `pseudonym_reveal` step-up, audited)
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  browserDevices,
  browserEnrolmentTokens,
  browserEvents,
  browserGovernanceSettings,
  browserPromptCaptures,
  browserSiteAccountDomains,
  browserSiteRules,
  eq,
  getTableColumns,
  runWithRlsSystem,
  sql,
  users,
  workloadIdentities,
  type BrowserDeviceRow,
  type BrowserGovernanceSettingsRow,
  type Db,
} from "@regulait/db";
import {
  BROWSER_ENROLMENT_TOKEN_MAX_DAYS,
  BROWSER_ENROLMENT_TOKEN_MAX_DEVICES,
  BROWSER_ENROLMENT_TOKEN_PREFIX,
  BROWSER_ENROLMENT_TOKEN_RE,
  BROWSER_EXTENSION_PATHS,
  BROWSER_REQUEST_MAX_BYTES,
  BROWSER_SITE_CATALOGUE,
  BROWSER_SITE_CATALOGUE_IDS,
  BROWSER_CAPTURE_RETENTION_DEFAULT_DAYS,
  BROWSER_CAPTURE_RETENTION_MAX_DAYS,
  BROWSER_CAPTURE_RETENTION_MIN_DAYS,
  BROWSER_DEVICE_MACHINE,
  BROWSER_ENROLMENT_TOKEN_MACHINE,
  browserClientTimeAcceptable,
  browserDeviceState,
  browserEventsRequestSchema,
  enrolmentTokenState,
  ENROLMENT_TOKEN_STATE_REFUSAL,
  browserPolicyRequestSchema,
  browserPromptCaptureRequestSchema,
  browserRegisterRequestSchema,
  type BrowserRefusalCode,
  defaultWorkloadIdentifier,
  JWK_THUMBPRINT_URI_PREFIX,
  type WorkloadPublicJwk,
} from "@regulait/shared";
import {
  buildBrowserPolicy,
  conversationRef,
} from "./browser-governance.js";
import { asDeviceIdentity, nameDeviceIdentity } from "./browser-device.js";
import { databaseNow } from "./db-clock.js";
import { DEVICE_POLICY_KEY_FILE_ENV, resolveDevicePolicySigner, signDevicePolicy } from "./device-policy-signer.js";
import { pseudonymise, pseudonymKey } from "./discovery-worker.js";
import { resolveExecutionPosture } from "./execution-posture.js";
import { keyRegistered, prepareRunnerKey, runnerKeyThumbprint } from "./engine-runner-keys.js";
import { resolveTrustDomain } from "./in-process-delegation.js";
import { deploymentEnvironment, identityIssuer } from "./oauth/common.js";
import { bindPreparedCredentialTx, IdentityAdminError } from "./oauth/identity-admin.js";
import { INSTALL_SECRETS_DIR_ENV } from "./receipt-signing-key.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import type { ListSpec } from "./list-contract.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import { settingTransitions } from "./setting-transitions.js";
import { checkStepUp, requireStepUp, type StepUpCheckArgs } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;


const refuse = (reply: FastifyReply, status: number, error: BrowserRefusalCode) => reply.status(status).send({ error });

async function audit(
  db: Db,
  actor: string,
  objectId: string | null,
  ruleId: string,
  effect: "allow" | "deny",
  reason: string,
  detail: Record<string, unknown>,
  id?: string,
): Promise<void> {
  await db.insert(auditLog).values({
    ...(id ? { id } : {}),
    userId: actor,
    objectType: "browser_governance",
    objectId,
    detail: { subsystem: "browser-governance", adr: "0334", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the register route's scope: a request carrying a (well-formed) enrolment token is a non-user credential request */
const asEnrolment = <T>(fn: () => Promise<T>): Promise<T> => runWithRlsSystem("credential_request", "browser-extension.register", fn);

async function loadSettings(db: Db): Promise<BrowserGovernanceSettingsRow> {
  const [row] = await db.select().from(browserGovernanceSettings).where(eq(browserGovernanceSettings.id, 1));
  // the migration inserts the row; a missing row reads as the strict default
  return row ?? { id: 1, enabled: false, mode: "enforce", promptCaptureEnabled: false, promptCaptureRetentionDays: BROWSER_CAPTURE_RETENTION_DEFAULT_DAYS, updatedBy: null, updatedAt: new Date(0) };
}

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const v = h.slice("Bearer ".length);
  return BROWSER_ENROLMENT_TOKEN_RE.test(v) ? v : null;
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** the raw body as JSON, or undefined (an unparseable body is never echoed) */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body) || body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** the org user a profile account names (case-insensitive email), or null; never created here */
async function userForEmail(db: Db, email: string): Promise<{ id: string; disabled: boolean } | null> {
  if (!email) return null;
  const [u] = await db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return u ? { id: u.id, disabled: u.disabledAt !== null } : null;
}

export function registerBrowserGovernanceRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  // pseudonyms, conversation refs and captured text are all keyed by the data key: without one nothing is accepted
  const dataKey = opts.dataKey ?? "";
  const subjectOf = async (email: string) => (email ? await pseudonymise(db, dataKey, "device_user", email.toLowerCase()) : "");

  // ---- the extension channel: raw bodies (a proof covers the exact bytes) -----------------------------------------
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: BROWSER_REQUEST_MAX_BYTES }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: { code?: string }, _req, reply) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") return refuse(reply, 413, "body_too_large");
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") return refuse(reply, 415, "invalid_body");
      throw err;
    });

    const deny = (objectId: string | null, code: BrowserRefusalCode, route: string) =>
      audit(db, NIL_UUID, objectId, "browser-extension-refused", "deny", `a browser extension request was refused: ${code} (ADR-0334)`, { code, route });
    /**
     * #1030: a registration refused before any enrolment token is known (no token, an unknown one, a malformed body)
     * comes from an unauthenticated caller, so it must not cost one audit row each. The first refusal of each code in a
     * minute is written; the rest of that minute are counted and written as one summary row when it ends.
     */
    const unauthenticatedRefusals = new RefusalCoalescer((code, route, suppressed, windowStartedAt) =>
      audit(db, NIL_UUID, null, "browser-extension-refused", "deny", `${suppressed} further unauthenticated browser extension request(s) were refused: ${code}, counted rather than written one by one (ADR-0334, #1030)`, {
        code,
        route,
        coalesced: true,
        suppressed,
        windowStartedAt: new Date(windowStartedAt).toISOString(),
      }).catch(() => undefined),
    );
    const denyUnauthenticated = async (code: BrowserRefusalCode, route: string) => {
      if (unauthenticatedRefusals.admit(code, route, Date.now())) await deny(null, code, route);
    };

    // -- registration (once per install) ------------------------------------------------------------------------
    // The key becomes a workload identity of kind `browser_extension` through S6's binding path (one key, one identity,
    // ever), exactly as the endpoint agent's registration does (ADR-0195 SD4b). Its later requests carry an S7
    // DPoP-bound self token, verified by the shared OAuth layer before these handlers run.
    scope.post(BROWSER_EXTENSION_PATHS.register, async (req, reply) => {
      const route = "register";
      const token = bearerToken(req);
      if (!token) {
        await denyUnauthenticated("invalid_token", route);
        return refuse(reply, 401, "invalid_token");
      }
      const settings = await asEnrolment(() => loadSettings(db));
      if (!settings.enabled) {
        await denyUnauthenticated("browser_governance_disabled", route);
        return refuse(reply, 403, "browser_governance_disabled");
      }
      if (!identityIssuer()) return refuse(reply, 503, "issuer_not_configured");
      const body = browserRegisterRequestSchema.safeParse(jsonOf(req.body));
      if (!body.success) {
        await denyUnauthenticated("invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const now = await databaseNow(db);
      const prepared = await prepareRunnerKey(body.data.publicJwk as WorkloadPublicJwk, now);
      if (prepared instanceof IdentityAdminError) {
        await denyUnauthenticated("invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const jkt = await runnerKeyThumbprint(prepared);
      const clientId = `${JWK_THUMBPRINT_URI_PREFIX}${jkt}`;
      const identityId = randomUUID();
      type Outcome = { ok: true; deviceId: string; identityId: string; created: boolean } | { ok: false; code: BrowserRefusalCode; status: number; tokenId: string | null };
      const outcome: Outcome = await asEnrolment(() => db
        .transaction(async (tx): Promise<Outcome> => {
          const t = tx as unknown as Db;
          const [tok] = await t.select().from(browserEnrolmentTokens).where(eq(browserEnrolmentTokens.tokenHash, sha256Hex(token))).for("update");
          if (!tok) return { ok: false, code: "invalid_token", status: 401, tokenId: null };
          // the declared token lifecycle (rule 12); a revoked or expired token refuses even a retried install
          const tokState = enrolmentTokenState(tok, now);
          if (tokState === "revoked" || tokState === "expired") return { ok: false, code: ENROLMENT_TOKEN_STATE_REFUSAL[tokState], status: TOKEN_REFUSAL_STATUS[tokState], tokenId: tok.id };
          // idempotent: the same key again (a retried install) answers with the device it already is
          const existing = await keyRegistered(t, jkt);
          if (existing) {
            await nameDeviceIdentity(t, existing.identityId);
            const [own] = await t.select().from(browserDevices).where(eq(browserDevices.identityId, existing.identityId));
            if (!own) return { ok: false, code: "credential_already_registered", status: 409, tokenId: tok.id };
            if (browserDeviceState(own) === "revoked") return { ok: false, code: "device_revoked", status: 403, tokenId: tok.id };
            return { ok: true, deviceId: own.id, identityId: own.identityId, created: false };
          }
          // an exhausted token still answers the device it already enrolled (above), never a new one
          if (tokState === "exhausted") return { ok: false, code: ENROLMENT_TOKEN_STATE_REFUSAL.exhausted, status: TOKEN_REFUSAL_STATUS.exhausted, tokenId: tok.id };
          await t.insert(workloadIdentities).values({
            id: identityId,
            kind: "browser_extension",
            identifier: defaultWorkloadIdentifier(resolveTrustDomain(), "browser_extension", identityId),
            sponsorUserIds: [tok.createdBy ?? NIL_UUID],
            environments: [deploymentEnvironment()],
          });
          const bound = await bindPreparedCredentialTx(t, identityId, prepared, NIL_UUID, now);
          if (bound instanceof IdentityAdminError) throw bound;
          await nameDeviceIdentity(t, identityId);
          const [dev] = await t
            .insert(browserDevices)
            .values({ tokenId: tok.id, identityId, os: body.data.os, browserMajor: body.data.browserMajor, extensionVersion: body.data.extensionVersion })
            .returning({ id: browserDevices.id });
          await t
            .update(browserEnrolmentTokens)
            .set({ devicesEnrolled: sql`${browserEnrolmentTokens.devicesEnrolled} + 1` })
            .where(eq(browserEnrolmentTokens.id, tok.id));
          await audit(t, NIL_UUID, dev!.id, "browser-device-registered", "allow", "a browser extension registered its device key as a workload identity, with no grants (ADR-0334)", {
            tokenId: tok.id,
            deviceId: dev!.id,
            identityId,
            thumbprint: jkt,
            os: body.data.os,
            browserMajor: body.data.browserMajor,
            extensionVersion: body.data.extensionVersion,
          });
          return { ok: true, deviceId: dev!.id, identityId, created: true };
        })
        .catch((e: unknown): Outcome => {
          // two registrations of one new key race: the loser is refused by S6's one-key-one-identity rule
          if (e instanceof IdentityAdminError && e.code === "credential_already_registered") return { ok: false, code: "credential_already_registered", status: 409, tokenId: null };
          throw e;
        }));
      if (!outcome.ok) {
        if (outcome.tokenId) await deny(outcome.tokenId, outcome.code, route);
        else await denyUnauthenticated(outcome.code, route);
        return refuse(reply, outcome.status, outcome.code);
      }
      return reply.status(outcome.created ? 201 : 200).send({ deviceId: outcome.deviceId, identityId: outcome.identityId, clientId });
    });

    /**
     * The device behind a self token (the shared OAuth layer has already verified the token, its DPoP proof, the
     * proof's one-use id and nonce, the identity and the device): browser governance must still be on. Sends the
     * refusal itself.
     */
    const authenticate = async (req: FastifyRequest, reply: FastifyReply, route: string): Promise<{ device: BrowserDeviceRow; json: unknown; settings: BrowserGovernanceSettingsRow } | null> => {
      const identityId = req.authCtx.workloadIdentityId;
      if (req.authCtx.via !== "browser-extension" || !identityId) {
        await refuse(reply, 401, "browser_extension_token_required");
        return null;
      }
      const [device] = await asDeviceIdentity(db, identityId, (t) => t.select().from(browserDevices).where(eq(browserDevices.identityId, identityId)));
      if (!device || browserDeviceState(device) === "revoked") {
        await deny(device?.id ?? null, "device_revoked", route);
        await refuse(reply, 403, "device_revoked");
        return null;
      }
      const settings = await loadSettings(db);
      if (!settings.enabled) {
        await deny(device.id, "browser_governance_disabled", route);
        await refuse(reply, 403, "browser_governance_disabled");
        return null;
      }
      if (!dataKey) {
        await refuse(reply, 503, "data_key_unavailable");
        return null;
      }
      await asDeviceIdentity(db, identityId, (t) => t.update(browserDevices).set({ lastSeenAt: sql`now()` }).where(eq(browserDevices.id, device.id)));
      return { device, json: jsonOf(req.body), settings };
    };

    /**
     * The account a request is attributed to (security review #867, finding 1). The profile account is only what the
     * device says, so a device is BOUND to the first non-empty account it presents (audited) and from then on every
     * request must present that same account: a different one, or none, is refused `account_mismatch` and audited,
     * never attributed. The rows still record that the attribution is device-asserted (`attribution`); verifying an
     * identity-provider ID token is the recorded follow-up. Sends the refusal itself.
     */
    const accountOf = async (
      authed: { device: BrowserDeviceRow },
      profileEmail: string,
      route: string,
      reply: FastifyReply,
    ): Promise<{ email: string; subject: string; user: { id: string; disabled: boolean } | null } | null> => {
      const email = profileEmail.toLowerCase();
      const subject = await subjectOf(email);
      const device = authed.device;
      const verdict = await asDeviceIdentity(db, device.identityId, async (t) => {
        const [cur] = await t
          .select({ boundSubject: browserDevices.boundSubject })
          .from(browserDevices)
          .where(eq(browserDevices.id, device.id))
          .for("update");
        if (!cur) return "gone" as const;
        if (cur.boundSubject === null) {
          // an unbound device with no account signed in is attributed to no one (and its policy denies every site, #1028)
          if (!subject) return "ok" as const;
          const user = await userForEmail(t, email);
          await t
            .update(browserDevices)
            .set({ boundSubject: subject, boundUserId: user?.id ?? null, boundAt: sql`now()` })
            .where(and(eq(browserDevices.id, device.id), sql`${browserDevices.boundSubject} is null`));
          await audit(t, NIL_UUID, device.id, "browser-device-account-bound", "allow", "a browser extension device was bound to the first profile account it presented; any other account is refused from now on (ADR-0334)", {
            deviceId: device.id,
            subject,
            route,
          });
          return "ok" as const;
        }
        return cur.boundSubject === subject ? ("ok" as const) : { bound: cur.boundSubject };
      });
      if (verdict === "gone") {
        await deny(device.id, "device_revoked", route);
        await refuse(reply, 403, "device_revoked");
        return null;
      }
      if (verdict !== "ok") {
        await audit(db, NIL_UUID, device.id, "browser-device-account-mismatch", "deny", "a browser extension presented a profile account other than the one its device is bound to; the request was refused and nothing was attributed (ADR-0334)", {
          deviceId: device.id,
          code: "account_mismatch",
          route,
          boundSubject: verdict.bound,
          presentedSubject: subject || null,
        });
        await refuse(reply, 409, "account_mismatch");
        return null;
      }
      return { email, subject, user: email ? await userForEmail(db, email) : null };
    };

    /** a client timestamp outside the window around the gateway's clock refuses the whole body (review #867) */
    const timesAcceptable = async (ats: readonly number[]) => {
      const nowSeconds = Math.floor((await databaseNow(db)).getTime() / 1000);
      return ats.every((at) => browserClientTimeAcceptable(at, nowSeconds));
    };

    // -- policy -------------------------------------------------------------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.policy, async (req, reply) => {
      const route = "policy";
      const authed = await authenticate(req, reply, route);
      if (!authed) return reply;
      const body = browserPolicyRequestSchema.safeParse(authed.json);
      if (!body.success) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const key = await resolveDevicePolicySigner();
      if (key.state !== "ok") {
        await deny(authed.device.id, "policy_signer_unavailable", route);
        return refuse(reply, 503, "policy_signer_unavailable");
      }
      const account = await accountOf(authed, body.data.profileEmail, route, reply);
      if (!account) return reply;
      const { email, subject, user } = account;
      const [posture, rules] = await Promise.all([resolveExecutionPosture(db), loadRules(db)]);
      const policy = buildBrowserPolicy({
        deviceId: authed.device.id,
        subject,
        profileEmail: email,
        mode: authed.settings.mode,
        promptCaptureEnabled: authed.settings.promptCaptureEnabled,
        user,
        posture,
        rules,
        nowSeconds: Math.floor((await databaseNow(db)).getTime() / 1000),
      });
      // #1028 (owner decision 2026-11-21, reversing B1): an account that matches no active RegulAIt user, or no account,
      // gets a policy that denies every site (`account_not_recognised`); that is audited, pseudonym only
      if (!user) {
        await audit(db, NIL_UUID, authed.device.id, "browser-policy-unrecognised-account", "deny", "a browser policy denying every site was issued for a profile account that matches no RegulAIt user, or for a signed-out profile (ADR-0334 §14, #1028)", {
          deviceId: authed.device.id,
          subject: subject || null,
          signedIn: Boolean(email),
        });
      }
      return reply.status(200).send({ policy: signDevicePolicy(policy, key.signer) });
    });

    // -- breach events --------------------------------------------------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.events, async (req, reply) => {
      const route = "events";
      const authed = await authenticate(req, reply, route);
      if (!authed) return reply;
      const body = browserEventsRequestSchema.safeParse(authed.json);
      if (!body.success || !(await timesAcceptable(body.data.events.map((e) => e.occurredAt)))) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const account = await accountOf(authed, body.data.profileEmail, route, reply);
      if (!account) return reply;
      const { subject, user } = account;
      const key = await pseudonymKey(db, dataKey);
      const rows = body.data.events.map((e) => ({
        deviceId: authed.device.id,
        eventId: e.eventId,
        kind: e.kind,
        outcome: e.outcome,
        code: e.code,
        siteId: e.siteId,
        ruleIds: [...e.ruleIds],
        userId: user?.id ?? null,
        subjectPseudonym: subject,
        attribution: "device_asserted" as const,
        conversationRef: e.path ? conversationRef(key, e.siteId, e.path) : null,
        occurredAt: new Date(e.occurredAt * 1000),
      }));
      const accepted = await asDeviceIdentity(db, authed.device.identityId, async (t) => {
        const auditId = randomUUID();
        const inserted = await t
          .insert(browserEvents)
          .values(rows.map((r) => ({ ...r, auditId })))
          .onConflictDoNothing()
          .returning({ eventId: browserEvents.eventId });
        const fresh = new Set(inserted.map((r) => r.eventId));
        const recorded = rows.filter((r) => fresh.has(r.eventId));
        if (recorded.length > 0) {
          await audit(
            t,
            user?.id ?? NIL_UUID,
            authed.device.id,
            "browser-policy-breach",
            "deny",
            `a browser extension reported ${recorded.length} policy breach event(s) (ADR-0334)`,
            {
              deviceId: authed.device.id,
              subject,
              attribution: "device_asserted",
              events: recorded.map((r) => ({ eventId: r.eventId, kind: r.kind, outcome: r.outcome, code: r.code, siteId: r.siteId, ruleIds: r.ruleIds, conversationRef: r.conversationRef })),
            },
            auditId,
          );
        }
        return recorded.length;
      });
      return reply.status(202).send({ accepted, duplicates: rows.length - accepted });
    });

    // -- prompt capture (only while an admin has turned it on) ----------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.promptCaptures, async (req, reply) => {
      const route = "prompt-captures";
      const authed = await authenticate(req, reply, route);
      if (!authed) return reply;
      if (!authed.settings.promptCaptureEnabled) {
        await deny(authed.device.id, "prompt_capture_disabled", route);
        return refuse(reply, 403, "prompt_capture_disabled");
      }
      const body = browserPromptCaptureRequestSchema.safeParse(authed.json);
      if (!body.success || !(await timesAcceptable([body.data.capturedAt]))) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const account = await accountOf(authed, body.data.profileEmail, route, reply);
      if (!account) return reply;
      const { subject, user } = account;
      const key = await pseudonymKey(db, dataKey);
      const conv = conversationRef(key, body.data.siteId, body.data.path);
      const stored = await asDeviceIdentity(db, authed.device.identityId, async (t) => {
        const auditId = randomUUID();
        const [row] = await t
          .insert(browserPromptCaptures)
          .values({
            deviceId: authed.device.id,
            captureId: body.data.captureId,
            siteId: body.data.siteId,
            userId: user?.id ?? null,
            subjectPseudonym: subject,
            attribution: "device_asserted",
            conversationRef: conv,
            textCiphertext: encryptSecret(dataKey, body.data.text),
            textChars: body.data.text.length,
            capturedAt: new Date(body.data.capturedAt * 1000),
            auditId,
          })
          .onConflictDoNothing()
          .returning({ id: browserPromptCaptures.id });
        if (row) {
          await audit(t, user?.id ?? NIL_UUID, row.id, "browser-prompt-captured", "allow", "a browser extension captured a prompt while prompt capture is on (ADR-0334)", {
            deviceId: authed.device.id,
            captureId: body.data.captureId,
            siteId: body.data.siteId,
            subject,
            attribution: "device_asserted",
            conversationRef: conv,
            chars: body.data.text.length,
          }, auditId);
        }
        return Boolean(row);
      });
      return reply.status(202).send({ accepted: stored, duplicate: !stored });
    });
  });

  // ---- admin routes ---------------------------------------------------------------------------------------------
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;

  app.get("/v1/browser-governance", async (_req, reply) => {
    const settings = await loadSettings(db);
    const key = await resolveDevicePolicySigner();
    return reply.send({
      enabled: settings.enabled,
      mode: settings.mode,
      promptCaptureEnabled: settings.promptCaptureEnabled,
      promptCaptureRetentionDays: settings.promptCaptureRetentionDays,
      updatedAt: settings.updatedAt.toISOString(),
      policySigner:
        key.state === "ok" ? { state: "ok", source: key.signer.source, activeKeyId: key.signer.active.keyId, publishedKeys: key.signer.published } : { state: key.state },
    });
  });

  const settingsSchema = z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(["enforce", "audit"]).optional(),
      promptCaptureEnabled: z.boolean().optional(),
      promptCaptureRetentionDays: z.number().int().min(BROWSER_CAPTURE_RETENTION_MIN_DAYS).max(BROWSER_CAPTURE_RETENTION_MAX_DAYS).optional(),
    })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "change at least one setting" });

  // Code review #867, finding 2: the relaxations are judged on the row as locked by the write's own transaction, and
  // the step-up is claimed inside it, so a concurrent change between a read and this write can never be undone (or a
  // relaxation slipped in as "unchanged") without the step-up that change needs.
  app.put("/v1/browser-governance/settings", async (req, reply) => {
    const b = settingsSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: `send any of {enabled: boolean, mode: 'enforce' | 'audit', promptCaptureEnabled: boolean, promptCaptureRetentionDays: ${BROWSER_CAPTURE_RETENTION_MIN_DAYS} to ${BROWSER_CAPTURE_RETENTION_MAX_DAYS}}` });
    type After = { enabled: boolean; mode: "enforce" | "audit"; promptCaptureEnabled: boolean; promptCaptureRetentionDays: number };
    type Written = { kind: "unchanged" | "changed"; after: After } | { kind: "signer_unavailable" };
    let out: Written;
    try {
      out = await db.transaction(async (tx): Promise<Written> => {
        const t = tx as unknown as Db;
        await t.insert(browserGovernanceSettings).values({ id: 1 }).onConflictDoNothing();
        const [locked] = await t.select().from(browserGovernanceSettings).where(eq(browserGovernanceSettings.id, 1)).for("update");
        const before: After = { enabled: locked!.enabled, mode: locked!.mode, promptCaptureEnabled: locked!.promptCaptureEnabled, promptCaptureRetentionDays: locked!.promptCaptureRetentionDays };
        const after: After = {
          enabled: b.data.enabled ?? before.enabled,
          mode: b.data.mode ?? before.mode,
          promptCaptureEnabled: b.data.promptCaptureEnabled ?? before.promptCaptureEnabled,
          promptCaptureRetentionDays: b.data.promptCaptureRetentionDays ?? before.promptCaptureRetentionDays,
        };
        const changes = settingTransitions(before, b.data);
        if (Object.keys(changes).length === 0) return { kind: "unchanged", after };
        const relaxations = [
          ...(after.enabled && !before.enabled ? ["enable"] : []),
          ...(after.mode === "audit" && before.mode !== "audit" ? ["audit_mode"] : []),
          ...(after.promptCaptureEnabled && !before.promptCaptureEnabled ? ["prompt_capture"] : []),
          // owner decision B2: keeping captured prompts longer is a relaxation (shortening never is)
          ...(after.promptCaptureRetentionDays > before.promptCaptureRetentionDays ? ["capture_retention"] : []),
        ];
        if (after.enabled && !before.enabled) {
          // turning it on makes sure a policy can be signed; without a key the extension would stay closed for good
          const key = await resolveDevicePolicySigner(process.env, { create: true });
          if (key.state !== "ok") return { kind: "signer_unavailable" };
        }
        let stepUp: string | null = null;
        if (relaxations.length > 0) {
          const args: StepUpCheckArgs = { kind: "settings_relax", facts: { op: "browser_governance_settings", ...after, relaxations } };
          const su = await checkStepUp(t, req, args);
          if (!su.ok) throw new StepUpRefusedInTx({ status: su.status, body: su.body }, args);
          stepUp = su.method;
        }
        await t
          .update(browserGovernanceSettings)
          .set({ ...after, updatedBy: req.authCtx.userId ?? null, updatedAt: sql`now()` })
          .where(eq(browserGovernanceSettings.id, 1));
        await audit(t, actor(req), null, relaxations.length > 0 ? "browser-governance-relaxed" : "browser-governance-settings", "allow", `browser governance settings changed${relaxations.length > 0 ? ` (relaxation: ${relaxations.join(", ")}; step-up ${stepUp})` : ""} (ADR-0334)`, {
          changes,
          relaxations,
          stepUp,
        });
        return { kind: "changed", after };
      });
    } catch (err) {
      if (!(err instanceof StepUpRefusedInTx)) throw err;
      // the refusal's own audit row rolled back with the write: looking again (without spending) records it
      await checkStepUp(db, req, err.args, { spend: false });
      return reply.status(err.refusal.status).send(err.refusal.body);
    }
    if (out.kind === "signer_unavailable") {
      return reply.status(503).send({
        error: "policy_signer_unavailable",
        detail: `no device policy signing key is configured or can be created (set ${DEVICE_POLICY_KEY_FILE_ENV}, or ${INSTALL_SECRETS_DIR_ENV} for an install-generated key)`,
      });
    }
    return reply.send({ ...out.after, changed: out.kind === "changed" });
  });

  app.get("/v1/browser-governance/sites", async (_req, reply) => {
    const rules = await loadRules(db);
    return reply.send({
      sites: BROWSER_SITE_CATALOGUE.map((s) => {
        const r = rules.find((x) => x.siteId === s.siteId);
        return { siteId: s.siteId, host: s.host, provider: s.provider, decision: r?.decision ?? null, effective: r?.decision === "allow" ? "allow" : "deny", accountDomains: r?.accountDomains ?? [] };
      }),
    });
  });

  const siteRuleSchema = z
    .object({ decision: z.enum(["allow", "deny"]), accountDomains: z.array(z.string().max(253).regex(DOMAIN_RE)).max(20).default([]) })
    .strict();

  app.put("/v1/browser-governance/sites/:siteId", async (req, reply) => {
    const p = z.object({ siteId: z.enum(BROWSER_SITE_CATALOGUE_IDS) }).safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "unknown_site", detail: "the site is not in the governed site catalogue" });
    const b = siteRuleSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {decision: 'allow' | 'deny', accountDomains?: lowercase domains (at most 20)}" });
    const domains = [...new Set(b.data.accountDomains)].sort();
    let stepUp: string | null = null;
    if (b.data.decision === "allow") {
      // every allow is a relaxation of the default deny (and fewer account domains widen an allow)
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "browser_site_allow", siteId: p.data.siteId, accountDomains: domains } });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t
        .insert(browserSiteRules)
        .values({ siteId: p.data.siteId, decision: b.data.decision, setBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({ target: browserSiteRules.siteId, set: { decision: b.data.decision, setBy: req.authCtx.userId ?? null, setAt: sql`now()` } });
      await t.delete(browserSiteAccountDomains).where(eq(browserSiteAccountDomains.siteId, p.data.siteId));
      if (domains.length > 0) await t.insert(browserSiteAccountDomains).values(domains.map((domain) => ({ siteId: p.data.siteId, domain })));
      await audit(t, actor(req), null, b.data.decision === "allow" ? "browser-site-allowed" : "browser-site-denied", "allow", `browser site ${p.data.siteId} set to ${b.data.decision}${domains.length ? ` for accounts in ${domains.join(", ")}` : ""}${stepUp ? ` (step-up ${stepUp})` : ""} (ADR-0334)`, {
        siteId: p.data.siteId,
        decision: b.data.decision,
        accountDomains: domains,
        stepUp,
      });
    });
    return reply.send({ siteId: p.data.siteId, decision: b.data.decision, accountDomains: domains });
  });

  const issueSchema = z
    .object({
      label: z.string().trim().min(1).max(120),
      deviceCap: z.number().int().min(1).max(BROWSER_ENROLMENT_TOKEN_MAX_DEVICES),
      expiresInDays: z.number().int().min(1).max(BROWSER_ENROLMENT_TOKEN_MAX_DAYS).default(BROWSER_ENROLMENT_TOKEN_MAX_DAYS),
    })
    .strict();

  app.post("/v1/browser-governance/enrolment-tokens", async (req, reply) => {
    const b = issueSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: `send {label, deviceCap (1 to ${BROWSER_ENROLMENT_TOKEN_MAX_DEVICES}), expiresInDays (1 to ${BROWSER_ENROLMENT_TOKEN_MAX_DAYS})}` });
    const settings = await loadSettings(db);
    if (!settings.enabled) return reply.status(409).send({ error: "browser_governance_disabled", detail: "turn browser governance on first (that asks you to confirm it's you, and is audited)" });
    const gatewayUrl = identityIssuer();
    if (!gatewayUrl || !gatewayUrl.startsWith("https://")) return reply.status(503).send({ error: "issuer_not_configured", detail: "the gateway's public https URL is not configured, so extensions could not reach it" });
    const key = await resolveDevicePolicySigner();
    if (key.state !== "ok") return reply.status(503).send({ error: "policy_signer_unavailable", detail: "no device policy signing key is usable" });
    // a token enrols up to its cap of devices with no further check: issuing one is a credential issue, so a step-up
    // bound to its label, cap and lifetime (security review #867; as ADR-0261 does for credential issue)
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "browser_enrolment_token_issue", label: b.data.label, deviceCap: b.data.deviceCap, expiresInDays: b.data.expiresInDays } });
    if (!su.ok) return reply;
    const secret = BROWSER_ENROLMENT_TOKEN_PREFIX + randomBytes(32).toString("hex");
    const row = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [inserted] = await t
        .insert(browserEnrolmentTokens)
        .values({
          label: b.data.label,
          tokenHash: sha256Hex(secret),
          deviceCap: b.data.deviceCap,
          expiresAt: sql`now() + make_interval(days => ${b.data.expiresInDays})`,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(t, actor(req), inserted!.id, "browser-enrolment-token-issued", "allow", `browser extension enrolment token '${inserted!.label}' issued for up to ${inserted!.deviceCap} device(s) (step-up ${su.method}) (ADR-0334)`, {
        tokenId: inserted!.id,
        deviceCap: inserted!.deviceCap,
        expiresAt: inserted!.expiresAt.toISOString(),
        stepUp: su.method,
      });
      return inserted!;
    });
    return reply.status(201).send({
      token: tokenView({ ...row, devicesActive: 0 }),
      // shown once: the managed storage value the customer's browser management pushes to the extension
      managedConfig: { gatewayUrl: trimTrailingSlashes(gatewayUrl), enrolmentToken: secret, policyKeys: key.signer.published.slice(0, 4) },
    });
  });

  // ADR-0226 (code review #867, finding 1): the three admin lists answer through the shared list contract
  const noFilters = z.object({}).strict();
  const tokensList: ContractList<TokenView, z.infer<typeof noFilters>> = {
    spec: BROWSER_ENROLMENT_TOKENS_LIST,
    filters: noFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({ ...getTableColumns(browserEnrolmentTokens), devicesActive: devicesActiveOf, _cursorAt: q.cursorAt })
          .from(browserEnrolmentTokens)
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        return rows.map(({ _cursorAt, ...r }) => ({ ...tokenView(r), _cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(browserEnrolmentTokens).where(where),
      idOf: (r) => r.tokenId,
    },
    where: () => undefined,
  };
  app.get("/v1/browser-governance/enrolment-tokens", async (req, reply) => answerListPage(db, req, reply, tokensList));

  app.post("/v1/browser-governance/enrolment-tokens/:tokenId/revoke", async (req, reply) => {
    const p = z.object({ tokenId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "tokenId must be a uuid" });
    const done = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [cur] = await t.select().from(browserEnrolmentTokens).where(eq(browserEnrolmentTokens.id, p.data.tokenId)).for("update");
      if (!cur || !BROWSER_ENROLMENT_TOKEN_MACHINE.can(enrolmentTokenState(cur, new Date()), "revoke")) return false;
      const [row] = await t
        .update(browserEnrolmentTokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(browserEnrolmentTokens.id, p.data.tokenId), sql`${browserEnrolmentTokens.revokedAt} is null`))
        .returning({ id: browserEnrolmentTokens.id });
      if (row) await audit(t, actor(req), row.id, "browser-enrolment-token-revoked", "allow", "browser extension enrolment token revoked: no new devices register with it (ADR-0334)", { tokenId: row.id });
      return Boolean(row);
    });
    if (!done) return reply.status(404).send({ error: "not_found", detail: "no active token has that id" });
    return reply.send({ revoked: true });
  });

  const devicesList: ContractList<DeviceView, z.infer<typeof noFilters>> = {
    spec: BROWSER_DEVICES_LIST,
    filters: noFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db.select({ ...getTableColumns(browserDevices), _cursorAt: q.cursorAt }).from(browserDevices).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset);
        return rows.map(({ _cursorAt, ...d }) => ({ ...deviceView(d), _cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(browserDevices).where(where),
      idOf: (r) => r.deviceId,
    },
    where: () => undefined,
  };
  app.get("/v1/browser-governance/devices", async (req, reply) => answerListPage(db, req, reply, devicesList));

  app.post("/v1/browser-governance/devices/:deviceId/revoke", async (req, reply) => {
    const p = z.object({ deviceId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "deviceId must be a uuid" });
    const done = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [cur] = await t.select().from(browserDevices).where(eq(browserDevices.id, p.data.deviceId)).for("update");
      if (!cur || !BROWSER_DEVICE_MACHINE.can(browserDeviceState(cur), "revoke")) return false;
      const [row] = await t
        .update(browserDevices)
        .set({ revokedAt: sql`now()`, revokedBy: req.authCtx.userId ?? null })
        .where(and(eq(browserDevices.id, p.data.deviceId), sql`${browserDevices.revokedAt} is null`))
        .returning({ id: browserDevices.id });
      if (row) await audit(t, actor(req), row.id, "browser-device-revoked", "allow", "browser extension device revoked: its proofs are refused from now on, and it blocks every governed site (ADR-0334)", { deviceId: row.id });
      return Boolean(row);
    });
    if (!done) return reply.status(404).send({ error: "not_found", detail: "no active device has that id" });
    return reply.send({ revoked: true });
  });

  // keyset on (received_at, id): every event of one ingested batch shares its received_at, and the id tie-breaker pages
  // through them without skipping any (code review #867, finding 1)
  const eventsList: ContractList<EventView, z.infer<typeof noFilters>> = {
    spec: BROWSER_EVENTS_LIST,
    filters: noFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db.select({ ...getTableColumns(browserEvents), _cursorAt: q.cursorAt }).from(browserEvents).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset);
        return rows.map(({ _cursorAt, ...e }) => ({ ...eventView(e), _cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(browserEvents).where(where),
      idOf: (r) => r.id,
    },
    where: () => undefined,
  };
  app.get("/v1/browser-governance/events", async (req, reply) => answerListPage(db, req, reply, eventsList));

  app.get("/v1/browser-governance/prompt-captures/:captureId", async (req, reply) => {
    const p = z.object({ captureId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "captureId must be a uuid" });
    const [row] = await db.select().from(browserPromptCaptures).where(eq(browserPromptCaptures.id, p.data.captureId));
    if (!row) return reply.status(404).send({ error: "not_found", detail: "no captured prompt has that id" });
    // reading captured content reveals what a person wrote: its own step-up, bound to this one capture, and audited
    const su = await requireStepUp(db, req, reply, { kind: "pseudonym_reveal", facts: { op: "browser_prompt_capture_read", captureId: row.id } });
    if (!su.ok) return reply;
    await audit(db, actor(req), row.id, "browser-prompt-capture-read", "allow", `a captured browser prompt was read (step-up ${su.method}) (ADR-0334)`, { captureId: row.id, stepUp: su.method });
    return reply.send({
      id: row.id,
      deviceId: row.deviceId,
      siteId: row.siteId,
      userId: row.userId,
      subject: row.subjectPseudonym,
      conversationRef: row.conversationRef,
      text: decryptSecret(dataKey, row.textCiphertext),
      capturedAt: row.capturedAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
    });
  });
}

/** trailing slashes off with a bounded loop (never a repeating regex: CodeQL js/polynomial-redos) */
function trimTrailingSlashes(u: string): string {
  let end = u.length;
  while (end > 0 && u[end - 1] === "/") end--;
  return u.slice(0, end);
}

/** the HTTP status of each non-active token state's refusal at register (unchanged by rule 12) */
const TOKEN_REFUSAL_STATUS = { exhausted: 409, expired: 410, revoked: 403 } as const;

export const REFUSAL_COALESCE_WINDOW_MS = 60_000;

/**
 * #1030: per process, per refusal code and route, the first refusal of a window is written and the rest are counted;
 * the count is written as one summary row when the window ends (an unref'd timer, so it never holds the process
 * open). A count still open when the process exits is lost, which the ADR records: it bounds audit volume from
 * unauthenticated callers and is not itself evidence of any one request.
 */
export class RefusalCoalescer {
  private readonly windows = new Map<string, { code: BrowserRefusalCode; route: string; startedAt: number; suppressed: number; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private readonly flush: (code: BrowserRefusalCode, route: string, suppressed: number, windowStartedAt: number) => Promise<unknown>,
    private readonly windowMs: number = REFUSAL_COALESCE_WINDOW_MS,
  ) {}

  /** true when this refusal should be written now (the first of its window) */
  admit(code: BrowserRefusalCode, route: string, nowMs: number): boolean {
    const key = `${route}:${code}`;
    const w = this.windows.get(key);
    if (!w || nowMs - w.startedAt >= this.windowMs) {
      if (w) this.close(key);
      this.windows.set(key, { code, route, startedAt: nowMs, suppressed: 0, timer: null });
      return true;
    }
    w.suppressed += 1;
    if (!w.timer) {
      w.timer = setTimeout(() => this.close(key), Math.max(0, w.startedAt + this.windowMs - nowMs));
      w.timer.unref?.();
    }
    return false;
  }

  private close(key: string): void {
    const w = this.windows.get(key);
    if (!w) return;
    this.windows.delete(key);
    if (w.timer) clearTimeout(w.timer);
    if (w.suppressed > 0) void this.flush(w.code, w.route, w.suppressed, w.startedAt);
  }
}

/** a step-up refused while claimed inside the settings write's transaction: rolls the write back */
class StepUpRefusedInTx extends Error {
  constructor(
    readonly refusal: { status: number; body: Record<string, unknown> },
    readonly args: StepUpCheckArgs,
  ) {
    super("step_up_refused_in_transaction");
  }
}

/** the devices a token enrolled that are not revoked, as a correlated subquery (one query per page, no N+1) */
const devicesActiveOf = sql<number>`(select count(*)::int from ${browserDevices} where ${browserDevices.tokenId} = ${browserEnrolmentTokens.id} and ${browserDevices.revokedAt} is null)`;

function tokenView(r: typeof browserEnrolmentTokens.$inferSelect & { devicesActive: number }) {
  return {
    tokenId: r.id,
    label: r.label,
    deviceCap: r.deviceCap,
    devicesEnrolled: r.devicesEnrolled,
    devicesActive: Number(r.devicesActive),
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}
type TokenView = ReturnType<typeof tokenView>;

function deviceView(d: BrowserDeviceRow) {
  return {
    deviceId: d.id,
    tokenId: d.tokenId,
    os: d.os,
    browserMajor: d.browserMajor,
    extensionVersion: d.extensionVersion,
    bound: d.boundSubject !== null,
    boundSubject: d.boundSubject,
    boundAt: d.boundAt?.toISOString() ?? null,
    registeredAt: d.registeredAt.toISOString(),
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    revokedAt: d.revokedAt?.toISOString() ?? null,
  };
}
type DeviceView = ReturnType<typeof deviceView>;

/** pseudonymous: the subject pseudonym only, never the user id beside it (security review #867) */
function eventView(e: typeof browserEvents.$inferSelect) {
  return {
    id: e.id,
    deviceId: e.deviceId,
    kind: e.kind,
    outcome: e.outcome,
    code: e.code,
    siteId: e.siteId,
    ruleIds: e.ruleIds,
    subject: e.subjectPseudonym,
    attribution: e.attribution,
    conversationRef: e.conversationRef,
    occurredAt: e.occurredAt.toISOString(),
    receivedAt: e.receivedAt.toISOString(),
    auditId: e.auditId,
  };
}
type EventView = ReturnType<typeof eventView>;

export const BROWSER_ENROLMENT_TOKENS_LIST: ListSpec<TokenView> = {
  id: "browser-enrolment-tokens",
  sorts: {
    created: { expr: browserEnrolmentTokens.createdAt, keysetAt: browserEnrolmentTokens.createdAt },
    expires: { expr: browserEnrolmentTokens.expiresAt, keysetAt: browserEnrolmentTokens.expiresAt },
    label: { expr: sql`lower(${browserEnrolmentTokens.label})` },
  },
  columns: {
    label: { label: "Label", value: (r) => r.label },
    deviceCap: { label: "Device cap", value: (r) => r.deviceCap },
    devicesEnrolled: { label: "Devices enrolled", value: (r) => r.devicesEnrolled },
    devicesActive: { label: "Devices active", value: (r) => r.devicesActive },
    expires: { label: "Expires", value: (r) => r.expiresAt },
    revoked: { label: "Revoked", value: (r) => r.revokedAt },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: browserEnrolmentTokens.id,
};

export const BROWSER_DEVICES_LIST: ListSpec<DeviceView> = {
  id: "browser-devices",
  sorts: {
    registered: { expr: browserDevices.registeredAt, keysetAt: browserDevices.registeredAt },
    os: { expr: browserDevices.os },
    version: { expr: browserDevices.extensionVersion },
  },
  columns: {
    device: { label: "Device", value: (r) => r.deviceId },
    os: { label: "OS", value: (r) => r.os },
    browserMajor: { label: "Browser version", value: (r) => r.browserMajor },
    version: { label: "Extension version", value: (r) => r.extensionVersion },
    bound: { label: "Bound to an account", value: (r) => r.bound },
    registered: { label: "Registered", value: (r) => r.registeredAt },
    lastSeen: { label: "Last seen", value: (r) => r.lastSeenAt },
    revoked: { label: "Revoked", value: (r) => r.revokedAt },
  },
  filters: [],
  defaultSort: { col: "registered", dir: "desc" },
  idCol: browserDevices.id,
};

export const BROWSER_EVENTS_LIST: ListSpec<EventView> = {
  id: "browser-events",
  sorts: {
    received: { expr: browserEvents.receivedAt, keysetAt: browserEvents.receivedAt },
    occurred: { expr: browserEvents.occurredAt, keysetAt: browserEvents.occurredAt },
    site: { expr: browserEvents.siteId },
  },
  columns: {
    received: { label: "Received", value: (r) => r.receivedAt },
    occurred: { label: "Occurred", value: (r) => r.occurredAt },
    site: { label: "Site", value: (r) => r.siteId },
    kind: { label: "Kind", value: (r) => r.kind },
    outcome: { label: "Outcome", value: (r) => r.outcome },
    code: { label: "Code", value: (r) => r.code },
    subject: { label: "Subject (pseudonym)", value: (r) => r.subject },
    device: { label: "Device", value: (r) => r.deviceId },
  },
  filters: [],
  defaultSort: { col: "received", dir: "desc" },
  idCol: browserEvents.id,
};

async function loadRules(db: Db): Promise<{ siteId: string; decision: "allow" | "deny"; accountDomains: string[] }[]> {
  const [rules, domains] = await Promise.all([db.select().from(browserSiteRules), db.select().from(browserSiteAccountDomains)]);
  return rules.map((r) => ({ siteId: r.siteId, decision: r.decision, accountDomains: domains.filter((d) => d.siteId === r.siteId).map((d) => d.domain).sort() }));
}
