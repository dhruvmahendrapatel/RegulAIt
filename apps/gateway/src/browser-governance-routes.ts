/**
 * ADR-0334 (lane E16): THE MANAGED BROWSER EXTENSION'S GATEWAY ROUTES.
 *
 * STRICT DEFAULT (ADR-0180). Nothing works until an admin turns browser governance on, which is a `settings_relax`
 * step-up (audited). While it is off every extension route refuses `browser_governance_disabled`, and an extension
 * with no valid policy blocks every governed site (it fails closed on its own side too).
 *
 * The extension channel (auth-exempt, authenticated IN-ROUTE; raw bodies, at most 64 KiB):
 *   POST /v1/browser-extension/register         the bulk enrolment token (`rgbe_`), compared by SHA-256; capped
 *   POST /v1/browser-extension/policy           device proof; answers the signed per-user policy (EdDSA JWS)
 *   POST /v1/browser-extension/events           device proof; policy breaches (codes and ids, never prompt text)
 *   POST /v1/browser-extension/prompt-captures  device proof; only while prompt capture is on (a step-up relaxation)
 * A device proof is an ES256 JWS by the device's registered key over the method, path, body digest, time and a
 * one-use id (replay store). Every refusal is a fixed code and is audited with ids and the code only.
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
  desc,
  eq,
  inArray,
  lt,
  sql,
  users,
  type BrowserDeviceRow,
  type BrowserGovernanceSettingsRow,
  type Db,
} from "@regulait/db";
import {
  BROWSER_DEVICE_HEADER,
  BROWSER_ENROLMENT_TOKEN_MAX_DAYS,
  BROWSER_ENROLMENT_TOKEN_MAX_DEVICES,
  BROWSER_ENROLMENT_TOKEN_PREFIX,
  BROWSER_ENROLMENT_TOKEN_RE,
  BROWSER_EXTENSION_PATHS,
  BROWSER_PROOF_HEADER,
  BROWSER_PROOF_MAX_AGE_SECONDS,
  BROWSER_PROOF_MAX_FUTURE_SECONDS,
  BROWSER_REQUEST_MAX_BYTES,
  BROWSER_SITE_CATALOGUE,
  BROWSER_SITE_CATALOGUE_IDS,
  browserEventsRequestSchema,
  browserPolicyRequestSchema,
  browserPromptCaptureRequestSchema,
  browserPublicJwkSchema,
  browserRegisterRequestSchema,
  type BrowserPublicJwk,
  type BrowserRefusalCode,
} from "@regulait/shared";
import {
  browserBodyDigest,
  browserJwkThumbprint,
  buildBrowserPolicy,
  conversationRef,
  resolveBrowserPolicyKey,
  signBrowserPolicy,
  verifyBrowserProof,
} from "./browser-governance.js";
import { databaseNow } from "./db-clock.js";
import { claimReplay } from "./delegated-token.js";
import { pseudonymise, pseudonymKey } from "./discovery-worker.js";
import { resolveExecutionPosture } from "./execution-posture.js";
import { identityIssuer } from "./oauth/common.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireStepUp } from "./step-up.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const LIST_MAX = 200;
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

async function loadSettings(db: Db): Promise<BrowserGovernanceSettingsRow> {
  const [row] = await db.select().from(browserGovernanceSettings).where(eq(browserGovernanceSettings.id, 1));
  // the migration inserts the row; a missing row reads as the strict default
  return row ?? { id: 1, enabled: false, mode: "enforce", promptCaptureEnabled: false, updatedBy: null, updatedAt: new Date(0) };
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

    // -- registration (once per install) ------------------------------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.register, async (req, reply) => {
      const route = "register";
      const token = bearerToken(req);
      if (!token) {
        await deny(null, "invalid_token", route);
        return refuse(reply, 401, "invalid_token");
      }
      const settings = await loadSettings(db);
      if (!settings.enabled) {
        await deny(null, "browser_governance_disabled", route);
        return refuse(reply, 403, "browser_governance_disabled");
      }
      const body = browserRegisterRequestSchema.safeParse(jsonOf(req.body));
      if (!body.success) {
        await deny(null, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const thumbprint = await browserJwkThumbprint(body.data.publicJwk);
      const outcome = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [tok] = await t
          .select()
          .from(browserEnrolmentTokens)
          .where(eq(browserEnrolmentTokens.tokenHash, sha256Hex(token)))
          .for("update");
        if (!tok) return { code: "invalid_token" as const, status: 401, tokenId: null };
        if (tok.revokedAt) return { code: "token_revoked" as const, status: 403, tokenId: tok.id };
        const now = await databaseNow(t);
        if (tok.expiresAt.getTime() <= now.getTime()) return { code: "token_expired" as const, status: 410, tokenId: tok.id };
        const [existing] = await t.select().from(browserDevices).where(eq(browserDevices.jwkThumbprint, thumbprint));
        if (existing) {
          if (existing.revokedAt) return { code: "device_revoked" as const, status: 403, tokenId: tok.id };
          // the same key again (a retried install): idempotent, counted once
          return { deviceId: existing.id, created: false, tokenId: tok.id };
        }
        if (tok.devicesEnrolled >= tok.deviceCap) return { code: "enrolment_cap_reached" as const, status: 409, tokenId: tok.id };
        const [dev] = await t
          .insert(browserDevices)
          .values({
            tokenId: tok.id,
            jwkThumbprint: thumbprint,
            publicJwk: body.data.publicJwk,
            os: body.data.os,
            browserMajor: body.data.browserMajor,
            extensionVersion: body.data.extensionVersion,
          })
          .returning({ id: browserDevices.id });
        await t
          .update(browserEnrolmentTokens)
          .set({ devicesEnrolled: sql`${browserEnrolmentTokens.devicesEnrolled} + 1` })
          .where(eq(browserEnrolmentTokens.id, tok.id));
        await audit(t, NIL_UUID, dev!.id, "browser-device-registered", "allow", "a browser extension registered its device key (ADR-0334)", {
          tokenId: tok.id,
          deviceId: dev!.id,
          os: body.data.os,
          browserMajor: body.data.browserMajor,
          extensionVersion: body.data.extensionVersion,
        });
        return { deviceId: dev!.id, created: true, tokenId: tok.id };
      });
      if ("code" in outcome && outcome.code) {
        await deny(outcome.tokenId, outcome.code, route);
        return refuse(reply, outcome.status, outcome.code);
      }
      if (!("deviceId" in outcome)) return refuse(reply, 401, "invalid_token");
      return reply.status(outcome.created ? 201 : 200).send({ deviceId: outcome.deviceId });
    });

    /**
     * The device proof check shared by the three signed routes: on, a known live device, a proof by its key over this
     * path and these exact bytes, fresh by the database clock, its id never seen before. Sends the refusal itself.
     */
    const authenticate = async (req: FastifyRequest, reply: FastifyReply, htu: string, route: string): Promise<{ device: BrowserDeviceRow; json: unknown; settings: BrowserGovernanceSettingsRow } | null> => {
      const settings = await loadSettings(db);
      if (!settings.enabled) {
        await deny(null, "browser_governance_disabled", route);
        await refuse(reply, 403, "browser_governance_disabled");
        return null;
      }
      if (!dataKey) {
        await refuse(reply, 503, "data_key_unavailable");
        return null;
      }
      const deviceHeader = req.headers[BROWSER_DEVICE_HEADER];
      const proofHeader = req.headers[BROWSER_PROOF_HEADER];
      const deviceId = typeof deviceHeader === "string" && z.string().uuid().safeParse(deviceHeader).success ? deviceHeader : null;
      if (!deviceId || typeof proofHeader !== "string") {
        await deny(null, "invalid_proof", route);
        await refuse(reply, 401, "invalid_proof");
        return null;
      }
      const [device] = await db.select().from(browserDevices).where(eq(browserDevices.id, deviceId));
      if (!device) {
        await deny(null, "unknown_device", route);
        await refuse(reply, 401, "unknown_device");
        return null;
      }
      if (device.revokedAt) {
        await deny(device.id, "device_revoked", route);
        await refuse(reply, 403, "device_revoked");
        return null;
      }
      const jwk = browserPublicJwkSchema.safeParse(device.publicJwk);
      const raw = Buffer.isBuffer(req.body) ? req.body : null;
      if (!jwk.success || !raw) {
        await deny(device.id, "invalid_body", route);
        await refuse(reply, 400, "invalid_body");
        return null;
      }
      const nowSeconds = Math.floor((await databaseNow(db)).getTime() / 1000);
      const v = await verifyBrowserProof(proofHeader, jwk.data as BrowserPublicJwk, { htu, bodyDigest: browserBodyDigest(raw) }, nowSeconds);
      if (!v.ok) {
        await deny(device.id, v.code, route);
        await refuse(reply, v.code === "invalid_proof" ? 401 : 400, v.code);
        return null;
      }
      const expires = new Date((v.claims.iat + BROWSER_PROOF_MAX_AGE_SECONDS + BROWSER_PROOF_MAX_FUTURE_SECONDS) * 1000);
      if (!(await claimReplay(db, "client_assertion", `browser-ext:${device.id}:${v.claims.jti}`, expires))) {
        await deny(device.id, "proof_replayed", route);
        await refuse(reply, 400, "proof_replayed");
        return null;
      }
      await db.update(browserDevices).set({ lastSeenAt: sql`now()` }).where(eq(browserDevices.id, device.id));
      return { device, json: jsonOf(raw), settings };
    };

    // -- policy -------------------------------------------------------------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.policy, async (req, reply) => {
      const route = "policy";
      const authed = await authenticate(req, reply, BROWSER_EXTENSION_PATHS.policy, route);
      if (!authed) return reply;
      const body = browserPolicyRequestSchema.safeParse(authed.json);
      if (!body.success) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const key = resolveBrowserPolicyKey();
      if (key.state !== "ok") {
        await deny(authed.device.id, "policy_signer_unavailable", route);
        return refuse(reply, 503, "policy_signer_unavailable");
      }
      const email = body.data.profileEmail.toLowerCase();
      const [user, subject, posture, rules] = await Promise.all([userForEmail(db, email), subjectOf(email), resolveExecutionPosture(db), loadRules(db)]);
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
      return reply.status(200).send({ policy: await signBrowserPolicy(policy, key.key) });
    });

    // -- breach events --------------------------------------------------------------------------------------------
    scope.post(BROWSER_EXTENSION_PATHS.events, async (req, reply) => {
      const route = "events";
      const authed = await authenticate(req, reply, BROWSER_EXTENSION_PATHS.events, route);
      if (!authed) return reply;
      const body = browserEventsRequestSchema.safeParse(authed.json);
      if (!body.success) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const email = body.data.profileEmail.toLowerCase();
      const [user, subject, key] = await Promise.all([userForEmail(db, email), subjectOf(email), pseudonymKey(db, dataKey)]);
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
        conversationRef: e.path ? conversationRef(key, e.siteId, e.path) : null,
        occurredAt: new Date(e.occurredAt * 1000),
      }));
      const accepted = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
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
      const authed = await authenticate(req, reply, BROWSER_EXTENSION_PATHS.promptCaptures, route);
      if (!authed) return reply;
      if (!authed.settings.promptCaptureEnabled) {
        await deny(authed.device.id, "prompt_capture_disabled", route);
        return refuse(reply, 403, "prompt_capture_disabled");
      }
      const body = browserPromptCaptureRequestSchema.safeParse(authed.json);
      if (!body.success) {
        await deny(authed.device.id, "invalid_body", route);
        return refuse(reply, 400, "invalid_body");
      }
      const email = body.data.profileEmail.toLowerCase();
      const [user, subject, key] = await Promise.all([userForEmail(db, email), subjectOf(email), pseudonymKey(db, dataKey)]);
      const conv = conversationRef(key, body.data.siteId, body.data.path);
      const stored = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const auditId = randomUUID();
        const [row] = await t
          .insert(browserPromptCaptures)
          .values({
            deviceId: authed.device.id,
            captureId: body.data.captureId,
            siteId: body.data.siteId,
            userId: user?.id ?? null,
            subjectPseudonym: subject,
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
    const key = resolveBrowserPolicyKey();
    return reply.send({
      enabled: settings.enabled,
      mode: settings.mode,
      promptCaptureEnabled: settings.promptCaptureEnabled,
      updatedAt: settings.updatedAt.toISOString(),
      policyKey: key.state === "ok" ? { state: "ok", keyId: key.key.keyId, x: key.key.x, source: key.key.source } : { state: key.state },
    });
  });

  const settingsSchema = z
    .object({ enabled: z.boolean().optional(), mode: z.enum(["enforce", "audit"]).optional(), promptCaptureEnabled: z.boolean().optional() })
    .strict()
    .refine((b) => Object.keys(b).length > 0, { message: "change at least one setting" });

  app.put("/v1/browser-governance/settings", async (req, reply) => {
    const b = settingsSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send any of {enabled: boolean, mode: 'enforce' | 'audit', promptCaptureEnabled: boolean}" });
    const before = await loadSettings(db);
    const after = {
      enabled: b.data.enabled ?? before.enabled,
      mode: b.data.mode ?? before.mode,
      promptCaptureEnabled: b.data.promptCaptureEnabled ?? before.promptCaptureEnabled,
    };
    const relaxations = [
      ...(after.enabled && !before.enabled ? ["enable"] : []),
      ...(after.mode === "audit" && before.mode !== "audit" ? ["audit_mode"] : []),
      ...(after.promptCaptureEnabled && !before.promptCaptureEnabled ? ["prompt_capture"] : []),
    ];
    if (relaxations.length === 0 && after.enabled === before.enabled && after.mode === before.mode && after.promptCaptureEnabled === before.promptCaptureEnabled) {
      return reply.send({ ...after, changed: false });
    }
    let stepUp: string | null = null;
    if (relaxations.length > 0) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { op: "browser_governance_settings", ...after, relaxations } });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    if (after.enabled && !before.enabled) {
      // turning it on makes sure a policy can be signed; without a key the extension would stay closed for good
      const key = resolveBrowserPolicyKey(process.env, { create: true });
      if (key.state !== "ok") return reply.status(503).send({ error: "policy_signer_unavailable", detail: "no browser policy signing key is configured or can be created (set REGULAIT_BROWSER_POLICY_SIGNING_KEY and its _KEY_ID, or REGULAIT_INSTALL_SECRETS_DIR)" });
    }
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t
        .insert(browserGovernanceSettings)
        .values({ id: 1, ...after, updatedBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({ target: browserGovernanceSettings.id, set: { ...after, updatedBy: req.authCtx.userId ?? null, updatedAt: sql`now()` } });
      await audit(t, actor(req), null, relaxations.length > 0 ? "browser-governance-relaxed" : "browser-governance-settings", "allow", `browser governance settings changed${relaxations.length > 0 ? ` (relaxation: ${relaxations.join(", ")}; step-up ${stepUp})` : ""} (ADR-0334)`, {
        before: { enabled: before.enabled, mode: before.mode, promptCaptureEnabled: before.promptCaptureEnabled },
        after,
        relaxations,
        stepUp,
      });
    });
    return reply.send({ ...after, changed: true });
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
    const key = resolveBrowserPolicyKey();
    if (key.state !== "ok") return reply.status(503).send({ error: "policy_signer_unavailable", detail: "no browser policy signing key is usable" });
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
      await audit(t, actor(req), inserted!.id, "browser-enrolment-token-issued", "allow", `browser extension enrolment token '${inserted!.label}' issued for up to ${inserted!.deviceCap} device(s) (ADR-0334)`, {
        tokenId: inserted!.id,
        deviceCap: inserted!.deviceCap,
        expiresAt: inserted!.expiresAt.toISOString(),
      });
      return inserted!;
    });
    return reply.status(201).send({
      token: tokenView(row, 0),
      // shown once: the managed storage value the customer's browser management pushes to the extension
      managedConfig: { gatewayUrl: trimTrailingSlashes(gatewayUrl), enrolmentToken: secret, policyKeys: [{ keyId: key.key.keyId, x: key.key.x }] },
    });
  });

  app.get("/v1/browser-governance/enrolment-tokens", async (_req, reply) => {
    const rows = await db.select().from(browserEnrolmentTokens).orderBy(desc(browserEnrolmentTokens.createdAt)).limit(LIST_MAX);
    const active = rows.length
      ? await db
          .select({ tokenId: browserDevices.tokenId, n: sql<number>`count(*)::int` })
          .from(browserDevices)
          .where(and(inArray(browserDevices.tokenId, rows.map((r) => r.id)), sql`${browserDevices.revokedAt} is null`))
          .groupBy(browserDevices.tokenId)
      : [];
    return reply.send({ tokens: rows.map((r) => tokenView(r, active.find((a) => a.tokenId === r.id)?.n ?? 0)) });
  });

  app.post("/v1/browser-governance/enrolment-tokens/:tokenId/revoke", async (req, reply) => {
    const p = z.object({ tokenId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "tokenId must be a uuid" });
    const done = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
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

  app.get("/v1/browser-governance/devices", async (_req, reply) => {
    const rows = await db.select().from(browserDevices).orderBy(desc(browserDevices.registeredAt)).limit(LIST_MAX);
    return reply.send({
      devices: rows.map((d) => ({
        deviceId: d.id,
        tokenId: d.tokenId,
        os: d.os,
        browserMajor: d.browserMajor,
        extensionVersion: d.extensionVersion,
        registeredAt: d.registeredAt.toISOString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        revokedAt: d.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post("/v1/browser-governance/devices/:deviceId/revoke", async (req, reply) => {
    const p = z.object({ deviceId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "deviceId must be a uuid" });
    const done = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
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

  const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(LIST_MAX).default(50), before: z.string().datetime({ offset: true }).optional() }).strict();

  app.get("/v1/browser-governance/events", async (req, reply) => {
    const q = eventsQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_request", detail: `limit is 1 to ${LIST_MAX}; before is an ISO time` });
    const rows = await db
      .select()
      .from(browserEvents)
      .where(q.data.before ? lt(browserEvents.receivedAt, new Date(q.data.before)) : undefined)
      .orderBy(desc(browserEvents.receivedAt), desc(browserEvents.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    return reply.send({
      events: page.map((e) => ({
        id: e.id,
        deviceId: e.deviceId,
        kind: e.kind,
        outcome: e.outcome,
        code: e.code,
        siteId: e.siteId,
        ruleIds: e.ruleIds,
        userId: e.userId,
        subject: e.subjectPseudonym,
        conversationRef: e.conversationRef,
        occurredAt: e.occurredAt.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
        auditId: e.auditId,
      })),
      next: rows.length > q.data.limit ? page[page.length - 1]!.receivedAt.toISOString() : null,
    });
  });

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

function tokenView(r: typeof browserEnrolmentTokens.$inferSelect, devicesActive: number) {
  return {
    tokenId: r.id,
    label: r.label,
    deviceCap: r.deviceCap,
    devicesEnrolled: r.devicesEnrolled,
    devicesActive,
    expiresAt: r.expiresAt.toISOString(),
    revokedAt: r.revokedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function loadRules(db: Db): Promise<{ siteId: string; decision: "allow" | "deny"; accountDomains: string[] }[]> {
  const [rules, domains] = await Promise.all([db.select().from(browserSiteRules), db.select().from(browserSiteAccountDomains)]);
  return rules.map((r) => ({ siteId: r.siteId, decision: r.decision, accountDomains: domains.filter((d) => d.siteId === r.siteId).map((d) => d.domain).sort() }));
}
