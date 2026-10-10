/**
 * ADR-0188 S1 — the shared identity contract: vocabularies, strict settings,
 * the actor chain (root first, depth = hop count), strict scope semantics, the
 * public-key-only JWK rule, and the audit v2 serialisation.
 */
import { describe, expect, it } from "vitest";
import {
  actClaimFromChain,
  actorChainDepthForGrantDepth,
  actorChainSchema,
  addWorkloadCredentialSchema,
  createWorkloadIdentitySchema,
  defaultWorkloadIdentifier,
  DELEGATION_RULE_IDS,
  delegationScopeItemSchema,
  EMPTY_ACTOR_ENTITLEMENTS,
  IDENTITY_ROUTES,
  IDENTITY_SETTING_KEYS,
  IDENTITY_STRICT_DEFAULTS,
  identitySettingLooser,
  identitySettingRelaxed,
  isSpiffeId,
  putAgentGrantsSchema,
  tokenExchangeRequestSchema,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_DELEGATION_AUTHZ,
  TOKEN_TYPE_DELEGATION_PROOF,
  usdToMicros,
  workloadPublicJwkSchema,
} from "./index.js";
import { updateOrgSettingsSchema, STEP_UP_ACTION_KINDS } from "../index.js";
import {
  AUDIT_PAYLOAD_VERSION,
  AUDIT_PAYLOAD_VERSION_V2,
  auditContentHashFor,
  auditRowHash,
  AUDIT_GENESIS_PREV_HASH,
  canonicalAuditPayloadV2,
  resolveAuditChainBoundary,
  verifyChainBatch,
  type ChainedAuditRow,
} from "../audit-chain.js";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = "A".repeat(43);

describe("ADR-0188 settings: strict by default", () => {
  it("the strict defaults are the ADR's (OWNER DECISION 7, decision 10)", () => {
    expect(IDENTITY_STRICT_DEFAULTS).toEqual({
      agentEntitlementMode: "own_grants",
      delegatedTokenTtlSeconds: 300,
      delegationMaxDepth: 3,
      workloadClientAuthMethods: ["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"],
      dpopNonceRequired: true,
      workloadKeyMaxAgeDays: 90,
    });
  });

  it("names every relaxation, against the default and against a stricter stored value", () => {
    expect(identitySettingRelaxed("agentEntitlementMode", "sponsor_only")).toBe(true);
    expect(identitySettingRelaxed("delegatedTokenTtlSeconds", 301)).toBe(true);
    expect(identitySettingRelaxed("delegatedTokenTtlSeconds", 60)).toBe(false);
    expect(identitySettingRelaxed("delegationMaxDepth", 8)).toBe(true);
    expect(identitySettingRelaxed("delegationMaxDepth", 0)).toBe(false);
    expect(identitySettingRelaxed("dpopNonceRequired", false)).toBe(true);
    // the default is already the widest list and the longest age
    expect(identitySettingRelaxed("workloadClientAuthMethods", ["private_key_jwt"])).toBe(false);
    expect(identitySettingRelaxed("workloadKeyMaxAgeDays", 30)).toBe(false);
    // against the stored value
    expect(identitySettingLooser("workloadClientAuthMethods", ["private_key_jwt", "spiffe_svid"], ["private_key_jwt"])).toBe(true);
    expect(identitySettingLooser("workloadClientAuthMethods", ["private_key_jwt"], ["private_key_jwt", "spiffe_svid"])).toBe(false);
    expect(identitySettingLooser("workloadKeyMaxAgeDays", 90, 30)).toBe(true);
    expect(identitySettingLooser("delegationMaxDepth", 3, 2)).toBe(true);
    expect(identitySettingLooser("agentEntitlementMode", "sponsor_only", "own_grants")).toBe(true);
    expect(IDENTITY_SETTING_KEYS).toHaveLength(6);
  });

  it("PUT /v1/org/settings holds the bounds; client_secret_* can never be added", () => {
    const ok = (v: unknown) => updateOrgSettingsSchema.safeParse(v).success;
    expect(ok({ delegatedTokenTtlSeconds: 59 })).toBe(false);
    expect(ok({ delegatedTokenTtlSeconds: 3601 })).toBe(false);
    expect(ok({ delegationMaxDepth: 9 })).toBe(false);
    expect(ok({ workloadKeyMaxAgeDays: 91 })).toBe(false);
    expect(ok({ agentEntitlementMode: "union" })).toBe(false);
    expect(ok({ workloadClientAuthMethods: ["client_secret_basic"] })).toBe(false);
    expect(ok({ workloadClientAuthMethods: ["client_secret_post"] })).toBe(false);
    expect(ok({ workloadClientAuthMethods: ["private_key_jwt", "private_key_jwt"] })).toBe(false);
    const parsed = updateOrgSettingsSchema.parse({ workloadClientAuthMethods: ["spiffe_svid", "private_key_jwt"] });
    expect(parsed.workloadClientAuthMethods).toEqual(["private_key_jwt", "spiffe_svid"]);
  });

  it("identity_manage is a step-up kind", () => {
    expect(STEP_UP_ACTION_KINDS).toContain("identity_manage");
  });
});

describe("ADR-0188 the actor chain: root first, depth = hop count (decisions 25, 26)", () => {
  const link = (n: number) => ({ identityId: U(n), kind: "agent" as const, identifier: `spiffe://example.org/regulait/agent/${U(n)}` });

  it("a first agent is depth 1, its sub-agent depth 2; depth must equal the actor count", () => {
    expect(actorChainSchema.safeParse({ sponsorUserId: U(9), delegationGrantId: U(8), depth: 1, actors: [link(1)] }).success).toBe(true);
    expect(actorChainSchema.safeParse({ sponsorUserId: U(9), delegationGrantId: U(8), depth: 2, actors: [link(1), link(2)] }).success).toBe(true);
    expect(actorChainSchema.safeParse({ sponsorUserId: U(9), delegationGrantId: U(8), depth: 1, actors: [link(1), link(2)] }).success).toBe(false);
    // a human acting directly is `actor: null`, never an empty chain
    expect(actorChainSchema.safeParse({ sponsorUserId: U(9), delegationGrantId: U(8), depth: 0, actors: [] }).success).toBe(false);
    // an identity at most once
    expect(actorChainSchema.safeParse({ sponsorUserId: U(9), delegationGrantId: U(8), depth: 2, actors: [link(1), link(1)] }).success).toBe(false);
    // ten hops is past the ceiling (a root plus eight descendants)
    const ten = Array.from({ length: 10 }, (_, i) => link(i + 1));
    expect(actorChainSchema.safeParse({ sponsorUserId: U(99), delegationGrantId: U(98), depth: 10, actors: ten }).success).toBe(false);
  });

  it("the leaf grant's stored depth (ancestor count) maps to the hop count", () => {
    expect(actorChainDepthForGrantDepth(0)).toBe(1);
    expect(actorChainDepthForGrantDepth(8)).toBe(9);
  });

  it("the RFC 8693 act claim is derived: outermost = the leaf (last), nested to the root (first)", () => {
    expect(actClaimFromChain([{ identifier: "spiffe://t/a" }, { identifier: "spiffe://t/b" }, { identifier: "spiffe://t/c" }])).toEqual({
      sub: "spiffe://t/c",
      act: { sub: "spiffe://t/b", act: { sub: "spiffe://t/a" } },
    });
    expect(actClaimFromChain([])).toBeUndefined();
  });

  it("the rule ids include the per-actor refusal and the chain refusal (decision 28)", () => {
    expect(DELEGATION_RULE_IDS).toEqual(
      expect.arrayContaining(["agent-allow-list", "actor-allow-list", "actor-chain-invalid", "delegation-scope", "delegation-depth", "delegation-budget", "lead-ceiling"]),
    );
  });
});

describe("ADR-0188 scope and grants: absence is denial (decision 27)", () => {
  it("a scope entry names exactly its own object; tool names and modes only where they mean something", () => {
    expect(delegationScopeItemSchema.safeParse({ type: "mcp_tool", serverId: U(1), toolNames: ["t"], kind: "read" }).success).toBe(true);
    expect(delegationScopeItemSchema.safeParse({ type: "mcp_tool", connectorId: U(1), kind: "read" }).success).toBe(false);
    expect(delegationScopeItemSchema.safeParse({ type: "connector", connectorId: U(1), toolNames: ["t"], kind: "write" }).success).toBe(false);
    expect(delegationScopeItemSchema.safeParse({ type: "agent", agentId: U(1), modes: ["chat"], kind: "read" }).success).toBe(true);
    expect(delegationScopeItemSchema.safeParse({ type: "agent", agentId: U(1), kind: "admin" }).success).toBe(false);
  });

  it("an agent's own grants: modes and objects are explicit lists, never null = everything", () => {
    const base = { tools: [], servers: [], agents: [], connectors: [], roleIds: [], revision: 0 };
    expect(putAgentGrantsSchema.safeParse(base).success).toBe(true);
    // X33: the whole-set replacement names the revision it read
    const { revision: _r, ...noRevision } = base;
    expect(putAgentGrantsSchema.safeParse(noRevision).success).toBe(false);
    expect(putAgentGrantsSchema.safeParse({ ...base, revision: -1 }).success).toBe(false);
    expect(putAgentGrantsSchema.safeParse({ ...base, agents: [{ agentId: U(1), allowedModes: null }] }).success).toBe(false);
    expect(putAgentGrantsSchema.safeParse({ ...base, connectors: [{ connectorId: U(1), mode: "read", allowedObjects: null }] }).success).toBe(false);
    expect(putAgentGrantsSchema.safeParse({ ...base, tools: [{ serverId: U(1), toolName: "a" }, { serverId: U(1), toolName: "a" }] }).success).toBe(false);
    expect(EMPTY_ACTOR_ENTITLEMENTS).toEqual({ tools: [], servers: [], agents: [], connectors: [] });
  });
});

describe("ADR-0188 identities and credentials", () => {
  it("SPIFFE identifiers", () => {
    expect(isSpiffeId("spiffe://example.org/regulait/agent/x")).toBe(true);
    expect(isSpiffeId("spiffe://Example.org/a")).toBe(false);
    expect(isSpiffeId("spiffe://example.org")).toBe(false);
    expect(isSpiffeId("spiffe://example.org/a/../b")).toBe(false);
    expect(isSpiffeId("https://example.org/a")).toBe(false);
    expect(defaultWorkloadIdentifier("example.org", "builder_agent", U(1))).toBe(`spiffe://example.org/regulait/builder_agent/${U(1)}`);
    expect(() => defaultWorkloadIdentifier("Bad Domain", "agent", U(1))).toThrow();
  });

  it("an identity names exactly the subject its kind needs", () => {
    const base = { sponsorUserIds: [U(9)], environments: ["dev"] };
    expect(createWorkloadIdentitySchema.safeParse({ ...base, kind: "agent", agentId: U(1) }).success).toBe(true);
    expect(createWorkloadIdentitySchema.safeParse({ ...base, kind: "agent" }).success).toBe(false);
    expect(createWorkloadIdentitySchema.safeParse({ ...base, kind: "pdp", agentId: U(1) }).success).toBe(false);
    expect(createWorkloadIdentitySchema.safeParse({ ...base, kind: "pdp", sponsorUserIds: [] }).success).toBe(false);
    expect(createWorkloadIdentitySchema.safeParse({ ...base, kind: "pdp", environments: ["Prod!"] }).success).toBe(false);
  });

  it("a workload credential is a PUBLIC key: any private or symmetric member is refused", () => {
    expect(workloadPublicJwkSchema.safeParse({ kty: "OKP", crv: "Ed25519", x: X }).success).toBe(true);
    expect(workloadPublicJwkSchema.safeParse({ kty: "EC", crv: "P-256", x: X, y: X }).success).toBe(true);
    for (const m of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      expect(workloadPublicJwkSchema.safeParse({ kty: "OKP", crv: "Ed25519", x: X, [m]: X }).success, m).toBe(false);
    }
    expect(workloadPublicJwkSchema.safeParse({ kty: "RSA", n: X, e: "AQAB" }).success).toBe(false);
    expect(workloadPublicJwkSchema.safeParse({ kty: "oct", k: X }).success).toBe(false);
    expect(addWorkloadCredentialSchema.safeParse({ kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x: X, d: X } }).success).toBe(false);
  });

  it("micro-dollars never round a cap wider", () => {
    expect(usdToMicros(1)).toBe(1_000_000);
    expect(usdToMicros(0.0000001)).toBe(1);
    expect(() => usdToMicros(-1)).toThrow();
  });
});

describe("ADR-0188 the token-exchange form (decisions 15, 23)", () => {
  const root = {
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: "x.y.z",
    subject_token_type: TOKEN_TYPE_DELEGATION_PROOF,
    requested_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    resource: "https://gw.example/mcp/1",
    authorization_details: "[]",
  };
  it("a root takes no actor_token; a child must carry the parent's delegation authorization", () => {
    expect(tokenExchangeRequestSchema.safeParse(root).success).toBe(true);
    expect(tokenExchangeRequestSchema.safeParse({ ...root, actor_token: "a", actor_token_type: TOKEN_TYPE_DELEGATION_AUTHZ }).success).toBe(false);
    const child = { ...root, subject_token_type: TOKEN_TYPE_ACCESS_TOKEN };
    expect(tokenExchangeRequestSchema.safeParse(child).success).toBe(false);
    expect(tokenExchangeRequestSchema.safeParse({ ...child, actor_token: "a", actor_token_type: TOKEN_TYPE_DELEGATION_AUTHZ }).success).toBe(true);
    // a plain DPoP proof is not the actor token any more (decision 23)
    expect(
      tokenExchangeRequestSchema.safeParse({ ...child, actor_token: "a", actor_token_type: "urn:regulait:params:oauth:token-type:dpop-proof" }).success,
    ).toBe(false);
  });

  it("the route list has one DELETE and every route a class", () => {
    expect(IDENTITY_ROUTES.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(new Set(IDENTITY_ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(IDENTITY_ROUTES.length);
  });
});

describe("ADR-0188 decision 19: the audit v2 serialisation", () => {
  const row = (seq: number, extra: Partial<ChainedAuditRow> = {}): Omit<ChainedAuditRow, "contentHash" | "prevHash" | "rowHash"> => ({
    seq,
    id: U(1000 + seq),
    at: new Date(Date.UTC(2026, 9, 10, 0, 0, seq)),
    userId: U(1),
    objectType: "mcp_tool",
    objectId: null,
    detail: { n: seq },
    serverId: null,
    toolName: null,
    effect: "allow",
    ruleId: "r",
    ruleChain: ["r"],
    reason: "ok",
    deployMode: null,
    ...extra,
  });
  /** build a chain the way the writer does: rows at or past `v2From` hash as v2 and carry version 2 */
  function chain(n: number, v2From: number | null, actorAt?: number): ChainedAuditRow[] {
    let prev = AUDIT_GENESIS_PREV_HASH;
    const out: ChainedAuditRow[] = [];
    for (let seq = 1; seq <= n; seq += 1) {
      const v2 = v2From !== null && seq >= v2From;
      const base = row(seq, {
        chainVersion: v2 ? 2 : null,
        ...(seq === actorAt ? { actorIdentityId: U(50), delegationGrantId: U(51), actorChain: [U(50)] } : {}),
      });
      const contentHash = auditContentHashFor(base as ChainedAuditRow, v2 ? 2 : 1);
      const rowHash = auditRowHash(prev, contentHash);
      out.push({ ...(base as ChainedAuditRow), contentHash, prevHash: prev, rowHash });
      prev = rowHash;
    }
    return out;
  }
  const verify = (rows: ChainedAuditRow[], v2FromSeq: number | null) =>
    verifyChainBatch(rows, { expectedSeq: 1, prevRowHash: AUDIT_GENESIS_PREV_HASH, v2FromSeq }).break;

  it("v2 carries its version and the three actor fields, nulls explicit", () => {
    const p = canonicalAuditPayloadV2(row(1) as ChainedAuditRow);
    expect(p.startsWith(`${AUDIT_PAYLOAD_VERSION_V2}\n`)).toBe(true);
    expect(p).toContain('"chainVersion":2');
    expect(p).toContain('"actorChain":null');
    expect(p).toContain('"actorIdentityId":null');
    expect(p).toContain('"delegationGrantId":null');
    expect(AUDIT_PAYLOAD_VERSION).toBe("regulait.audit.v1");
    // the same facts hash differently under v1 and v2
    expect(auditContentHashFor(row(1) as ChainedAuditRow, 1)).not.toBe(auditContentHashFor(row(1) as ChainedAuditRow, 2));
  });

  it("a chain spanning the boundary verifies; with no boundary every row is v1", () => {
    expect(verify(chain(6, 4, 5), 4)).toBeNull();
    expect(verify(chain(6, null), null)).toBeNull();
  });

  it("editing actor_chain on a v2 row breaks it", () => {
    const rows = chain(6, 4, 5);
    rows[4] = { ...rows[4]!, actorChain: [U(77)] };
    expect(verify(rows, 4)).toMatchObject({ seq: 5, kind: "content_mismatch" });
  });

  it("a v2 row that claims version 1, or no version, fails; so does a v1 row claiming 2", () => {
    const a = chain(6, 4);
    a[4] = { ...a[4]!, chainVersion: 1 };
    expect(verify(a, 4)).toMatchObject({ seq: 5, kind: "version_mismatch" });
    const b = chain(6, 4);
    b[3] = { ...b[3]!, chainVersion: null };
    expect(verify(b, 4)).toMatchObject({ seq: 4, kind: "version_mismatch" });
    const c = chain(6, null);
    c[1] = { ...c[1]!, chainVersion: 2 };
    expect(verify(c, null)).toMatchObject({ seq: 2, kind: "version_mismatch" });
  });

  it("a row past the boundary hashed as v1 (but labelled 2) fails", () => {
    // written by a v1-only writer past the boundary, then relabelled
    const rows = chain(6, null);
    for (const r of rows.slice(3)) r.chainVersion = 2;
    expect(verify(rows, 4)).toMatchObject({ seq: 4, kind: "content_mismatch" });
  });

  it("X35 I7S-01: actor fields on a v1 row are a break, though its v1 hash still matches", () => {
    for (const extra of [
      { actorIdentityId: U(50), delegationGrantId: U(51), actorChain: [U(50)] },
      { actorChain: [U(50)] },
    ]) {
      const rows = chain(6, null);
      const tampered = { ...rows[2]!, ...extra };
      // the v1 hash does not cover the actor fields: content alone would pass
      expect(auditContentHashFor(tampered, 1)).toBe(rows[2]!.contentHash);
      rows[2] = tampered;
      expect(verify(rows, null)).toMatchObject({ seq: 3, kind: "actor_on_v1" });
    }
    // a v1 row before a recorded boundary is checked the same way
    const spanning = chain(6, 4);
    spanning[1] = { ...spanning[1]!, actorIdentityId: U(50), delegationGrantId: U(51), actorChain: [U(50)] };
    expect(verify(spanning, 4)).toMatchObject({ seq: 2, kind: "actor_on_v1" });
  });

  it("X35 I7S-02: one boundary interpretation; an unknown version is unsupported, never skipped", () => {
    expect(resolveAuditChainBoundary([])).toEqual({ supported: true, v2FromSeq: null });
    expect(resolveAuditChainBoundary([{ version: 2, fromSeq: 9 }])).toEqual({ supported: true, v2FromSeq: 9 });
    expect(resolveAuditChainBoundary([{ version: 3, fromSeq: 2 }])).toMatchObject({ supported: false, version: 3, fromSeq: 2 });
    expect(resolveAuditChainBoundary([{ version: 2, fromSeq: 9 }, { version: 3, fromSeq: 20 }])).toMatchObject({
      supported: false,
      version: 3,
      fromSeq: 20,
    });
  });
});
