/**
 * The mocked gateway for the P3 long-page split on the identity-and-access pages (workload identities, SSO, ChatOps,
 * licensing, agents): the list contract for the lists that moved to their own pages, and just enough of every other
 * read for each overview to render. Shared by long-pages-identity.mock.spec.ts; not a spec itself.
 */
import type { Page, Route } from "@playwright/test";

type Json = Record<string, unknown>;
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 60_000).toISOString();
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const LATER = "2027-10-01T00:00:00.000Z";

export const ME = { userId: uuid("11111111", 1), isAdmin: true, user: { id: uuid("11111111", 1), email: "ada@example.test", displayName: "Ada Admin" } };
const PEOPLE = [
  { id: uuid("11111111", 1), email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: at(1), totpEnabled: true, hasPassword: true, mustChangePassword: false, username: null },
  { id: uuid("11111111", 2), email: "morgan@example.test", displayName: "Morgan Reyes", isAdmin: false, disabledAt: null, createdAt: at(2), totpEnabled: true, hasPassword: true, mustChangePassword: false, username: null },
];

/** 27 identities: 2 suspended, 1 revoked */
export const IDENTITIES = Array.from({ length: 27 }, (_, i) => ({
  id: uuid("22222222", i),
  kind: "agent",
  agentId: uuid("44444444", i),
  builderAgentId: null,
  engineRunnerId: null,
  identifier: `spiffe://example.test/regulait/agent/credit-limit-${String(i).padStart(2, "0")}`,
  sponsorUserIds: [PEOPLE[1]!.id],
  stewardNames: "Morgan Reyes",
  environments: ["dev"],
  status: i === 3 || i === 9 ? "suspended" : i === 15 ? "revoked" : "active",
  grantsRevision: 1,
  createdBy: PEOPLE[0]!.id,
  createdAt: at(i),
  updatedAt: at(i),
}));
/** 14 link requests: 12 pending, the second-newest of them expired */
export const LINK_REQUESTS = Array.from({ length: 14 }, (_, i) => ({
  id: uuid("33333333", i),
  userId: PEOPLE[1]!.id,
  userEmail: `person${i}@example.test`,
  userDisplayName: `Dana Developer ${i}`,
  provider: "Corporate IdP",
  protocol: "oidc",
  subject: `sub-${i}`,
  email: `person${i}@example.test`,
  idpMfa: i % 2 === 0,
  status: i < 12 ? "pending" : "denied",
  approvals: 0,
  requiredApprovals: 1,
  expired: i === 1,
  createdAt: at(i),
  expiresAt: LATER,
  decidedAt: null,
}));
/** 31 identity links: 12 admin-asserted */
export const CHAT_LINKS = Array.from({ length: 31 }, (_, i) => ({
  id: uuid("55555555", i),
  connectionId: uuid("66666666", 1),
  connectionName: "team-17 workspace",
  chatUserId: `U${String(i).padStart(8, "0")}`,
  chatUserEmail: `person${i}@example.test`,
  userId: PEOPLE[1]!.id,
  emailVerifiedSource: i % 5 < 2 ? "admin_asserted" : "idp",
  createdAt: at(i),
}));
/** 45 verifications: 12 refused */
export const VERIFICATIONS = Array.from({ length: 45 }, (_, i) => ({
  id: uuid("77777777", i),
  at: at(i),
  trigger: "manual",
  ok: i % 4 !== 0,
  state: "valid",
  ruleId: `licence-rule-${String(i).padStart(2, "0")}`,
  reason: "checked",
  signingKeyId: null,
}));
export const AGENTS = Array.from({ length: 31 }, (_, i) => ({
  id: uuid("44444444", i),
  name: i === 0 ? "Credit-limit-increase assistant" : `Agent ${String(i).padStart(2, "0")}`,
  provider: "mock",
  tier: (i % 3) + 1,
  model: `model-${i % 5}`,
  enabled: i % 6 !== 0,
  costPerMTokIn: i % 2 ? 1 : null,
  costPerMTokOut: i % 2 ? 2 : null,
  systemPrompt: null,
  createdAt: at(i),
  lifecycleStatus: "active",
  ownerUserId: PEOPLE[1]!.id,
  stewardName: "Morgan Reyes",
  successorName: null,
  orphaned: i === 7,
  reviewOverdue: i === 8,
  cadence: null,
}));

const allow = { allowed: true, ruleId: "licence-valid", reason: "a valid licence" };
const LICENCE_STATUS = {
  licensed: true,
  state: "valid",
  reason: "a valid licence is installed",
  tenant: "team-17",
  tier: "enterprise",
  deploymentMode: "hosted",
  expiresAt: LATER,
  graceEndsAt: null,
  daysRemaining: 336,
  hardStopOnExpiry: false,
  seats: { active: 3, cap: 10, remaining: 7, canProvision: true, ruleId: "seat-cap", reason: "under the cap", definition: "active users" },
  features: { sso: true },
  actionClasses: { read: allow, governance: allow, expansion: allow },
  inventory: [{ action: "create user", class: "expansion", why: "adds a seat" }],
  keyring: { dir: "/etc/regulait/licence-keys", pinnedKeyIds: ["key-1"] },
  lastVerifiedAt: at(0),
  schedulerPresent: false,
  phoneHome: false,
  enforcementPointsWired: ["POST /v1/users"],
  posture: "Licensing never stops governance.",
  note: "",
};

/** seven proposals from observed use, two of which no steward holds */
const PROPOSALS = (identityId: string) => ({
  identityId,
  windowDays: 30,
  since: at(100),
  revision: 1,
  unproposable: 0,
  truncated: false,
  proposals: Array.from({ length: 7 }, (_, i) => ({
    grant: { kind: "agent", agentId: uuid("44444444", i), allowedModes: ["execute"] },
    observedCalls: 3,
    refusedCalls: 1,
    lastObservedAt: at(i),
    heldByStewards: i % 3 !== 0 || i === 6,
    refusalOnly: false,
  })),
  currentSet: { tools: [], servers: [], connectors: [], roleIds: [], agents: [], revision: 1 },
  proposedSet: { tools: [], servers: [], connectors: [], roleIds: [], agents: [], revision: 1 },
});

/** strict everywhere except one audited relaxation, which the identity page's Settings tab counts */
const ORG_SETTINGS = {
  agentEntitlementMode: "own_grants",
  delegatedTokenTtlSeconds: 300,
  delegationMaxDepth: 3,
  workloadClientAuthMethods: ["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"],
  dpopNonceRequired: true,
  workloadKeyMaxAgeDays: 90,
  delegationUncappedRootAllowed: true,
  delegationRootDefaultCapMicros: 0,
  delegationRootMaxLifetimeSeconds: 900,
  stepUpMode: "enforce",
  stepUpMaxAgeSeconds: 300,
  stepUpActions: [],
};
/** a SAML provider that trusts every email domain: a warning the SSO page's SAML tab counts */
const SAML_ANY_DOMAIN = {
  id: uuid("88888888", 1),
  name: "team-17 SAML",
  entityId: "https://idp.example.test/saml",
  ssoUrl: "https://idp.example.test/sso",
  idpSigningCerts: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"],
  allowedEmailDomains: [],
  jitProvisioning: false,
  groupsAttribute: null,
  allowIdpInitiated: false,
  enabled: true,
  defaultRoleId: null,
  createdAt: at(1),
};

const pick = (r: Json, p: string) => p.split(".").reduce<unknown>((v, k) => (v as Json | null)?.[k], r) as string | number | boolean | null;

/** the list contract over each list; `filter` mirrors the gateway's own filters */
const LISTS: Record<string, { rows: Json[]; key: string; filter: (r: Json, q: URLSearchParams) => boolean; extra?: Json }> = {
  "/v1/workload-identities": { rows: IDENTITIES, key: "items", filter: (r, q) => (!q.get("status") || r.status === q.get("status")) && (!q.get("kind") || r.kind === q.get("kind")) },
  "/v1/auth/link-requests": {
    rows: LINK_REQUESTS,
    key: "requests",
    filter: (r, q) => (q.get("status") ?? "pending") === "all" || r.status === (q.get("status") ?? "pending"),
  },
  "/v1/chatops/identity-links": {
    rows: CHAT_LINKS,
    key: "links",
    filter: (r, q) => !q.get("verification") || r.emailVerifiedSource === q.get("verification"),
    extra: { posture: "A chat user id is an assertion delivered by the bot's connection." },
  },
  "/v1/licenses/verifications": { rows: VERIFICATIONS, key: "verifications", filter: (r, q) => !q.get("ok") || String(r.ok) === q.get("ok"), extra: { schedulerPresent: false } },
  "/v1/agents": { rows: AGENTS, key: "agents", filter: (r, q) => (!q.get("id") || r.id === q.get("id")) && (!q.get("enabled") || String(r.enabled) === q.get("enabled")) },
};
const SORT_FIELD: Record<string, string> = { created: "createdAt", updated: "updatedAt", when: "createdAt", at: "at", identifier: "identifier", status: "status", name: "name" };

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const field = SORT_FIELD[q.get("sort") ?? ""] ?? q.get("sort") ?? "id";
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const rows = list.rows
    .filter((r) => list.filter(r, q))
    .sort((a, b) => {
      const x = pick(a, field);
      const y = pick(b, field);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * dir;
    });
  const limit = Number(q.get("limit"));
  const start = Number(q.get("offset") ?? 0);
  const more = start + limit < rows.length;
  return { ...list.extra, items: rows.slice(start, start + limit), nextCursor: null, nextOffset: more ? start + limit : null, total: q.get("count") ? rows.length : null, totalIsEstimate: false };
}

export interface Capture {
  lists: URL[];
  exports: URL[];
}

export async function mockApi(page: Page): Promise<Capture> {
  const cap: Capture = { lists: [], exports: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p.endsWith("/export.xlsx")) {
      cap.exports.push(url);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    if (LISTS[p] && method === "GET") {
      if (url.searchParams.get("sort") || url.searchParams.get("count")) {
        cap.lists.push(url);
        return json(route, contract(p, url.searchParams));
      }
      return json(route, { ...LISTS[p]!.extra, [LISTS[p]!.key]: LISTS[p]!.rows, nextCursor: null });
    }
    const one = /^\/v1\/workload-identities\/([^/]+)(\/[a-z-]+)?$/.exec(p);
    if (one && method === "GET") {
      const identity = IDENTITIES.find((x) => x.id === one[1]);
      if (!identity) return json(route, { error: "identity_not_found" }, 404);
      if (!one[2]) return json(route, { ...identity, activeCredentialCount: 0, liveDelegationGrantCount: 0 });
      if (one[2] === "/grants") return json(route, { identityId: identity.id, revision: 1, tools: [], servers: [], agents: [], connectors: [], roleIds: [] });
      if (one[2] === "/credentials") return json(route, { items: [] });
      if (one[2] === "/grant-proposals") return json(route, PROPOSALS(identity.id));
    }
    if (p === "/v1/users") return json(route, { users: PEOPLE });
    if (p === "/v1/users/directory") return json(route, { users: PEOPLE });
    if (p === "/v1/licenses/status") return json(route, LICENCE_STATUS);
    if (p === "/v1/licenses") return json(route, { licenses: [] });
    if (p === "/v1/org/settings") return json(route, { settings: ORG_SETTINGS });
    if (p === "/v1/auth/oidc-providers") return json(route, { providers: [] });
    if (p === "/v1/auth/saml-providers") return json(route, { providers: [SAML_ANY_DOMAIN] });
    if (p === "/v1/chatops/connections") return json(route, { connections: [], posture: "" });
    if (p === "/v1/chatops/builder-routes") return json(route, { routes: [] });
    if (p === "/v1/identity/signing-keys") return json(route, { items: [], configuration: null });
    if (p === "/v1/identity/spiffe-trust-bundles" || p === "/v1/identity/spiffe-bundle-endpoints") return json(route, { items: [] });
    if (p === "/v1/identity/picker-sources") return json(route, { sponsors: [], subjects: { agent: [], builder_agent: [], engine_runner: [] }, environments: [], servers: [], agents: [], connectors: [], roles: [], workerIdentities: [], truncated: false });
    if (p === "/v1/delegation-grants") return json(route, { items: [], edges: [], nextCursor: null });
    for (const [path, key] of [
      ["/v1/roles", "roles"],
      ["/v1/servers", "servers"],
      ["/v1/connectors", "connectors"],
      ["/v1/approvals", "approvals"],
      ["/v1/custom-model-providers", "providers"],
      ["/v1/projects", "projects"],
      ["/v1/teams", "teams"],
    ] as const) {
      if (p === path) return json(route, { [key]: [] });
    }
    return json(route, {});
  });
  return cap;
}

/** the five pages this batch measured, at 1440 px, with these mocks */
export const LONG_PAGES = [
  { name: "Workload identities", path: "/ui/admin/workload-identities" },
  { name: "SSO", path: "/ui/admin/sso" },
  { name: "Agents", path: "/ui/admin/agents" },
  { name: "ChatOps", path: "/ui/admin/chatops" },
  { name: "Licensing", path: "/ui/admin/licensing" },
] as const;
