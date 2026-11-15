/**
 * ADR-0334 (lane E16): THE BROWSER GOVERNANCE CONTRACT, shared by the managed browser extension (agents/browser/) and
 * the gateway (apps/gateway/src/browser-governance*.ts). Pure: zod only, no I/O, no Node
 * built-ins, so the extension bundles this file (the `@regulait/shared/browser-governance` subpath) and both sides
 * parse the same bytes the same way.
 *
 * What travels:
 *  - registration: the extension's install-time P-256 public key, under a capped bulk enrolment token (`rgbe_`) that
 *    the customer's browser management delivers in the extension's managed storage;
 *  - every later request: a compact JWS (ES256) by that key over the method, the path, a body digest, a time and a
 *    one-use id (replay protected on the gateway), in the `Regulait-Browser-Proof` header;
 *  - the policy: a compact JWS (EdDSA) by the gateway's browser policy key, verified in the extension against key(s)
 *    pinned in managed storage, valid until `notAfter` and never after (no last-known-good);
 *  - events: policy breaches as fixed codes and ids, never prompt text. Prompt text travels only on the separate
 *    capture route, only while an admin has turned capture on (a step-up relaxation) and the notice is shown.
 *
 * Permission and governance decisions here are deterministic data checks. Nothing in this file, the extension or the
 * gateway's browser routes calls a model.
 */
import { z } from "zod";
import {
  BROWSER_DENY_REASONS,
  BROWSER_DLP_RULE_IDS,
  BROWSER_EVENT_CODES,
  BROWSER_EVENT_KINDS,
  BROWSER_EVENT_OUTCOMES,
  BROWSER_ENROLMENT_TOKEN_RE,
  BROWSER_EVENTS_PER_REQUEST,
  BROWSER_OS,
  BROWSER_PATH_MAX,
  BROWSER_POLICY_MODES,
  BROWSER_POLICY_SCHEMA,
  BROWSER_PROMPT_CAPTURE_MAX_CHARS,
  BROWSER_SITE_CATALOGUE_IDS,
  BROWSER_SITE_DECISIONS,
  BROWSER_HOST_RE,
  BROWSER_VERSION_RE,
} from "./constants.js";

export * from "./constants.js";


// ---------------------------------------------------------------------------
// Managed storage (what the customer's browser management sets)
// ---------------------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const browserPolicyKeySchema = z
  .object({
    keyId: z.string().regex(KEY_ID_RE),
    /** the Ed25519 public key as a JWK `x` (base64url of the 32 raw bytes) */
    x: z.string().length(43).regex(B64URL_RE),
  })
  .strict();

export const browserManagedConfigSchema = z
  .object({
    gatewayUrl: z
      .string()
      .max(2048)
      .url()
      .refine((u) => u.startsWith("https://"), { message: "the gateway must be reached over https" }),
    enrolmentToken: z.string().regex(BROWSER_ENROLMENT_TOKEN_RE),
    policyKeys: z.array(browserPolicyKeySchema).min(1).max(4),
  })
  .strict();
export type BrowserManagedConfig = z.infer<typeof browserManagedConfigSchema>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const b64urlCoord = z.string().length(43).regex(B64URL_RE);

/** the extension's public key: P-256, public members only (a private `d` is refused by `strict`) */
export const browserPublicJwkSchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: b64urlCoord, y: b64urlCoord }).strict();
export type BrowserPublicJwk = z.infer<typeof browserPublicJwkSchema>;


export const browserRegisterRequestSchema = z
  .object({
    publicJwk: browserPublicJwkSchema,
    os: z.enum(BROWSER_OS),
    browserMajor: z.number().int().min(1).max(10_000),
    extensionVersion: z.string().regex(BROWSER_VERSION_RE),
  })
  .strict();
export type BrowserRegisterRequest = z.infer<typeof browserRegisterRequestSchema>;

// ---------------------------------------------------------------------------
// Signed requests
// ---------------------------------------------------------------------------

export const browserProofClaimsSchema = z
  .object({
    htm: z.enum(["POST"]),
    /** the request path, exactly one of BROWSER_EXTENSION_PATHS */
    htu: z.string().max(128),
    iat: z.number().int().positive(),
    jti: z.string().uuid(),
    /** SHA-256 of the raw request body, base64url */
    bd: z.string().length(43).regex(B64URL_RE),
  })
  .strict();
export type BrowserProofClaims = z.infer<typeof browserProofClaimsSchema>;

/** the profile account the browser is signed in with, as the browser reports it; empty when not signed in */
const profileEmail = z.union([z.literal(""), z.string().max(320).email()]);

export const browserPolicyRequestSchema = z.object({ profileEmail }).strict();

// ---------------------------------------------------------------------------
// The signed policy
// ---------------------------------------------------------------------------


const domainSchema = z.string().max(253).regex(BROWSER_HOST_RE);

export const browserPolicySiteSchema = z
  .object({
    siteId: z.enum(BROWSER_SITE_CATALOGUE_IDS),
    decision: z.enum(BROWSER_SITE_DECISIONS),
    denyReason: z.enum(BROWSER_DENY_REASONS).nullable(),
    /** non-empty: the browser profile must be signed in with an account in one of these domains */
    accountDomains: z.array(domainSchema).max(20),
  })
  .strict()
  .refine((s) => (s.decision === "deny") === (s.denyReason !== null), { message: "a deny carries its reason, an allow none" });
export type BrowserPolicySite = z.infer<typeof browserPolicySiteSchema>;

export const browserPolicySchema = z
  .object({
    schema: z.literal(BROWSER_POLICY_SCHEMA),
    deviceId: z.string().uuid(),
    /** the pseudonym of the profile account the policy was computed for ("" when the profile is signed out) */
    subject: z.string().max(40),
    /** the profile account the policy was issued for, so the extension refetches when the account changes */
    profileEmail,
    mode: z.enum(BROWSER_POLICY_MODES),
    issuedAt: z.number().int().positive(),
    notAfter: z.number().int().positive(),
    sites: z.array(browserPolicySiteSchema).max(BROWSER_SITE_CATALOGUE_IDS.length),
    dlp: z.object({ ruleIds: z.array(z.enum(BROWSER_DLP_RULE_IDS)).max(BROWSER_DLP_RULE_IDS.length) }).strict(),
    promptCapture: z.object({ enabled: z.boolean() }).strict(),
  })
  .strict()
  .refine((p) => p.notAfter > p.issuedAt && p.notAfter - p.issuedAt <= 24 * 3600, { message: "a policy lives at most a day" })
  .refine((p) => new Set(p.sites.map((s) => s.siteId)).size === p.sites.length, { message: "one entry per site" });
export type BrowserPolicy = z.infer<typeof browserPolicySchema>;



/** a governed site's path, without query or fragment: the conversation it belongs to is derived from it server-side */
const sitePath = z.string().min(1).max(BROWSER_PATH_MAX).regex(/^\/[^?#\s]*$/);

export const browserEventSchema = z
  .object({
    eventId: z.string().uuid(),
    kind: z.enum(BROWSER_EVENT_KINDS),
    outcome: z.enum(BROWSER_EVENT_OUTCOMES),
    code: z.enum(BROWSER_EVENT_CODES),
    siteId: z.enum(BROWSER_SITE_CATALOGUE_IDS),
    /** the dlp.secret.* rule ids that matched (dlp_blocked only); never the matched text */
    ruleIds: z.array(z.enum(BROWSER_DLP_RULE_IDS)).max(BROWSER_DLP_RULE_IDS.length),
    path: sitePath.nullable(),
    occurredAt: z.number().int().positive(),
  })
  .strict()
  .refine((e) => (e.kind === "dlp_blocked") === (e.code === "dlp_match") && (e.kind === "dlp_blocked") === (e.ruleIds.length > 0), {
    message: "a dlp event names its rules and code; no other event does",
  });
export type BrowserEvent = z.infer<typeof browserEventSchema>;

export const browserEventsRequestSchema = z
  .object({ profileEmail, events: z.array(browserEventSchema).min(1).max(BROWSER_EVENTS_PER_REQUEST) })
  .strict()
  .refine((r) => new Set(r.events.map((e) => e.eventId)).size === r.events.length, { message: "event ids are unique" });

export const browserPromptCaptureRequestSchema = z
  .object({
    captureId: z.string().uuid(),
    profileEmail,
    siteId: z.enum(BROWSER_SITE_CATALOGUE_IDS),
    path: sitePath,
    text: z.string().min(1).max(BROWSER_PROMPT_CAPTURE_MAX_CHARS),
    capturedAt: z.number().int().positive(),
  })
  .strict();
