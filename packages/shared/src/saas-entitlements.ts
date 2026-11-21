/**
 * ADR-0337 — the SaaS entitlement graph vocabulary (lane E18), the pure half.
 *
 * WHAT IT IS: for each third-party or custom app (an AI agent, a connector, an integration) that holds OAuth scopes or
 * permissions in a customer's SaaS tenant, the scopes it holds, how they were granted and, for a user consent, which
 * (pseudonymised) users granted them. The entitlement readers (`apps/gateway/src/saas-entitlement-readers.ts`) run as
 * read-only ADR-0195 discovery sources and return one `SaasEntitlementBatch` per run; the worker checks it with
 * `checkSaasEntitlementBatch` and stores it in the third-normal-form tables of the ADR-0337 block of
 * `packages/db/src/schema.ts`, in the run's own fenced transaction, with its audit row.
 *
 * VENDOR NEUTRAL: the batch shape is the same for every platform. A platform adapter maps its vendor's own model (an
 * Entra service principal, a Google OAuth client, a Salesforce connected app, a Slack app) onto it; nothing downstream
 * branches on the vendor except the scope classifier's per-platform rule table, which is data.
 *
 * NOTHING HERE DECIDES OR EXECUTES: classification is a deterministic, frozen, versioned rule over the scope NAME (the
 * ADR-0092 discipline: a stated rule with its reason, no score). Findings built on it are recommendations a human acts
 * on through the approvals queue; nothing revokes a vendor-side grant.
 */
import { DISCOVERY_PSEUDONYM_PATTERN, type DiscoverySourceKind } from "./discovery/index.js";

export const SAAS_ENTITLEMENT_PLATFORMS = ["m365", "google_workspace", "salesforce", "slack"] as const;
export type SaasEntitlementPlatform = (typeof SAAS_ENTITLEMENT_PLATFORMS)[number];

export const SAAS_ENTITLEMENT_PLATFORM_LABELS: Readonly<Record<SaasEntitlementPlatform, string>> = Object.freeze({
  m365: "Microsoft 365 (Microsoft Graph)",
  google_workspace: "Google Workspace",
  salesforce: "Salesforce",
  slack: "Slack",
});

/** the discovery source kind that reads each platform (ADR-0195 framework, ADR-0337 kinds) */
export const SAAS_ENTITLEMENT_SOURCE_PLATFORM = Object.freeze({
  entitlement_m365: "m365",
  entitlement_google_workspace: "google_workspace",
  entitlement_salesforce: "salesforce",
  entitlement_slack: "slack",
} as const satisfies Partial<Record<DiscoverySourceKind, SaasEntitlementPlatform>>);

/** the platform a source kind reads, or null when the kind is not an entitlement reader */
export function entitlementPlatformOf(kind: DiscoverySourceKind): SaasEntitlementPlatform | null {
  return Object.hasOwn(SAAS_ENTITLEMENT_SOURCE_PLATFORM, kind) ? SAAS_ENTITLEMENT_SOURCE_PLATFORM[kind as keyof typeof SAAS_ENTITLEMENT_SOURCE_PLATFORM] : null;
}

/** what the vendor calls the holder of the grant, normalised */
export const SAAS_APP_KINDS = ["service_principal", "oauth_client", "connected_app", "slack_app"] as const;
export type SaasAppKind = (typeof SAAS_APP_KINDS)[number];

/**
 * `delegated`: the app acts on behalf of a signed-in user, within that user's own access (an OAuth user consent, an
 * Entra delegated permission). `application`: the app acts as itself, with no user (an Entra application permission,
 * a Salesforce connected app's run-as user, a Slack bot token).
 */
export const SAAS_GRANT_TYPES = ["delegated", "application"] as const;
export type SaasGrantType = (typeof SAAS_GRANT_TYPES)[number];

/** `tenant`: granted for every user of the tenant (an admin consent); `user`: granted by individual users */
export const SAAS_CONSENT_BREADTHS = ["tenant", "user"] as const;
export type SaasConsentBreadth = (typeof SAAS_CONSENT_BREADTHS)[number];

/** one scope one app holds, one way */
export interface SaasScopeGrant {
  /**
   * The resource the scope belongs to, where the platform scopes by resource (Microsoft: the resource application's id,
   * e.g. Microsoft Graph's). Empty where the scope name is already global (a Google scope URL, a Slack scope).
   */
  resource: string;
  /** the scope or permission NAME (never a token or a value) */
  scope: string;
  grantType: SaasGrantType;
  consent: SaasConsentBreadth;
  /** for a `user` consent, the pseudonyms (`psn:…`) of the users who granted it; empty otherwise */
  principals: string[];
}

export interface SaasAppEntitlement {
  /** the vendor's stable id for the app (an Entra appId, a Google OAuth client id, a connected app id, a Slack app id) */
  externalId: string;
  appKind: SaasAppKind;
  displayName: string | null;
  /** the publisher the vendor names (a verified publisher, a publisher domain), when it names one */
  publisher: string | null;
  /** true when the vendor marks the publisher verified, false when it says unverified, null when it does not say */
  publisherVerified: boolean | null;
  grants: SaasScopeGrant[];
}

/** what one entitlement read returns */
export interface SaasEntitlementBatch {
  platform: SaasEntitlementPlatform;
  /** the tenant, customer, org or workspace the read was for */
  tenant: string;
  /**
   * True only when every listing the graph depends on was read to its end. Only a complete batch removes grants the
   * previous run saw and this one did not (the vendor revoked them); a partial batch adds and refreshes, never removes.
   */
  complete: boolean;
  apps: SaasAppEntitlement[];
  /**
   * Revocations the reader saw explicitly (a user revoked an app's access, in an audit log read): that user leaves
   * every grant of that app. Applied to complete and partial batches alike. Optional; empty when absent.
   */
  revokedPrincipals?: SaasRevokedPrincipal[];
  /**
   * What the read observed of each app's USE (slice 3). Optional: a reader that has no usage source for its platform
   * leaves it out, which the findings read as coverage `none` (not assessable, never "unused").
   */
  usage?: SaasUsageObservation;
}

/**
 * How finely a read could observe use:
 *  - `none`: no usage source (the platform has no read-only one, the tenant's edition or licence lacks it, or the read
 *    of it failed). Nothing can be judged unused or excessive.
 *  - `app`: when each app was last used, with no split between reads and writes (Entra service-principal sign-in
 *    activity). An app with no use in the window can be judged; an excessive scope cannot.
 *  - `verb`: when each app last read and last wrote (Google token `activity` events, whose API method names are
 *    classified by `classifyGoogleApiMethod`). Both rules can be judged.
 */
export const SAAS_USAGE_COVERAGES = ["none", "app", "verb"] as const;
export type SaasUsageCoverage = (typeof SAAS_USAGE_COVERAGES)[number];

export interface SaasUsageObservation {
  coverage: SaasUsageCoverage;
  /**
   * The earliest moment the read could see use from (ISO 8601): the start of a log window (Google keeps token events
   * for 180 days). Null when the vendor reports a last-use time that is not bounded by a window (Entra keeps the last
   * sign-in time per app). A finding is judged only over a window the read covered.
   */
  windowStart: string | null;
  /** a plain-language note on what was and was not observed (for coverage `none`, why) */
  note: string;
  /** per app the read saw use of; an app the read lists among its grants but not here was not seen used */
  apps: SaasAppUsage[];
}

export interface SaasAppUsage {
  externalId: string;
  /** the latest use of any kind (ISO 8601); for coverage `verb`, the later of the two below */
  lastUseAt: string;
  /** coverage `verb` only: the latest read, and the latest write (a call the classifier could not tell is a write) */
  lastReadAt: string | null;
  lastWriteAt: string | null;
}

export interface SaasRevokedPrincipal {
  externalId: string;
  /** the pseudonym (`psn:…`) of the user who revoked */
  principal: string;
}

/** bounds a batch must stay inside (the worker refuses anything past them) */
export const SAAS_ENTITLEMENT_LIMITS = Object.freeze({
  apps: 5_000,
  grantsPerApp: 500,
  principalsPerGrant: 1_000,
  revokedPrincipals: 50_000,
  usageNote: 300,
  externalId: 255,
  displayName: 200,
  publisher: 200,
  resource: 255,
  scope: 512,
  tenant: 255,
});

/** a batch the worker refuses, with the reason */
export class SaasEntitlementBatchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaasEntitlementBatchRefused";
  }
}

// a printable identifier: no control characters, no whitespace runs, bounded (checked by length first)
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const printable = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && PRINTABLE.test(v);
const label = (v: unknown, max: number): v is string | null =>
  v === null || (typeof v === "string" && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v));

/**
 * Check a reader's batch before anything is stored: shapes, bounds, vocabulary, and the pseudonym rule (a person is
 * only ever a `psn:` pseudonym, ADR-0195 decision 20). Duplicate grants of one app are merged (principals united);
 * duplicate apps are refused, because two different rows under one vendor id would mean the reader is wrong.
 */
export function checkSaasEntitlementBatch(batch: unknown, expected: SaasEntitlementPlatform): SaasEntitlementBatch {
  if (!batch || typeof batch !== "object") throw new SaasEntitlementBatchRefused("the entitlement batch is not an object");
  const b = batch as Record<string, unknown>;
  if (b.platform !== expected) throw new SaasEntitlementBatchRefused(`the batch is for '${String(b.platform).slice(0, 40)}', not ${expected}`);
  if (!printable(b.tenant, SAAS_ENTITLEMENT_LIMITS.tenant)) throw new SaasEntitlementBatchRefused("the batch names no valid tenant");
  if (typeof b.complete !== "boolean") throw new SaasEntitlementBatchRefused("the batch does not say whether it is complete");
  if (!Array.isArray(b.apps) || b.apps.length > SAAS_ENTITLEMENT_LIMITS.apps) throw new SaasEntitlementBatchRefused(`the batch holds no app list, or more than ${SAAS_ENTITLEMENT_LIMITS.apps} apps`);
  const seen = new Set<string>();
  const apps: SaasAppEntitlement[] = [];
  for (const raw of b.apps as unknown[]) {
    const a = (raw ?? {}) as Record<string, unknown>;
    if (!printable(a.externalId, SAAS_ENTITLEMENT_LIMITS.externalId)) throw new SaasEntitlementBatchRefused("an app has no valid external id");
    // exact match: some vendors' ids are case-sensitive (Salesforce 15-character ids)
    const key = a.externalId;
    if (seen.has(key)) throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} appears twice`);
    seen.add(key);
    if (!(SAAS_APP_KINDS as readonly unknown[]).includes(a.appKind)) throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} has an unknown app kind`);
    if (!label(a.displayName, SAAS_ENTITLEMENT_LIMITS.displayName)) throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} has an invalid display name`);
    if (!label(a.publisher, SAAS_ENTITLEMENT_LIMITS.publisher)) throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} has an invalid publisher`);
    if (a.publisherVerified !== null && typeof a.publisherVerified !== "boolean") throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} has an invalid publisher flag`);
    if (!Array.isArray(a.grants) || a.grants.length > SAAS_ENTITLEMENT_LIMITS.grantsPerApp) {
      throw new SaasEntitlementBatchRefused(`app ${a.externalId.slice(0, 64)} holds no grant list, or more than ${SAAS_ENTITLEMENT_LIMITS.grantsPerApp} grants`);
    }
    const merged = new Map<string, SaasScopeGrant>();
    for (const rawGrant of a.grants as unknown[]) {
      const g = (rawGrant ?? {}) as Record<string, unknown>;
      if (typeof g.resource !== "string" || g.resource.length > SAAS_ENTITLEMENT_LIMITS.resource || (g.resource !== "" && !PRINTABLE.test(g.resource))) {
        throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} has an invalid resource`);
      }
      if (!printable(g.scope, SAAS_ENTITLEMENT_LIMITS.scope)) throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} has an invalid scope name`);
      if (!(SAAS_GRANT_TYPES as readonly unknown[]).includes(g.grantType)) throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} has an unknown grant type`);
      if (!(SAAS_CONSENT_BREADTHS as readonly unknown[]).includes(g.consent)) throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} has an unknown consent breadth`);
      if (!Array.isArray(g.principals) || g.principals.length > SAAS_ENTITLEMENT_LIMITS.principalsPerGrant) {
        throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} has no principal list, or more than ${SAAS_ENTITLEMENT_LIMITS.principalsPerGrant}`);
      }
      for (const p of g.principals as unknown[]) {
        if (typeof p !== "string" || !DISCOVERY_PSEUDONYM_PATTERN.test(p)) throw new SaasEntitlementBatchRefused(`a grant of ${a.externalId.slice(0, 64)} names a principal that is not a pseudonym`);
      }
      if (g.consent === "tenant" && (g.principals as unknown[]).length > 0) {
        throw new SaasEntitlementBatchRefused(`a tenant-wide grant of ${a.externalId.slice(0, 64)} names principals; a tenant consent has none`);
      }
      const grant: SaasScopeGrant = {
        resource: g.resource,
        scope: g.scope,
        grantType: g.grantType as SaasGrantType,
        consent: g.consent as SaasConsentBreadth,
        principals: [...new Set(g.principals as string[])],
      };
      const k = `${grant.resource}\u0000${grant.scope}\u0000${grant.grantType}`;
      const prev = merged.get(k);
      if (!prev) merged.set(k, grant);
      else {
        // a tenant consent covers every user, so it wins over user consents of the same scope (and drops their names)
        if (grant.consent === "tenant" || prev.consent === "tenant") merged.set(k, { ...prev, consent: "tenant", principals: [] });
        else prev.principals = [...new Set([...prev.principals, ...grant.principals])].slice(0, SAAS_ENTITLEMENT_LIMITS.principalsPerGrant);
      }
    }
    apps.push({
      externalId: a.externalId,
      appKind: a.appKind as SaasAppKind,
      displayName: a.displayName,
      publisher: a.publisher,
      publisherVerified: a.publisherVerified as boolean | null,
      grants: [...merged.values()],
    });
  }
  const revokedPrincipals: SaasRevokedPrincipal[] = [];
  if (b.revokedPrincipals !== undefined) {
    if (!Array.isArray(b.revokedPrincipals) || b.revokedPrincipals.length > SAAS_ENTITLEMENT_LIMITS.revokedPrincipals) {
      throw new SaasEntitlementBatchRefused(`the revocation list is not a list, or holds more than ${SAAS_ENTITLEMENT_LIMITS.revokedPrincipals} entries`);
    }
    for (const raw of b.revokedPrincipals as unknown[]) {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (!printable(r.externalId, SAAS_ENTITLEMENT_LIMITS.externalId)) throw new SaasEntitlementBatchRefused("a revocation names no valid app id");
      if (typeof r.principal !== "string" || !DISCOVERY_PSEUDONYM_PATTERN.test(r.principal)) throw new SaasEntitlementBatchRefused("a revocation names a principal that is not a pseudonym");
      revokedPrincipals.push({ externalId: r.externalId, principal: r.principal });
    }
  }
  const usage = b.usage === undefined ? undefined : checkUsage(b.usage);
  return { platform: expected, tenant: b.tenant, complete: b.complete, apps, revokedPrincipals, ...(usage ? { usage } : {}) };
}

// an ISO 8601 instant a reader produced, not more than a day in the future (a clock skew, never a forged "used later")
const instant = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && t <= Date.now() + 86_400_000;
};
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b);

function checkUsage(raw: unknown): SaasUsageObservation {
  if (!raw || typeof raw !== "object") throw new SaasEntitlementBatchRefused("the usage block is not an object");
  const u = raw as Record<string, unknown>;
  if (!(SAAS_USAGE_COVERAGES as readonly unknown[]).includes(u.coverage)) throw new SaasEntitlementBatchRefused("the usage block has an unknown coverage");
  const coverage = u.coverage as SaasUsageCoverage;
  if (u.windowStart !== null && !instant(u.windowStart)) throw new SaasEntitlementBatchRefused("the usage window start is not a valid time");
  if (!label(u.note, SAAS_ENTITLEMENT_LIMITS.usageNote) || u.note === null) throw new SaasEntitlementBatchRefused("the usage block has no valid note");
  if (!Array.isArray(u.apps) || u.apps.length > SAAS_ENTITLEMENT_LIMITS.apps) throw new SaasEntitlementBatchRefused(`the usage list is not a list, or holds more than ${SAAS_ENTITLEMENT_LIMITS.apps} apps`);
  if (coverage === "none" && u.apps.length > 0) throw new SaasEntitlementBatchRefused("a usage block with coverage 'none' lists use");
  const byApp = new Map<string, SaasAppUsage>();
  for (const rawApp of u.apps as unknown[]) {
    const a = (rawApp ?? {}) as Record<string, unknown>;
    if (!printable(a.externalId, SAAS_ENTITLEMENT_LIMITS.externalId)) throw new SaasEntitlementBatchRefused("a usage entry has no valid app id");
    const read = a.lastReadAt ?? null;
    const write = a.lastWriteAt ?? null;
    if (coverage === "app" && (read !== null || write !== null)) throw new SaasEntitlementBatchRefused("a usage entry splits reads from writes under coverage 'app'");
    if ((read !== null && !instant(read)) || (write !== null && !instant(write))) throw new SaasEntitlementBatchRefused(`a usage entry of ${a.externalId.slice(0, 64)} has an invalid time`);
    // for coverage verb the last use IS the later of the two; anything else would be a second, contradicting fact
    const lastUseAt = coverage === "verb" ? later(read as string | null, write as string | null) : a.lastUseAt;
    if (!instant(lastUseAt)) throw new SaasEntitlementBatchRefused(`a usage entry of ${a.externalId.slice(0, 64)} has no valid last use`);
    const entry: SaasAppUsage = { externalId: a.externalId, lastUseAt, lastReadAt: read as string | null, lastWriteAt: write as string | null };
    const prev = byApp.get(a.externalId);
    byApp.set(
      a.externalId,
      prev
        ? { externalId: a.externalId, lastUseAt: later(prev.lastUseAt, entry.lastUseAt)!, lastReadAt: later(prev.lastReadAt, entry.lastReadAt), lastWriteAt: later(prev.lastWriteAt, entry.lastWriteAt) }
        : entry,
    );
  }
  return { coverage, windowStart: u.windowStart as string | null, note: u.note, apps: [...byApp.values()] };
}

/**
 * Whether one Google API method (the `method_name` of a token `activity` event, e.g. `gmail.users.messages.get`) only
 * reads: its last segment starts with get, list, search, query, batchGet or export. Anything else (insert, send,
 * modify, delete, watch, an unfamiliar verb) counts as a write: secure by default, a method nobody recognises is not
 * assumed harmless. Frozen with the V1 finding rules; a better rule is a new version.
 */
export const GOOGLE_READ_METHOD = /^(?:get|list|search|query|batchGet|export)(?:[A-Z][A-Za-z0-9]*)?$/;
export function classifyGoogleApiMethod(method: string): "read" | "write" {
  const last = method.length > 256 ? "" : (method.split(".").pop() ?? "");
  return GOOGLE_READ_METHOD.test(last) ? "read" : "write";
}

// ---------------------------------------------------------------------------
// scope classification: a frozen, versioned rule set (the ADR-0092 discipline)
// ---------------------------------------------------------------------------

export const SAAS_SCOPE_CLASSIFIER_VERSION = 1;

/**
 * What a scope lets its holder do, judged from its NAME only:
 *  - `read`: reads data or profile information;
 *  - `write`: creates, changes, sends or deletes data;
 *  - `admin`: administers the tenant, its directory, its permissions or every user's data (a full-control,
 *    act-as-user or permission-management scope);
 *  - `unknown`: the rule set does not recognise the name. Findings treat `unknown` like `write` (secure by default):
 *    a scope nobody can read is not assumed harmless.
 */
export const SAAS_SCOPE_ACCESS_CLASSES = ["read", "write", "admin", "unknown"] as const;
export type SaasScopeAccess = (typeof SAAS_SCOPE_ACCESS_CLASSES)[number];

export interface SaasScopeClassification {
  access: SaasScopeAccess;
  /** the rule that decided it, as a plain-language reason that travels with every finding */
  reason: string;
}

interface ScopeRule {
  test: RegExp;
  access: Exclude<SaasScopeAccess, "unknown">;
  reason: string;
}

/**
 * The V1 rules, first match wins, per platform. Each rule is anchored and linear (no nested quantifier). A better
 * rule is a NEW VERSION alongside this one, never an in-place edit under findings that cited v1.
 */
export const SAAS_SCOPE_RULES_V1: Readonly<Record<SaasEntitlementPlatform, readonly ScopeRule[]>> = {
  m365: [
    { test: /^(?:Directory|RoleManagement|AppRoleAssignment|Application|DelegatedPermissionGrant|Policy)\.ReadWrite(?:\.[A-Za-z]+)*$/, access: "admin", reason: "changes the directory, its roles, app registrations, permission grants or policies" },
    { test: /(?:^|\.)(?:FullControl|AccessAsUser|Manage)(?:\.All)?$/, access: "admin", reason: "full control, or acting as the user with all of their rights" },
    { test: /^full_access_as_app$/, access: "admin", reason: "full access to every mailbox, as the app" },
    { test: /(?:^|\.)(?:ReadWrite|Send|Write|Create)(?:\.[A-Za-z]+)*$/, access: "write", reason: "creates, changes, sends or deletes data" },
    { test: /^(?:openid|profile|email|offline_access)$/, access: "read", reason: "an OpenID Connect sign-in or refresh scope" },
    { test: /(?:^|\.)Read(?:Basic)?(?:\.[A-Za-z]+)*$/, access: "read", reason: "reads data" },
  ],
  google_workspace: [
    { test: /^https:\/\/www\.googleapis\.com\/auth\/admin\.[a-z.]+\.readonly$/, access: "read", reason: "reads tenant administration data" },
    { test: /^https:\/\/www\.googleapis\.com\/auth\/(?:admin\.|cloud-platform$|cloud-identity\.)/, access: "admin", reason: "administers the tenant, its users or its cloud resources" },
    { test: /^https:\/\/mail\.google\.com\/$/, access: "admin", reason: "full access to the user's mailbox, including permanent deletion" },
    { test: /^https:\/\/www\.googleapis\.com\/auth\/drive$/, access: "write", reason: "reads, changes and deletes every file in the user's Drive" },
    { test: /^(?:openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/userinfo\.(?:email|profile))$/, access: "read", reason: "an OpenID Connect sign-in scope" },
    { test: /^https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+\.(?:readonly|metadata\.readonly|metadata)$/, access: "read", reason: "reads data or metadata" },
    { test: /^https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+$/, access: "write", reason: "a scope that is not read-only creates, changes or deletes data" },
  ],
  salesforce: [
    { test: /^(?:full|admin_api)$/, access: "admin", reason: "all of the user's data and setup access" },
    { test: /^(?:api|web|visualforce|chatter_api|wave_api|cdp_ingest_api|einstein_gpt_api|interaction_api|content|lightning|sfap_api)$/, access: "write", reason: "acts on the user's data through the Salesforce APIs" },
    { test: /^(?:openid|id|profile|email|address|phone|refresh_token|offline_access|custom_permissions|cdp_profile_api|cdp_query_api)$/, access: "read", reason: "identity, refresh or read-only data access" },
  ],
  slack: [
    { test: /^admin(?:\.[a-z_]+)*(?::[a-z_.]+)?$/, access: "admin", reason: "administers the workspace or the organisation" },
    { test: /^(?:client|identify|bot|post)$/, access: "write", reason: "a legacy scope that acts as the user or as a bot across the workspace" },
    { test: /^[a-z_.]+:(?:write|write\.[a-z_]+|manage|delete)$/, access: "write", reason: "creates, changes or deletes data" },
    { test: /^(?:openid|email|profile)$/, access: "read", reason: "a Sign in with Slack scope" },
    { test: /^identity\.[a-z_]+$/, access: "read", reason: "reads the signed-in user's identity" },
    { test: /^[a-z_.]+:(?:read|history|read\.[a-z_]+)$/, access: "read", reason: "reads data" },
  ],
};
for (const rules of Object.values(SAAS_SCOPE_RULES_V1)) {
  for (const r of rules) Object.freeze(r);
  Object.freeze(rules);
}
Object.freeze(SAAS_SCOPE_RULES_V1);

/** classify one scope name under the V1 rules (pure; the same name always gives the same answer) */
export function classifySaasScope(platform: SaasEntitlementPlatform, scope: string): SaasScopeClassification {
  if (scope.length > SAAS_ENTITLEMENT_LIMITS.scope) return { access: "unknown", reason: "the scope name is longer than any the rules know" };
  for (const rule of SAAS_SCOPE_RULES_V1[platform]) {
    if (rule.test.test(scope)) return { access: rule.access, reason: rule.reason };
  }
  return { access: "unknown", reason: "no rule recognises this scope name, so it is treated as able to change data" };
}

// ---------------------------------------------------------------------------
// Linking a vendor-side app to a RegulAIt agent (owner decision 2026-11-17, ADR-0337 §6)
// ---------------------------------------------------------------------------

/** the link's states and transitions are the declared ADR-0348 machine `SAAS_APP_AGENT_LINK_MACHINE` (state-machines.ts) */

/** an identifier an admin declares for an agent: the app's id on one platform, compared exactly (case-sensitive) */
export const AGENT_VENDOR_IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,255}$/;
