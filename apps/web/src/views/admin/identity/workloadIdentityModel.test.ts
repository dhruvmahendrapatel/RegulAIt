import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_GRANT_MODES,
  ENVIRONMENT_NAME_PATTERN,
  GRANTS_REVISION_CONFLICT,
  GRANT_SET_LIMITS,
  PRIVATE_JWK_MEMBERS,
  REFUSAL_SENTENCES,
  SPIFFE_ID_PATTERN,
  WORKLOAD_CREDENTIAL_KINDS,
  WORKLOAD_CREDENTIAL_MAX_DAYS,
  IDENTITY_ROUTES_NOT_BUILT,
  WORKLOAD_IDENTITY_KINDS,
  WORKLOAD_IDENTITY_MAX_ENVIRONMENTS,
  WORKLOAD_IDENTITY_MAX_STEWARDS,
  WORKLOAD_IDENTITY_STATUSES,
  createIdentityBody,
  defaultProposalSelection,
  proposalKey,
  setWithProposals,
  credentialBody,
  credentialState,
  delegationRefusalMessages,
  delegationState,
  formatMicros,
  grantRows,
  grantSetWith,
  grantSetWithout,
  identityRefusalSentence,
  nameList,
  orderedDelegationTree,
  remainingMicros,
  stewardsAndEnvironmentsChange,
  validateStewardsAndEnvironments,
  type DelegationAllocationView,
  type DelegationGrantView,
  type PutAgentGrants,
} from "./workloadIdentityModel";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const contract = readFileSync(new URL("../../../../../../packages/shared/src/identity/contract.ts", import.meta.url), "utf8");
const gatewayRoutes = readFileSync(new URL("../../../../../gateway/src/identity-routes.ts", import.meta.url), "utf8");

describe("mirror of packages/shared/src/identity/contract.ts", () => {
  const arrayOf = (name: string) => {
    const m = contract.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
    expect(m, name).not.toBeNull();
    return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  const numberOf = (name: string) => Number(contract.match(new RegExp(`export const ${name} = (\\d+);`))?.[1]);

  it("kinds, statuses and connector modes match", () => {
    expect(arrayOf("WORKLOAD_IDENTITY_KINDS")).toEqual([...WORKLOAD_IDENTITY_KINDS]);
    expect(arrayOf("WORKLOAD_IDENTITY_STATUSES")).toEqual([...WORKLOAD_IDENTITY_STATUSES]);
    expect(arrayOf("CONNECTOR_GRANT_MODES")).toEqual([...CONNECTOR_GRANT_MODES]);
  });
  it("steward and environment limits and the environment pattern match", () => {
    expect(numberOf("WORKLOAD_IDENTITY_MAX_STEWARDS")).toBe(WORKLOAD_IDENTITY_MAX_STEWARDS);
    expect(numberOf("WORKLOAD_IDENTITY_MAX_ENVIRONMENTS")).toBe(WORKLOAD_IDENTITY_MAX_ENVIRONMENTS);
    expect(contract).toContain(`export const ENVIRONMENT_NAME_PATTERN = ${ENVIRONMENT_NAME_PATTERN.toString()};`);
    expect(contract).toContain(`export const GRANTS_REVISION_CONFLICT = "${GRANTS_REVISION_CONFLICT}" as const;`);
  });
  it("S6 credential kinds, limits, private members and the SPIFFE pattern match", () => {
    expect(arrayOf("WORKLOAD_CREDENTIAL_KINDS")).toEqual([...WORKLOAD_CREDENTIAL_KINDS]);
    expect(arrayOf("PRIVATE_JWK_MEMBERS")).toEqual([...PRIVATE_JWK_MEMBERS]);
    expect(numberOf("WORKLOAD_CREDENTIAL_MAX_DAYS")).toBe(WORKLOAD_CREDENTIAL_MAX_DAYS);
    expect(contract).toContain(`export const SPIFFE_ID_PATTERN = ${SPIFFE_ID_PATTERN.toString()};`);
  });
  it("grant-set bounds match the shared schema", () => {
    expect(contract).toContain(`z.array(identityToolGrantSchema).max(${GRANT_SET_LIMITS.tools})`);
    expect(contract).toContain(`z.array(identityServerGrantSchema).max(${GRANT_SET_LIMITS.servers})`);
    expect(contract).toContain(`z.array(identityAgentGrantSchema).max(${GRANT_SET_LIMITS.agents})`);
    expect(contract).toContain(`z.array(identityConnectorGrantSchema).max(${GRANT_SET_LIMITS.connectors})`);
    expect(contract).toContain(`allowedModes: uniqueStrings(modeName, ${GRANT_SET_LIMITS.modes})`);
    expect(contract).toContain(`const modeName = z.string().trim().min(1).max(${GRANT_SET_LIMITS.modeNameLength});`);
    expect(contract).toContain(`const toolName = z.string().trim().min(1).max(${GRANT_SET_LIMITS.toolNameLength});`);
    expect(contract).toContain(`uniqueStrings(z.string().trim().min(1).max(${GRANT_SET_LIMITS.objectNameLength}), ${GRANT_SET_LIMITS.objects})`);
    expect(contract).toMatch(new RegExp(`roleIds: z\\s*\\.array\\(z\\.string\\(\\)\\.uuid\\(\\)\\)\\s*\\.max\\(${GRANT_SET_LIMITS.roleIds}\\)`));
  });
});

describe("routes the page treats as not built", () => {
  it("are exactly the identity routes the gateway still answers with the 501 stub", () => {
    const stubbed = [...gatewayRoutes.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)",\s*notBuilt\)/g)]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
      .sort();
    // S6 built the last stub, so both lists are empty. When this fails because a
    // stub reappeared, list it here and disable its control on the page.
    expect(IDENTITY_ROUTES_NOT_BUILT.map((r) => `${r.method} ${r.path}`).sort()).toEqual(stubbed);
  });
});

describe("display rules", () => {
  it("formats micro-dollars without inventing a zero", () => {
    expect(formatMicros(1_500_000)).toBe("$1.50");
    expect(formatMicros(1)).toBe("$0.000001");
    expect(formatMicros(0)).toBe("$0.00");
    expect(formatMicros(-2_000_000)).toBe("−$2.00");
    expect(formatMicros(null)).toBe("Unmeasured");
    expect(formatMicros(1.5)).toBe("Unmeasured");
  });
  it("remaining is cap minus settled minus reserved, and null when uncapped", () => {
    expect(remainingMicros({ capMicros: 100, settledMicros: 10, reservedMicros: 50 })).toBe(40);
    expect(remainingMicros({ capMicros: null, settledMicros: 10, reservedMicros: 0 })).toBeNull();
  });
  it("revoked wins over expiry; an unreadable expiry is unmeasured, never live", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(delegationState({ revokedAt: "2026-10-11T11:00:00Z", expiresAt: "2026-10-11T13:00:00Z" }, now)).toBe("revoked");
    expect(delegationState({ revokedAt: null, expiresAt: "2026-10-11T11:59:59Z" }, now)).toBe("expired");
    expect(delegationState({ revokedAt: null, expiresAt: "2026-10-11T12:15:00Z" }, now)).toBe("live");
    expect(delegationState({ revokedAt: null, expiresAt: "unreadable" }, now)).toBe("unmeasured");
  });
});

describe("stewards and environments", () => {
  it("requires a steward and bounds both lists", () => {
    expect(validateStewardsAndEnvironments([], [])).toMatch(/at least one steward/);
    expect(validateStewardsAndEnvironments([U(1), U(1)], [])).toMatch(/distinct stewards/);
    expect(validateStewardsAndEnvironments(Array.from({ length: 11 }, (_, i) => U(i + 1)), [])).toMatch(/up to 10/);
    expect(validateStewardsAndEnvironments([U(1)], ["Prod"])).toMatch(/lowercase/);
    expect(validateStewardsAndEnvironments([U(1)], ["dev", "dev"])).toMatch(/distinct environments/);
    expect(validateStewardsAndEnvironments([U(1)], [])).toBeNull();
  });
  it("sends only what changed, and nothing when nothing did", () => {
    const identity = { sponsorUserIds: [U(1)], environments: ["dev"] };
    expect(stewardsAndEnvironmentsChange(identity, [U(1)], ["dev"])).toBeNull();
    expect(stewardsAndEnvironmentsChange(identity, [U(1), U(2)], ["dev"])).toEqual({ sponsorUserIds: [U(1), U(2)] });
    expect(stewardsAndEnvironmentsChange(identity, [U(1)], [])).toEqual({ environments: [] });
  });
});

describe("own grant set", () => {
  const set: PutAgentGrants = {
    tools: [{ serverId: U(1), toolName: "read_record" }],
    servers: [{ serverId: U(2), readOnlyAll: true }],
    agents: [{ agentId: U(3), allowedModes: [] }],
    connectors: [{ connectorId: U(4), mode: "read", allowedObjects: ["Account"] }],
    roleIds: [U(5)],
    revision: 7,
  };
  it("lists every kind, saying what an empty list allows", () => {
    const rows = grantRows(set);
    expect(rows.map((r) => r.kind)).toEqual(["tool", "server", "agent", "connector", "role"]);
    expect(rows[1]!.access).toBe("Every read-only tool");
    expect(rows[2]!.access).toBe("No mode allowed");
    expect(rows[3]!.access).toBe("Read; objects: Account");
  });
  it("removing keeps the rest of the set and the revision read, without mutating it", () => {
    const before = JSON.stringify(set);
    const next = grantSetWithout(set, `tool:${U(1)}:read_record`)!;
    expect(next.tools).toEqual([]);
    expect(next.servers).toEqual(set.servers);
    expect(next.roleIds).toEqual(set.roleIds);
    expect(next.revision).toBe(7);
    expect(JSON.stringify(set)).toBe(before);
    expect(grantSetWithout(set, "tool:gone")).toBeNull();
  });
  it("adding appends at the revision read and refuses duplicates", () => {
    const next = grantSetWith(set, { kind: "connector", connectorId: U(6), mode: "read", allowedObjects: [] });
    expect(typeof next).toBe("object");
    expect((next as PutAgentGrants).connectors).toHaveLength(2);
    expect((next as PutAgentGrants).revision).toBe(7);
    expect(grantSetWith(set, { kind: "tool", serverId: U(1), toolName: "read_record" })).toMatch(/already granted/);
    expect(grantSetWith(set, { kind: "role", roleId: U(5) })).toMatch(/already assigned/);
    expect(grantSetWith(set, { kind: "server", serverId: "not-a-uuid", readOnlyAll: true })).toMatch(/Choose a target/);
    expect(grantSetWith(set, { kind: "agent", agentId: U(9), allowedModes: ["a", "a"] })).toMatch(/distinct modes/);
  });
  it("splits comma lists without inventing entries", () => {
    expect(nameList(" a, ,b ,")).toEqual(["a", "b"]);
    expect(nameList("")).toEqual([]);
  });
});

describe("delegation tree", () => {
  const grant = (id: number, parent: number | null): DelegationGrantView => ({
    id: U(id), rootGrantId: U(1), parentGrantId: parent === null ? null : U(parent), path: [], depth: 0,
    sponsorUserId: U(90), actorIdentityId: U(80 + id), runId: U(70), projectId: null,
    capMicros: 100, settledMicros: 0, reservedMicros: 0, environment: "dev", audience: null,
    expiresAt: "2026-10-11T12:15:00Z", revokedAt: null, revokedReason: null, createdAt: "2026-10-11T12:00:00Z",
  });
  const edge = (parent: number, child: number): DelegationAllocationView => ({
    id: U(50 + child), parentGrantId: U(parent), childGrantId: U(child), amountMicros: 60, drawnMicros: 10, releasedMicros: 0,
    status: "open", createdAt: "2026-10-11T12:00:00Z", closedAt: null,
  });
  it("orders depth-first from the root and attaches each incoming edge", () => {
    const out = orderedDelegationTree({ items: [grant(3, 2), grant(1, null), grant(2, 1)], edges: [edge(1, 2), edge(2, 3)] });
    expect(out.problem).toBeNull();
    expect(out.rows.map((r) => [r.grant.id, r.level, r.allocation?.id ?? null])).toEqual([
      [U(1), 0, null],
      [U(2), 1, U(52)],
      [U(3), 2, U(53)],
    ]);
  });
  it("draws nothing for a missing parent or a cycle", () => {
    expect(orderedDelegationTree({ items: [grant(2, 1)], edges: [] }).rows).toEqual([]);
    expect(orderedDelegationTree({ items: [grant(2, 1)], edges: [] }).problem).toMatch(/incomplete/);
    expect(orderedDelegationTree({ items: [grant(1, 2), grant(2, 1)], edges: [] }).problem).toMatch(/cycle/);
  });
});

describe("refusal codes exist where the page's routes raise them", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  it("every code given a sentence is one the S4 identity, S5 grant-admin or S6 identity-admin routes return", () => {
    const routes = [
      src("../../../../../gateway/src/workload-identity-admin.ts"),
      src("../../../../../gateway/src/oauth/grant-admin.ts"),
      src("../../../../../gateway/src/oauth/identity-admin.ts"),
      contract,
    ].join("\n");
    const missing = Object.keys(REFUSAL_SENTENCES).filter((code) => !routes.includes(`"${code}"`));
    expect(missing).toEqual([]);
  });
  it("the delegation refusals the page explains are the shared contract's and the token endpoint's", () => {
    const sources = [contract, src("../../../../../gateway/src/oauth/token-endpoint.ts")].join("\n");
    expect(Object.keys(delegationRefusalMessages).filter((code) => !sources.includes(`"${code}"`))).toEqual([]);
  });
});

describe("refusals", () => {
  it("names the stale-revision conflict, and leaves unknown codes to the client", () => {
    expect(identityRefusalSentence(GRANTS_REVISION_CONFLICT)).toMatch(/changed since this page loaded/);
    expect(identityRefusalSentence("toString")).toBeNull();
    expect(identityRefusalSentence(undefined)).toBeNull();
  });
});

describe("S6: create body", () => {
  const base = { kind: "worker_runtime" as const, subjectId: "", identifier: "", stewardIds: [U(1)], environments: ["dev"] };
  it("sends only the subject column its kind names, and an identifier only for an external kind", () => {
    expect(createIdentityBody(base)).toEqual({ body: { kind: "worker_runtime", sponsorUserIds: [U(1)], environments: ["dev"] } });
    expect(createIdentityBody({ ...base, kind: "agent", subjectId: U(9) })).toEqual({ body: { kind: "agent", agentId: U(9), sponsorUserIds: [U(1)], environments: ["dev"] } });
    expect(createIdentityBody({ ...base, identifier: " spiffe://example.org/w/1 " })).toEqual({
      body: { kind: "worker_runtime", identifier: "spiffe://example.org/w/1", sponsorUserIds: [U(1)], environments: ["dev"] },
    });
  });
  it("refuses a missing subject, steward, a SPIFFE ID on an internal kind, and a malformed SPIFFE ID", () => {
    expect(createIdentityBody({ ...base, kind: "agent" })).toMatchObject({ error: expect.stringContaining("Choose") });
    expect(createIdentityBody({ ...base, stewardIds: [] })).toMatchObject({ error: expect.stringContaining("steward") });
    expect(createIdentityBody({ ...base, kind: "agent", subjectId: U(9), identifier: "spiffe://example.org/w/1" })).toMatchObject({ error: expect.stringContaining("external") });
    expect(createIdentityBody({ ...base, identifier: "spiffe://example.org/../x" })).toMatchObject({ error: expect.stringContaining("SPIFFE") });
  });
});

describe("S6: credential body", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const draft = { kind: "jwk" as const, jwkText: "", certificatePem: "", selfSigned: false, spiffeId: "", notAfterDate: "" };
  const x = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
  it("keeps only the public members of a JWK and refuses any private member before sending", () => {
    expect(credentialBody({ ...draft, jwkText: JSON.stringify({ kty: "OKP", crv: "Ed25519", x, kid: "k" }) }, now)).toEqual({ body: { kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x } } });
    for (const m of PRIVATE_JWK_MEMBERS) {
      expect(credentialBody({ ...draft, jwkText: JSON.stringify({ kty: "OKP", crv: "Ed25519", x, [m]: "secret" }) }, now)).toMatchObject({ error: expect.stringContaining("private key") });
    }
    expect(credentialBody({ ...draft, jwkText: JSON.stringify({ kty: "RSA", n: "a", e: "AQAB" }) }, now)).toMatchObject({ error: expect.stringContaining("Ed25519") });
    expect(credentialBody({ ...draft, jwkText: "not json" }, now)).toMatchObject({ error: expect.any(String) });
  });
  it("refuses a PEM with a private key, and bounds the end date", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(credentialBody({ ...draft, kind: "x509", certificatePem: pem, selfSigned: true }, now)).toEqual({ body: { kind: "x509", certificatePem: pem, selfSigned: true } });
    expect(credentialBody({ ...draft, kind: "x509", certificatePem: `${pem}\n-----BEGIN EC PRIVATE KEY-----\nB\n-----END EC PRIVATE KEY-----` }, now)).toMatchObject({ error: expect.stringContaining("private key") });
    expect(credentialBody({ ...draft, kind: "spiffe_id", spiffeId: "spiffe://example.org/w", notAfterDate: "2026-11-01" }, now)).toEqual({
      body: { kind: "spiffe_id", spiffeId: "spiffe://example.org/w", notAfter: "2026-11-01T00:00:00.000Z" },
    });
    expect(credentialBody({ ...draft, kind: "spiffe_id", spiffeId: "spiffe://example.org/w", notAfterDate: "2027-03-01" }, now)).toMatchObject({ error: expect.stringContaining("90 days") });
    expect(credentialBody({ ...draft, kind: "spiffe_id", spiffeId: "spiffe://example.org/w", notAfterDate: "2026-10-01" }, now)).toMatchObject({ error: expect.stringContaining("future") });
  });
  it("a credential's state: revoked wins, then expiry, never live on an unreadable date", () => {
    const c = { revokedAt: null, notBefore: "2026-10-01T00:00:00Z", notAfter: "2026-11-01T00:00:00Z" };
    expect(credentialState(c, now)).toBe("live");
    expect(credentialState({ ...c, revokedAt: "2026-10-02T00:00:00Z" }, now)).toBe("revoked");
    expect(credentialState({ ...c, notAfter: "2026-10-02T00:00:00Z" }, now)).toBe("expired");
    expect(credentialState({ ...c, notAfter: "garbage" }, now)).toBe("unmeasured");
  });
});

describe("S6 review: proposal selection (least privilege)", () => {
  const p = (modes: string[], held: boolean, refusalOnly: boolean) => ({
    grant: { kind: "agent" as const, agentId: U(4), allowedModes: modes },
    observedCalls: 2,
    refusedCalls: refusalOnly ? 2 : 1,
    lastObservedAt: "2026-10-12T00:00:00Z",
    heldByStewards: held,
    refusalOnly,
  });
  const ran = p(["execute"], true, false);
  const neverRan = p(["review"], true, true);
  const unheld = p(["admin"], false, true);
  const base = { tools: [], servers: [], agents: [{ agentId: U(4), allowedModes: ["plan"] }], connectors: [], roleIds: [], revision: 7 };
  it("pre-selects only steward-held proposals that ran at least once", () => {
    expect([...defaultProposalSelection([ran, neverRan, unheld])]).toEqual([proposalKey(ran)]);
  });
  it("merges only selected, steward-held proposals onto the set, leaving the set unchanged", () => {
    const all = new Set([ran, neverRan, unheld].map(proposalKey));
    const out = setWithProposals(base, [ran, neverRan, unheld], all);
    expect(out.agents).toEqual([{ agentId: U(4), allowedModes: ["plan", "execute", "review"] }]);
    expect(out.revision).toBe(7);
    expect(base.agents[0]!.allowedModes).toEqual(["plan"]);
    expect(setWithProposals(base, [ran, neverRan], defaultProposalSelection([ran, neverRan])).agents[0]!.allowedModes).toEqual(["plan", "execute"]);
  });
});
