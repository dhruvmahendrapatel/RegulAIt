/**
 * ADR-0188 slice S6 — THE WORKLOAD-IDENTITY ADMIN BACKEND, beside
 * `grant-admin.ts` (the master ruling recorded with #302: "Workload-identity
 * CRUD belongs to S6's backend, under the `identity_manage` step-up, in one
 * module beside `oauth/grant-admin.ts`").
 *
 *   POST   /v1/workload-identities                                   create (decision 2)
 *   POST   /v1/workload-identities/:identityId/revoke                terminal revoke (decisions 2, 4, 12)
 *   GET    /v1/workload-identities/:identityId/credentials           public halves only
 *   POST   /v1/workload-identities/:identityId/credentials           bind a PUBLIC credential (decisions 2, 5, 21)
 *   DELETE /v1/workload-identities/:identityId/credentials/:credId   revoke a credential (decision 12; never deleted)
 *   GET    /v1/workload-identities/:identityId/grant-proposals       OWNER DECISION 1: proposals from observed use
 *   GET    /v1/identity/picker-sources                               what the identity forms may offer
 *
 * All ADMIN-ONLY (the route-class gate; none is listed as a user route). Every
 * write needs an `identity_manage` step-up bound to exactly what it does, and
 * writes an audit row; every refusal of a write writes a DENY row in its own
 * committed transaction and changes nothing else (the S4 pattern).
 *
 * Secure by default (ADR-0180):
 *  - a new identity starts ACTIVE with NO grants of its own (OWNER DECISION 1);
 *    its stewards must be existing, enabled people; its identifier is the
 *    default `spiffe://<trust-domain>/regulait/<kind>/<id>` unless an EXTERNAL
 *    kind (`worker_runtime`, `pdp`) is bound to an exact SPIFFE ID its own SPIRE
 *    issues, and never one in our reserved `/regulait/` namespace;
 *  - a credential is a PUBLIC half only (`client_secret_*` does not exist): a
 *    JWK is imported with `jose` (a bad point is refused) and stored as its
 *    RFC 7638 members only; a certificate PEM carrying any private key is
 *    refused, must be one parsable certificate inside its validity, and only
 *    its thumbprint, URI SAN and subject are kept; a SPIFFE ID must sit in a
 *    trust domain with a configured bundle (SPIFFE is off by default). Its
 *    window is at most `workload_key_max_age_days` (strict 90) and never past
 *    the certificate's own expiry; one key ever authenticates one identity;
 *  - revoking a credential revokes every unexpired token it authenticated or
 *    that is bound to its key, and every grant it authenticated with their
 *    descendants (decision 12's table); revoking an identity also revokes its
 *    live credentials, its tokens and every grant naming it. The use-time
 *    checks (decision 17, the token verifier) already refuse all of these at
 *    the next use; the eager revocation makes the record say so and returns
 *    unspent allocation to each parent (decision 22).
 *
 * Open source first (ADR-0176): `jose` (JWK import, RFC 7638 thumbprints),
 * Node's `X509Certificate` and the pinned `pkijs` (through `x509.ts`) for the
 * certificate; what is ours is the policy above.
 */
import { X509Certificate, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { calculateJwkThumbprint, importJWK } from "jose";
import { z } from "zod";
import {
  agents,
  and,
  asc,
  auditLog,
  builderAgents,
  connectors,
  delegationGrants,
  desc,
  engineRunners,
  eq,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  ne,
  or,
  roles,
  sql,
  users,
  workloadCredentials,
  workloadIdentities,
  type Db,
  type SQL,
  type WorkloadCredentialRow,
} from "@regulait/db";
import {
  addWorkloadCredentialSchema,
  canonicalJson,
  createWorkloadIdentitySchema,
  defaultWorkloadIdentifier,
  GRANT_PROPOSAL_MAX,
  GRANT_PROPOSAL_WINDOW_DAYS,
  IDENTITY_PICKER_MAX,
  revokeWorkloadIdentitySchema,
  sha256Hex,
  WORKLOAD_CREDENTIAL_MAX_DAYS,
  type AddWorkloadCredential,
  type CreateWorkloadIdentity,
  type IdentityGrantProposal,
  type IdentityGrantProposalsView,
  type IdentityPickerSourcesView,
  type PutAgentGrants,
  type WorkloadCredentialListView,
  type WorkloadCredentialRevokeResult,
  type WorkloadCredentialView,
  type WorkloadIdentityRevokeResult,
  type WorkloadIdentityView,
  type WorkloadPublicJwk,
} from "@regulait/shared";
import { loadActorEntitlements } from "../actor-entitlements.js";
import { resolveDeployMode } from "../deploy-posture.js";
import { actorEntitlementsReach, databaseNow, DelegationRefusedError, revokeDelegationGrant } from "../delegation.js";
import { resolveTrustDomain } from "../in-process-delegation.js";
import { loadOrgSettings } from "../org-settings.js";
import { requireStepUp, type StepUpCheckArgs } from "../step-up.js";
import { firstItemNoStewardHolds, getIdentityGrants } from "../workload-identity-admin.js";
import { certificateThumbprint, certificateUriSans, loadTrustConfig, pemBundleToDer, spiffeIdParts } from "./x509.js";

const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ identityId: z.string().uuid() });
const credParam = z.object({ identityId: z.string().uuid(), credentialId: z.string().uuid() });
const DAY_MS = 86_400_000;

/** a refused identity-admin write: a stable code, an HTTP status, ids only in the detail */
export class IdentityAdminError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "IdentityAdminError";
  }
}

type IdentityRow = typeof workloadIdentities.$inferSelect;

export function identityView(r: IdentityRow): WorkloadIdentityView {
  return {
    id: r.id,
    kind: r.kind,
    agentId: r.agentId,
    builderAgentId: r.builderAgentId,
    engineRunnerId: r.engineRunnerId,
    identifier: r.identifier,
    sponsorUserIds: [...r.sponsorUserIds],
    environments: [...r.environments],
    status: r.status,
    grantsRevision: r.grantsRevision,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** PUBLIC halves only: the stored row has no secret column, and this names every field it returns */
export function credentialView(c: WorkloadCredentialRow): WorkloadCredentialView {
  return {
    id: c.id,
    identityId: c.identityId,
    kind: c.kind as WorkloadCredentialView["kind"],
    publicJwk: (c.publicJwk ?? null) as WorkloadPublicJwk | null,
    jwkThumbprint: c.jwkThumbprint,
    x5tS256: c.x5tS256,
    sanUri: c.sanUri,
    subjectDn: c.subjectDn,
    spiffeId: c.spiffeId,
    selfSigned: c.selfSigned,
    notBefore: c.notBefore.toISOString(),
    notAfter: c.notAfter.toISOString(),
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Step-up facts: each write is bound to exactly what it does
// ---------------------------------------------------------------------------

export function identityCreateStepUp(body: CreateWorkloadIdentity): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "identity_create", kind: body.kind, bodyDigest: sha256Hex(canonicalJson(body)) } };
}
export function identityRevokeStepUp(identityId: string): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "identity_revoke", identityId } };
}
export function credentialAddStepUp(identityId: string, body: AddWorkloadCredential): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "credential_add", identityId, credentialDigest: sha256Hex(canonicalJson(body)) } };
}
export function credentialRevokeStepUp(identityId: string, credentialId: string): StepUpCheckArgs {
  return { kind: "identity_manage", facts: { op: "credential_revoke", identityId, credentialId } };
}

// ---------------------------------------------------------------------------
// Refusals: a deny row in its own committed transaction, then the error
// ---------------------------------------------------------------------------

async function auditRefusal(
  db: Db,
  args: { actorUserId: string; objectId: string | null; ruleId: string; phase: string; err: IdentityAdminError; extra?: Record<string, unknown> },
): Promise<IdentityAdminError> {
  await db.insert(auditLog).values({
    userId: args.actorUserId,
    objectType: "workload_identity",
    objectId: args.objectId,
    detail: { phase: args.phase, code: args.err.code, ...(args.extra ?? {}) },
    effect: "deny",
    ruleId: args.ruleId,
    ruleChain: [],
    reason: `refused: ${args.err.message} (ADR-0188 S6)`,
  });
  return args.err;
}

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

/** every listed steward is an existing, enabled person (never the system principal); the missing ids, or [] */
async function missingStewards(tx: Db, ids: readonly string[]): Promise<string[]> {
  const found = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.disabledAt), ne(users.id, SYSTEM_USER_ID)))
    .orderBy(asc(users.id))
    .for("share");
  return ids.filter((id) => !found.some((f) => f.id === id));
}

// ---------------------------------------------------------------------------
// Create (decision 2)
// ---------------------------------------------------------------------------

const EXTERNAL_KINDS = new Set(["worker_runtime", "pdp"]);

/**
 * Create one identity. Exactly the subject its kind names, which must exist,
 * be in service and have no identity yet (one identity per subject, ever: a
 * revoked identity is not replaced). Audited `workload-identity-created`.
 */
export async function createWorkloadIdentity(db: Db, body: CreateWorkloadIdentity, actorUserId: string): Promise<WorkloadIdentityView> {
  const input = createWorkloadIdentitySchema.parse(body);
  const subjectId = input.agentId ?? input.builderAgentId ?? input.engineRunnerId ?? null;
  const refused = (err: IdentityAdminError, extra: Record<string, unknown> = {}) =>
    auditRefusal(db, { actorUserId, objectId: subjectId, ruleId: "workload-identity-create-refused", phase: "create_refused", err, extra: { kind: input.kind, ...extra } });

  const trustDomain = resolveTrustDomain();
  const id = randomUUID();
  let identifier = defaultWorkloadIdentifier(trustDomain, input.kind, id);
  if (input.identifier !== undefined) {
    // only an EXTERNAL workload is bound to a SPIFFE ID its own SPIRE issues; an in-process subject never presents one
    if (!EXTERNAL_KINDS.has(input.kind)) {
      throw await refused(new IdentityAdminError("identifier_not_allowed", 422, `a ${input.kind} identity takes the default identifier; only worker_runtime and pdp may be bound to an exact SPIFFE ID`));
    }
    if (input.identifier.startsWith(`spiffe://${trustDomain}/regulait/`)) {
      throw await refused(new IdentityAdminError("identifier_reserved", 422, `spiffe://${trustDomain}/regulait/ is reserved for identifiers the gateway assigns`));
    }
    identifier = input.identifier;
  }

  let out: WorkloadIdentityView | IdentityAdminError;
  try {
    out = await db.transaction(async (tx): Promise<WorkloadIdentityView | IdentityAdminError> => {
      const t = tx as unknown as Db;
      // the subject exists and is in service, and has no identity yet
      if (input.kind === "agent") {
        const [a] = await t.select({ id: agents.id, lifecycle: agents.lifecycleStatus }).from(agents).where(eq(agents.id, input.agentId!)).for("share");
        if (!a) return new IdentityAdminError("subject_not_found", 404, `no agent ${input.agentId}`);
        if (a.lifecycle === "retired") return new IdentityAdminError("subject_not_in_service", 409, `agent ${input.agentId} is retired`);
      } else if (input.kind === "builder_agent") {
        const [b] = await t.select({ id: builderAgents.id, archivedAt: builderAgents.archivedAt }).from(builderAgents).where(eq(builderAgents.id, input.builderAgentId!)).for("share");
        if (!b) return new IdentityAdminError("subject_not_found", 404, `no builder agent ${input.builderAgentId}`);
        if (b.archivedAt) return new IdentityAdminError("subject_not_in_service", 409, `builder agent ${input.builderAgentId} is archived`);
      } else if (input.kind === "engine_runner") {
        const [r] = await t.select({ id: engineRunners.id, revokedAt: engineRunners.revokedAt }).from(engineRunners).where(eq(engineRunners.id, input.engineRunnerId!)).for("share");
        if (!r) return new IdentityAdminError("subject_not_found", 404, `no engine runner ${input.engineRunnerId}`);
        if (r.revokedAt) return new IdentityAdminError("subject_not_in_service", 409, `engine runner ${input.engineRunnerId} is revoked`);
      }
      if (subjectId) {
        const col = input.kind === "agent" ? workloadIdentities.agentId : input.kind === "builder_agent" ? workloadIdentities.builderAgentId : workloadIdentities.engineRunnerId;
        const [taken] = await t.select({ id: workloadIdentities.id }).from(workloadIdentities).where(eq(col, subjectId));
        if (taken) return new IdentityAdminError("identity_exists", 409, `${input.kind} ${subjectId} already has identity ${taken.id}; one identity per subject, ever`);
      }
      const [dup] = await t.select({ id: workloadIdentities.id }).from(workloadIdentities).where(eq(workloadIdentities.identifier, identifier));
      if (dup) return new IdentityAdminError("identifier_taken", 409, `identifier is already identity ${dup.id}'s`);
      const missing = await missingStewards(t, input.sponsorUserIds);
      if (missing.length) return new IdentityAdminError("steward_not_found", 404, `every steward is an existing, enabled user (not found or disabled: ${missing.join(", ")})`);
      const [row] = await t
        .insert(workloadIdentities)
        .values({
          id,
          kind: input.kind,
          agentId: input.agentId ?? null,
          builderAgentId: input.builderAgentId ?? null,
          engineRunnerId: input.engineRunnerId ?? null,
          identifier,
          sponsorUserIds: input.sponsorUserIds,
          environments: input.environments,
          createdBy: actorUserId === SYSTEM_USER_ID ? null : actorUserId,
        })
        .returning();
      await t.insert(auditLog).values({
        userId: actorUserId,
        objectType: "workload_identity",
        objectId: row!.id,
        detail: {
          phase: "create",
          origin: "admin",
          kind: input.kind,
          subjectId,
          identifier,
          customIdentifier: input.identifier !== undefined,
          stewards: input.sponsorUserIds,
          environments: input.environments,
          grants: "none",
        },
        effect: "allow",
        ruleId: "workload-identity-created",
        ruleChain: [],
        reason: `workload identity ${row!.id} created for ${input.kind}${subjectId ? ` ${subjectId}` : ""}, with no grants of its own (ADR-0188 S6, OWNER DECISION 1)`,
      });
      return identityView(row!);
    });
  } catch (e) {
    // a concurrent create for the same subject or identifier lost the unique race
    if (!isUniqueViolation(e)) throw e;
    out = new IdentityAdminError("identity_exists", 409, "an identity for this subject or identifier was created concurrently");
  }
  if (out instanceof IdentityAdminError) throw await refused(out);
  return out;
}

// ---------------------------------------------------------------------------
// Revoke an identity (terminal)
// ---------------------------------------------------------------------------

/** revoke each live grant (and its subtree) once, shallowest first; ids already cascaded are skipped */
async function revokeGrants(db: Db, grantIds: Array<{ id: string; depth: number }>, reason: "identity_revoked" | "credential_revoked", actorUserId: string): Promise<string[]> {
  const done = new Set<string>();
  for (const g of [...grantIds].sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1))) {
    if (done.has(g.id)) continue;
    try {
      const out = await revokeDelegationGrant(db, { grantId: g.id, reason, actorUserId });
      for (const r of out.revokedGrantIds) done.add(r);
      done.add(g.id);
    } catch (e) {
      if (!(e instanceof DelegationRefusedError)) throw e;
    }
  }
  return [...done].sort();
}

/** the live grants (database clock) matching `where`, for eager revocation */
async function liveGrants(db: Db, where: SQL): Promise<Array<{ id: string; depth: number }>> {
  return db
    .select({ id: delegationGrants.id, depth: delegationGrants.depth })
    .from(delegationGrants)
    .where(and(where, isNull(delegationGrants.revokedAt), sql`${delegationGrants.expiresAt} > now()`));
}

/**
 * Revoke an identity: terminal (the 0180 trigger refuses reinstating it). In
 * one transaction: the status, its live credentials, and every unexpired token
 * naming it or authenticated by one of its credentials; then every live grant
 * naming it as actor, with descendants. Audited `workload-identity-revoked`.
 */
export async function revokeWorkloadIdentity(db: Db, identityId: string, actorUserId: string): Promise<WorkloadIdentityRevokeResult> {
  const out = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [ident] = await t.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId)).for("update");
    if (!ident) return new IdentityAdminError("identity_not_found", 404, `no workload identity ${identityId}`);
    if (ident.status === "revoked") return new IdentityAdminError("identity_already_revoked", 409, `identity ${identityId} is already revoked`);
    const [row] = await t
      .update(workloadIdentities)
      .set({ status: "revoked", updatedAt: sql`now()` })
      .where(eq(workloadIdentities.id, identityId))
      .returning();
    const creds = await t
      .update(workloadCredentials)
      .set({ revokedAt: sql`GREATEST(now(), ${workloadCredentials.createdAt})` })
      .where(and(eq(workloadCredentials.identityId, identityId), isNull(workloadCredentials.revokedAt)))
      .returning({ id: workloadCredentials.id });
    // decision 3 of the S3 amendments: lifecycle stamps from the database clock, never before the row's start
    const tokens = await t.execute<{ jti: string }>(sql`
      update issued_tokens set revoked_at = GREATEST(now(), issued_at)
      where revoked_at is null and expires_at > now()
        and (grant_id in (select id from delegation_grants where actor_identity_id = ${identityId})
             or auth_credential_id in (select id from workload_credentials where identity_id = ${identityId}))
      returning jti`);
    await t.insert(auditLog).values({
      userId: actorUserId,
      objectType: "workload_identity",
      objectId: identityId,
      detail: { phase: "revoke", before: ident.status, credentialsRevoked: creds.map((c) => c.id), tokensRevoked: tokens.rows.length },
      effect: "allow",
      ruleId: "workload-identity-revoked",
      ruleChain: [],
      reason: `workload identity ${identityId} revoked (terminal); ${creds.length} credential(s) and ${tokens.rows.length} token(s) revoked with it; every grant naming it is refused at its next use`,
    });
    return { identity: identityView(row!), credentialsRevoked: creds.length, tokensRevoked: tokens.rows.length };
  });
  if (out instanceof IdentityAdminError) {
    throw await auditRefusal(db, { actorUserId, objectId: identityId, ruleId: "workload-identity-revoke-refused", phase: "revoke_refused", err: out });
  }
  // the use-time chain check already refuses them (identity_revoked); this ends them on the record and releases allocation
  const grantsRevoked = await revokeGrants(db, await liveGrants(db, eq(delegationGrants.actorIdentityId, identityId)), "identity_revoked", actorUserId);
  return { ...out, grantsRevoked };
}

// ---------------------------------------------------------------------------
// Credentials (PUBLIC halves only)
// ---------------------------------------------------------------------------

export async function listWorkloadCredentials(db: Db, identityId: string): Promise<WorkloadCredentialListView | null> {
  const [ident] = await db.select({ id: workloadIdentities.id }).from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
  if (!ident) return null;
  const rows = await db
    .select()
    .from(workloadCredentials)
    .where(eq(workloadCredentials.identityId, identityId))
    .orderBy(desc(workloadCredentials.createdAt), desc(workloadCredentials.id));
  return { items: rows.map(credentialView) };
}

export interface PreparedCredential {
  kind: "jwk" | "x509" | "spiffe_id";
  publicJwk: Record<string, string> | null;
  jwkThumbprint: string | null;
  x5tS256: string | null;
  sanUri: string | null;
  subjectDn: string | null;
  spiffeId: string | null;
  selfSigned: boolean;
  /** the certificate's own expiry: the credential never outlives it */
  certificateNotAfter: Date | null;
}

const PRIVATE_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN ENCRYPTED PRIVATE KEY-----/;

/** validate and reduce a credential to the public facts we keep; a refusal is an `IdentityAdminError` */
export async function prepareCredential(body: AddWorkloadCredential, now: Date, env: NodeJS.ProcessEnv): Promise<PreparedCredential | IdentityAdminError> {
  if (body.kind === "jwk") {
    const j = body.publicJwk as Record<string, unknown>;
    // only the RFC 7638 members are kept: a `kid`, `use` or anything else a caller sends is not stored
    const members: Record<string, string> =
      j.kty === "OKP" ? { kty: "OKP", crv: "Ed25519", x: String(j.x) } : { kty: "EC", crv: "P-256", x: String(j.x), y: String(j.y) };
    try {
      // jose builds the key: an invalid point or encoding is refused here, never stored
      await importJWK(members, members.kty === "OKP" ? "EdDSA" : "ES256");
    } catch {
      return new IdentityAdminError("credential_invalid", 422, "the JWK is not a valid Ed25519 or P-256 public key");
    }
    return {
      kind: "jwk",
      publicJwk: members,
      jwkThumbprint: await calculateJwkThumbprint(members, "sha256"),
      x5tS256: null,
      sanUri: null,
      subjectDn: null,
      spiffeId: null,
      selfSigned: false,
      certificateNotAfter: null,
    };
  }
  if (body.kind === "x509") {
    if (PRIVATE_PEM.test(body.certificatePem)) {
      return new IdentityAdminError("credential_private_material", 422, "the PEM carries a private key; only the certificate is accepted, and nothing was stored");
    }
    let ders: Buffer[];
    try {
      ders = pemBundleToDer(body.certificatePem);
    } catch {
      return new IdentityAdminError("credential_invalid", 422, "the PEM is not a parsable certificate");
    }
    if (ders.length !== 1) return new IdentityAdminError("credential_invalid", 422, "send exactly one certificate: the workload's own leaf");
    const der = ders[0]!;
    let cert: X509Certificate;
    let uris: string[];
    try {
      cert = new X509Certificate(der);
      uris = certificateUriSans(der);
    } catch {
      return new IdentityAdminError("credential_invalid", 422, "the certificate could not be parsed");
    }
    const from = new Date(cert.validFrom);
    const to = new Date(cert.validTo);
    if (!(from.getTime() <= now.getTime() && to.getTime() > now.getTime())) {
      return new IdentityAdminError("certificate_time", 422, "the certificate is not inside its validity period now");
    }
    if (body.selfSigned) {
      if (cert.issuer !== cert.subject || !cert.verify(cert.publicKey)) {
        return new IdentityAdminError("certificate_not_self_signed", 422, "marked self-signed, but the certificate is not signed by its own key");
      }
    } else if (cert.ca) {
      // a CA-issued client credential is a leaf; the full chain and profile are checked at every use (decision 21)
      return new IdentityAdminError("certificate_leaf_ca", 422, "a client certificate must not be a CA certificate");
    }
    const subject = cert.subject;
    if (subject.length > 1024) return new IdentityAdminError("credential_invalid", 422, "the certificate subject is too long");
    const sanUri = uris.length === 1 && uris[0]!.length <= 2048 ? uris[0]! : null;
    return {
      kind: "x509",
      publicJwk: null,
      jwkThumbprint: null,
      x5tS256: certificateThumbprint(der),
      sanUri,
      subjectDn: subject.length > 0 ? subject : null,
      spiffeId: null,
      selfSigned: body.selfSigned,
      certificateNotAfter: to,
    };
  }
  const parts = spiffeIdParts(body.spiffeId);
  if (!parts) return new IdentityAdminError("credential_invalid", 422, "not a SPIFFE ID");
  let domains: Set<string>;
  try {
    domains = new Set(loadTrustConfig(env).spiffe.keys());
  } catch {
    return new IdentityAdminError("trust_config_invalid", 503, "the configured SPIFFE trust bundles could not be read; nothing was stored");
  }
  // SPIFFE is off until a bundle for the trust domain is configured (decision 10: `spiffe_trust_bundles` empty)
  if (!domains.has(parts.trustDomain)) {
    return new IdentityAdminError("spiffe_trust_domain_unknown", 422, `no trust bundle is configured for ${parts.trustDomain}; an ID there could never authenticate`);
  }
  return { kind: "spiffe_id", publicJwk: null, jwkThumbprint: null, x5tS256: null, sanUri: null, subjectDn: null, spiffeId: body.spiffeId, selfSigned: false, certificateNotAfter: null };
}

/**
 * Bind a PUBLIC credential to an ACTIVE identity. Its window starts now
 * (database clock) and ends at `notAfter`, default and maximum
 * `workload_key_max_age_days` (strict 90), never past a certificate's own
 * expiry. A key or certificate ever registered (even revoked) is never
 * registered again; a live SPIFFE ID is bound once. Audited
 * `workload-credential-added`.
 */
export async function addWorkloadCredential(
  db: Db,
  identityId: string,
  body: AddWorkloadCredential,
  actorUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkloadCredentialView> {
  const input = addWorkloadCredentialSchema.parse(body);
  let out: WorkloadCredentialView | IdentityAdminError;
  try {
    out = await db.transaction(async (tx): Promise<WorkloadCredentialView | IdentityAdminError> => {
      const t = tx as unknown as Db;
      const [ident] = await t.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId)).for("share");
      if (!ident) return new IdentityAdminError("identity_not_found", 404, `no workload identity ${identityId}`);
      if (ident.status !== "active") return new IdentityAdminError("identity_not_active", 409, `identity ${identityId} is ${ident.status}; a credential is bound only to an active identity`);
      const now = await databaseNow(t);
      const prepared = await prepareCredential(input, now, env);
      if (prepared instanceof IdentityAdminError) return prepared;
      const org = await loadOrgSettings(t);
      const maxDays = Math.min(org.workloadKeyMaxAgeDays, WORKLOAD_CREDENTIAL_MAX_DAYS);
      const ceiling = new Date(Math.min(now.getTime() + maxDays * DAY_MS, prepared.certificateNotAfter?.getTime() ?? Number.POSITIVE_INFINITY));
      let notAfter = ceiling;
      if (input.notAfter !== undefined) {
        notAfter = new Date(input.notAfter);
        if (!(notAfter.getTime() > now.getTime()) || notAfter.getTime() > ceiling.getTime()) {
          return new IdentityAdminError(
            "credential_not_after",
            422,
            `notAfter must be after now and no later than ${ceiling.toISOString()} (${maxDays} days${prepared.certificateNotAfter ? ", and the certificate's own expiry" : ""})`,
          );
        }
      }
      // one key or certificate authenticates one identity, ever (a revoked one is not re-registered)
      const clash = prepared.jwkThumbprint
        ? eq(workloadCredentials.jwkThumbprint, prepared.jwkThumbprint)
        : prepared.x5tS256
          ? eq(workloadCredentials.x5tS256, prepared.x5tS256)
          : and(eq(workloadCredentials.spiffeId, prepared.spiffeId!), isNull(workloadCredentials.revokedAt));
      const [dup] = await t.select({ id: workloadCredentials.id }).from(workloadCredentials).where(clash);
      if (dup) return new IdentityAdminError("credential_already_registered", 409, "that key, certificate or SPIFFE ID is already registered; register a new key instead");
      const [row] = await t
        .insert(workloadCredentials)
        .values({
          identityId,
          kind: prepared.kind,
          publicJwk: prepared.publicJwk as WorkloadPublicJwk | null,
          jwkThumbprint: prepared.jwkThumbprint,
          x5tS256: prepared.x5tS256,
          sanUri: prepared.sanUri,
          subjectDn: prepared.subjectDn,
          spiffeId: prepared.spiffeId,
          selfSigned: prepared.selfSigned,
          notBefore: now,
          notAfter,
          createdBy: actorUserId === SYSTEM_USER_ID ? null : actorUserId,
        })
        .returning();
      await t.insert(auditLog).values({
        userId: actorUserId,
        objectType: "workload_identity",
        objectId: identityId,
        detail: {
          phase: "credential_add",
          credentialId: row!.id,
          kind: prepared.kind,
          // public facts only: a thumbprint or SPIFFE ID, never key material
          thumbprint: prepared.jwkThumbprint ?? prepared.x5tS256,
          spiffeId: prepared.spiffeId,
          selfSigned: prepared.selfSigned,
          notAfter: notAfter.toISOString(),
        },
        effect: "allow",
        ruleId: "workload-credential-added",
        ruleChain: [],
        reason: `a public ${prepared.kind} credential was bound to workload identity ${identityId} until ${notAfter.toISOString()} (ADR-0188 S6)`,
      });
      return credentialView(row!);
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    out = new IdentityAdminError("credential_already_registered", 409, "that key, certificate or SPIFFE ID was registered concurrently");
  }
  if (out instanceof IdentityAdminError) {
    throw await auditRefusal(db, { actorUserId, objectId: identityId, ruleId: "workload-credential-refused", phase: "credential_add_refused", err: out, extra: { kind: input.kind } });
  }
  return out;
}

/**
 * Revoke a credential (never delete; never revived). Decision 12: every
 * unexpired token it authenticated, or bound to its key, is revoked with it;
 * then every live grant it authenticated (or authenticated the parent proof
 * of), with descendants. Audited `workload-credential-revoked`.
 */
export async function revokeWorkloadCredential(db: Db, identityId: string, credentialId: string, actorUserId: string): Promise<WorkloadCredentialRevokeResult> {
  const out = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [ident] = await t.select({ id: workloadIdentities.id }).from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
    if (!ident) return new IdentityAdminError("identity_not_found", 404, `no workload identity ${identityId}`);
    const [cred] = await t
      .select()
      .from(workloadCredentials)
      .where(and(eq(workloadCredentials.id, credentialId), eq(workloadCredentials.identityId, identityId)))
      .for("update");
    if (!cred) return new IdentityAdminError("credential_not_found", 404, `identity ${identityId} has no credential ${credentialId}`);
    if (cred.revokedAt) return new IdentityAdminError("credential_already_revoked", 409, `credential ${credentialId} is already revoked`);
    const [row] = await t
      .update(workloadCredentials)
      .set({ revokedAt: sql`GREATEST(now(), ${workloadCredentials.createdAt})` })
      .where(eq(workloadCredentials.id, credentialId))
      .returning();
    const thumb = cred.jwkThumbprint ?? cred.x5tS256;
    const tokens = await t.execute<{ jti: string }>(sql`
      update issued_tokens set revoked_at = GREATEST(now(), issued_at)
      where revoked_at is null and expires_at > now()
        and (auth_credential_id = ${credentialId} ${thumb ? sql`or binding_thumbprint = ${thumb}` : sql``})
      returning jti`);
    await t.insert(auditLog).values({
      userId: actorUserId,
      objectType: "workload_identity",
      objectId: identityId,
      detail: { phase: "credential_revoke", credentialId, kind: cred.kind, thumbprint: thumb, spiffeId: cred.spiffeId, tokensRevoked: tokens.rows.length },
      effect: "allow",
      ruleId: "workload-credential-revoked",
      ruleChain: [],
      reason: `credential ${credentialId} of workload identity ${identityId} revoked; ${tokens.rows.length} token(s) it authenticated or that were bound to it revoked (ADR-0188 decision 12)`,
    });
    return { credential: credentialView(row!), tokensRevoked: tokens.rows.length };
  });
  if (out instanceof IdentityAdminError) {
    throw await auditRefusal(db, { actorUserId, objectId: identityId, ruleId: "workload-credential-refused", phase: "credential_revoke_refused", err: out, extra: { credentialId } });
  }
  const grants = await liveGrants(db, or(eq(delegationGrants.authCredentialId, credentialId), eq(delegationGrants.subjectCredentialId, credentialId))!);
  const grantsRevoked = await revokeGrants(db, grants, "credential_revoked", actorUserId);
  return { ...out, grantsRevoked };
}

// ---------------------------------------------------------------------------
// Grant proposals from observed use (OWNER DECISION 1)
// ---------------------------------------------------------------------------

type ObservedRow = {
  server_id: string | null;
  tool_name: string | null;
  object_type: string | null;
  object_id: string | null;
  mode: string | null;
  operation: string | null;
  object: string | null;
  n: number | string;
  refused: number | string;
  last: string | Date;
};

const emptyEntitlementSet = (revision: number): PutAgentGrants => ({ tools: [], servers: [], agents: [], connectors: [], roleIds: [], revision });

/**
 * What the identity was OBSERVED doing in the last 30 days (database clock):
 * its governed decisions in the audit log (`receiptClass = decision`),
 * allowed and refused, stamped with it as the acting agent — in the actor
 * columns from the v2 boundary on, in `detail.delegation` before it (S4
 * amendment 5). Each observed call its own grants do not already reach is a
 * proposal; a tool must still exist on its server, an agent and a connector
 * must still exist, and a connector call that named no object can never be an
 * agent's grant (decision 27), so it is counted as unproposable. Nothing is
 * written; accepting is the ordinary grant PUT with its step-up and steward
 * check, and `proposedSet` holds only what a steward holds.
 */
export async function proposeIdentityGrants(db: Db, identityId: string): Promise<IdentityGrantProposalsView | null> {
  const current = await getIdentityGrants(db, identityId);
  if (!current) return null;
  const [ident] = await db.select().from(workloadIdentities).where(eq(workloadIdentities.id, identityId));
  const since = await db.execute<{ since: string | Date }>(sql`select now() - make_interval(days => ${GRANT_PROPOSAL_WINDOW_DAYS}) as since`);
  const sinceAt = new Date(since.rows[0]!.since);
  const observed = await db.execute<ObservedRow>(sql`
    select server_id, tool_name, object_type, object_id,
           detail->>'mode' as mode, detail->>'operation' as operation, detail->>'object' as object,
           count(*) as n, count(*) filter (where effect <> 'allow') as refused, max(at) as last
    from audit_log
    where at > ${sinceAt.toISOString()}::timestamptz
      and (actor_identity_id = ${identityId}
           or (actor_identity_id is null and detail->'delegation'->>'actorIdentityId' = ${identityId}))
      and detail->>'receiptClass' = 'decision'
      and coalesce(detail->>'phase', '') <> 'consent-retired'
      and ((server_id is not null and tool_name is not null) or object_type in ('agent', 'connector'))
    group by 1, 2, 3, 4, 5, 6, 7
    order by max(at) desc
    limit 5000`);

  const own = (await loadActorEntitlements(db, [identityId])).get(identityId) ?? { tools: [], servers: [], agents: [], connectors: [] };
  const toolKinds = new Map<string, string>();
  const serverIds = [...new Set(observed.rows.filter((r) => r.server_id && r.tool_name).map((r) => r.server_id!))];
  if (serverIds.length) {
    for (const t of await db.select({ serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind }).from(mcpTools).where(inArray(mcpTools.serverId, serverIds))) {
      toolKinds.set(`${t.serverId}\u0000${t.name}`, t.kind === "read" ? "read" : "write");
    }
  }
  const agentIds = [...new Set(observed.rows.filter((r) => r.object_type === "agent" && r.object_id).map((r) => r.object_id!))];
  const liveAgents = new Set(agentIds.length ? (await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds))).map((a) => a.id) : []);
  const connectorIds = [...new Set(observed.rows.filter((r) => r.object_type === "connector" && r.object_id).map((r) => r.object_id!))];
  const liveConnectors = new Set(connectorIds.length ? (await db.select({ id: connectors.id }).from(connectors).where(inArray(connectors.id, connectorIds))).map((c) => c.id) : []);

  // aggregate per proposable grant
  type Acc = { observedCalls: number; refusedCalls: number; last: number };
  const tools = new Map<string, Acc & { serverId: string; toolName: string }>();
  const agentModes = new Map<string, Acc & { agentId: string; modes: Set<string> }>();
  const conns = new Map<string, Acc & { connectorId: string; write: boolean; objects: Set<string> }>();
  let unproposable = 0;
  const bump = (a: Acc, r: ObservedRow) => {
    a.observedCalls += Number(r.n);
    a.refusedCalls += Number(r.refused);
    a.last = Math.max(a.last, new Date(r.last).getTime());
  };
  for (const r of observed.rows) {
    if (r.server_id && r.tool_name) {
      const kind = toolKinds.get(`${r.server_id}\u0000${r.tool_name}`);
      if (!kind) {
        unproposable += Number(r.n); // a protocol method, or a tool since removed
        continue;
      }
      if (actorEntitlementsReach(own, { type: "mcp_tool", serverId: r.server_id, toolName: r.tool_name, kind: kind as "read" | "write" })) continue;
      const k = `${r.server_id}\u0000${r.tool_name}`;
      const acc = tools.get(k) ?? { serverId: r.server_id, toolName: r.tool_name, observedCalls: 0, refusedCalls: 0, last: 0 };
      bump(acc, r);
      tools.set(k, acc);
    } else if (r.object_type === "agent") {
      if (!r.object_id || !liveAgents.has(r.object_id) || !r.mode || r.mode.length > 64) {
        unproposable += Number(r.n);
        continue;
      }
      if (own.agents.some((g) => g.agentId === r.object_id && g.allowedModes.includes(r.mode!))) continue;
      const acc = agentModes.get(r.object_id) ?? { agentId: r.object_id, modes: new Set<string>(), observedCalls: 0, refusedCalls: 0, last: 0 };
      acc.modes.add(r.mode);
      bump(acc, r);
      agentModes.set(r.object_id, acc);
    } else if (r.object_type === "connector") {
      // an agent's connector grant always names its objects (decision 27): a call that named none is never proposable
      if (!r.object_id || !liveConnectors.has(r.object_id) || !r.object || r.object.length > 200 || (r.operation !== "read" && r.operation !== "write")) {
        unproposable += Number(r.n);
        continue;
      }
      const write = r.operation === "write";
      if (own.connectors.some((g) => g.connectorId === r.object_id && (!write || g.mode === "readwrite") && g.allowedObjects.includes(r.object!))) continue;
      const acc = conns.get(r.object_id) ?? { connectorId: r.object_id, write: false, objects: new Set<string>(), observedCalls: 0, refusedCalls: 0, last: 0 };
      acc.write ||= write;
      acc.objects.add(r.object);
      bump(acc, r);
      conns.set(r.object_id, acc);
    }
  }

  const candidates: Array<Omit<IdentityGrantProposal, "heldByStewards"> & { last: number }> = [
    ...[...tools.values()].map((a) => ({ grant: { kind: "tool" as const, serverId: a.serverId, toolName: a.toolName }, observedCalls: a.observedCalls, refusedCalls: a.refusedCalls, lastObservedAt: new Date(a.last).toISOString(), last: a.last })),
    ...[...agentModes.values()].map((a) => ({ grant: { kind: "agent" as const, agentId: a.agentId, allowedModes: [...a.modes].sort().slice(0, 20) }, observedCalls: a.observedCalls, refusedCalls: a.refusedCalls, lastObservedAt: new Date(a.last).toISOString(), last: a.last })),
    ...[...conns.values()].map((a) => ({
      grant: { kind: "connector" as const, connectorId: a.connectorId, mode: a.write ? ("readwrite" as const) : ("read" as const), allowedObjects: [...a.objects].sort().slice(0, 500) },
      observedCalls: a.observedCalls,
      refusedCalls: a.refusedCalls,
      lastObservedAt: new Date(a.last).toISOString(),
      last: a.last,
    })),
  ].sort((x, y) => y.last - x.last);
  const truncated = candidates.length > GRANT_PROPOSAL_MAX || observed.rows.length >= 5000;
  const kept = candidates.slice(0, GRANT_PROPOSAL_MAX);

  // which proposals a steward holds: the same check the accepting PUT runs, one item at a time, read-only
  const stewards = ident?.sponsorUserIds ?? [];
  const proposals: IdentityGrantProposal[] = await db.transaction(async (tx) => {
    // not READ ONLY: the steward check takes FOR SHARE row locks; nothing is written here
    const t = tx as unknown as Db;
    const outList: IdentityGrantProposal[] = [];
    for (const c of kept) {
      const single = emptyEntitlementSet(current.revision);
      if (c.grant.kind === "tool") single.tools.push({ serverId: c.grant.serverId, toolName: c.grant.toolName });
      else if (c.grant.kind === "agent") single.agents.push({ agentId: c.grant.agentId, allowedModes: c.grant.allowedModes });
      else single.connectors.push({ connectorId: c.grant.connectorId, mode: c.grant.mode, allowedObjects: c.grant.allowedObjects });
      const held = (await firstItemNoStewardHolds(t, stewards, single)) === null;
      const { last: _last, ...rest } = c;
      outList.push({ ...rest, heldByStewards: held });
    }
    return outList;
  });

  // the accepting PUT body: the current set plus every held proposal, merged per target
  const proposedSet: PutAgentGrants = {
    tools: current.tools.map((g) => ({ ...g })),
    servers: current.servers.map((g) => ({ ...g })),
    agents: current.agents.map((g) => ({ agentId: g.agentId, allowedModes: [...g.allowedModes] })),
    connectors: current.connectors.map((g) => ({ connectorId: g.connectorId, mode: g.mode, allowedObjects: [...g.allowedObjects] })),
    roleIds: [...current.roleIds],
    revision: current.revision,
  };
  for (const p of proposals) {
    if (!p.heldByStewards) continue;
    const g = p.grant;
    if (g.kind === "tool") {
      if (!proposedSet.tools.some((x) => x.serverId === g.serverId && x.toolName === g.toolName)) proposedSet.tools.push({ serverId: g.serverId, toolName: g.toolName });
    } else if (g.kind === "agent") {
      const existing = proposedSet.agents.find((x) => x.agentId === g.agentId);
      if (existing) existing.allowedModes = [...new Set([...existing.allowedModes, ...g.allowedModes])].slice(0, 20);
      else proposedSet.agents.push({ agentId: g.agentId, allowedModes: [...g.allowedModes] });
    } else {
      const existing = proposedSet.connectors.find((x) => x.connectorId === g.connectorId);
      if (existing) {
        existing.mode = existing.mode === "readwrite" || g.mode === "readwrite" ? "readwrite" : "read";
        existing.allowedObjects = [...new Set([...existing.allowedObjects, ...g.allowedObjects])].slice(0, 500);
      } else {
        proposedSet.connectors.push({ connectorId: g.connectorId, mode: g.mode, allowedObjects: [...g.allowedObjects] });
      }
    }
  }
  return {
    identityId,
    windowDays: GRANT_PROPOSAL_WINDOW_DAYS,
    since: sinceAt.toISOString(),
    revision: current.revision,
    proposals,
    proposedSet,
    unproposable,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Picker sources
// ---------------------------------------------------------------------------

/**
 * What the identity forms (and the executor registration form, ADR-0190) may
 * offer: only objects that exist and that an admin may name, each list capped
 * at `IDENTITY_PICKER_MAX`. Environments: this deployment's mode plus every
 * name an identity already allows (an exact name, never a wildcard).
 */
export async function identityPickerSources(db: Db): Promise<IdentityPickerSourcesView> {
  const cap = IDENTITY_PICKER_MAX + 1;
  const [people, freeAgents, freeBuilders, freeRunners, envRows, serverRows, agentRows, connectorRows, roleRows, workers] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(and(isNull(users.disabledAt), ne(users.id, SYSTEM_USER_ID)))
      .orderBy(asc(users.email), asc(users.id))
      .limit(cap),
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .leftJoin(workloadIdentities, eq(workloadIdentities.agentId, agents.id))
      .where(and(isNull(workloadIdentities.id), sql`coalesce(${agents.lifecycleStatus}, '') <> 'retired'`))
      .orderBy(asc(agents.name))
      .limit(cap),
    db
      .select({ id: builderAgents.id, name: builderAgents.name })
      .from(builderAgents)
      .leftJoin(workloadIdentities, eq(workloadIdentities.builderAgentId, builderAgents.id))
      .where(and(isNull(workloadIdentities.id), isNull(builderAgents.archivedAt)))
      .orderBy(asc(builderAgents.name), asc(builderAgents.id))
      .limit(cap),
    db
      .select({ id: engineRunners.id, name: engineRunners.name })
      .from(engineRunners)
      .leftJoin(workloadIdentities, eq(workloadIdentities.engineRunnerId, engineRunners.id))
      .where(and(isNull(workloadIdentities.id), isNull(engineRunners.revokedAt)))
      .orderBy(asc(engineRunners.name), asc(engineRunners.id))
      .limit(cap),
    db.execute<{ env: string }>(sql`select distinct unnest(environments) as env from workload_identities order by 1 limit ${cap}`),
    db.select({ id: mcpServers.id, name: mcpServers.name }).from(mcpServers).orderBy(asc(mcpServers.name)).limit(cap),
    db.select({ id: agents.id, name: agents.name }).from(agents).orderBy(asc(agents.name)).limit(cap),
    db.select({ id: connectors.id, name: connectors.name }).from(connectors).orderBy(asc(connectors.name)).limit(cap),
    db.select({ id: roles.id, name: roles.name }).from(roles).orderBy(asc(roles.name)).limit(cap),
    db
      .select({ id: workloadIdentities.id, identifier: workloadIdentities.identifier })
      .from(workloadIdentities)
      .where(and(eq(workloadIdentities.kind, "worker_runtime"), eq(workloadIdentities.status, "active")))
      .orderBy(asc(workloadIdentities.identifier))
      .limit(cap),
  ]);
  const servers = serverRows.slice(0, IDENTITY_PICKER_MAX);
  const toolRows = servers.length
    ? await db
        .select({ serverId: mcpTools.serverId, name: mcpTools.name })
        .from(mcpTools)
        .where(inArray(mcpTools.serverId, servers.map((s) => s.id)))
        .orderBy(asc(mcpTools.name))
    : [];
  const lists = [people, freeAgents, freeBuilders, freeRunners, envRows.rows, serverRows, agentRows, connectorRows, roleRows, workers];
  const truncated = lists.some((l) => l.length > IDENTITY_PICKER_MAX);
  const top = <T>(l: T[]) => l.slice(0, IDENTITY_PICKER_MAX);
  const opt = (r: { id: string; name: string }) => ({ id: r.id, label: r.name });
  const environments = [...new Set([resolveDeployMode(), ...envRows.rows.map((r) => r.env)])].sort().slice(0, IDENTITY_PICKER_MAX);
  return {
    sponsors: top(people).map((p) => ({ id: p.id, label: p.displayName || p.email, email: p.email })),
    subjects: { agent: top(freeAgents).map(opt), builder_agent: top(freeBuilders).map(opt), engine_runner: top(freeRunners).map(opt) },
    environments,
    servers: servers.map((s) => ({ id: s.id, label: s.name, tools: toolRows.filter((t) => t.serverId === s.id).map((t) => t.name) })),
    agents: top(agentRows).map(opt),
    connectors: top(connectorRows).map(opt),
    roles: top(roleRows).map(opt),
    workerIdentities: top(workers).map((w) => ({ id: w.id, label: w.identifier })),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The route handlers (registered literally by identity-routes.ts)
// ---------------------------------------------------------------------------

const invalidBody = (reply: FastifyReply, issues: z.ZodIssue[]) =>
  reply.status(400).send({ error: "invalid_body", detail: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

function answer(reply: FastifyReply, err: unknown) {
  if (!(err instanceof IdentityAdminError)) throw err;
  return reply.status(err.status).send({ error: err.code, detail: err.message });
}

const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? SYSTEM_USER_ID;

export function workloadIdentityS6Handlers(db: Db) {
  return {
    create: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = createWorkloadIdentitySchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const su = await requireStepUp(db, req, reply, identityCreateStepUp(parsed.data));
      if (!su.ok) return reply;
      try {
        return reply.status(201).send(await createWorkloadIdentity(db, parsed.data, actorOf(req)));
      } catch (e) {
        return answer(reply, e);
      }
    },
    revoke: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const parsed = revokeWorkloadIdentitySchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const su = await requireStepUp(db, req, reply, identityRevokeStepUp(identityId));
      if (!su.ok) return reply;
      try {
        return reply.send(await revokeWorkloadIdentity(db, identityId, actorOf(req)));
      } catch (e) {
        return answer(reply, e);
      }
    },
    listCredentials: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const out = await listWorkloadCredentials(db, identityId);
      return out ? reply.send(out) : reply.status(404).send({ error: "identity_not_found" });
    },
    addCredential: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const parsed = addWorkloadCredentialSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalidBody(reply, parsed.error.issues);
      const su = await requireStepUp(db, req, reply, credentialAddStepUp(identityId, parsed.data));
      if (!su.ok) return reply;
      try {
        return reply.status(201).send(await addWorkloadCredential(db, identityId, parsed.data, actorOf(req)));
      } catch (e) {
        return answer(reply, e);
      }
    },
    revokeCredential: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId, credentialId } = credParam.parse(req.params);
      const su = await requireStepUp(db, req, reply, credentialRevokeStepUp(identityId, credentialId));
      if (!su.ok) return reply;
      try {
        return reply.send(await revokeWorkloadCredential(db, identityId, credentialId, actorOf(req)));
      } catch (e) {
        return answer(reply, e);
      }
    },
    grantProposals: async (req: FastifyRequest, reply: FastifyReply) => {
      const { identityId } = idParam.parse(req.params);
      const out = await proposeIdentityGrants(db, identityId);
      return out ? reply.send(out) : reply.status(404).send({ error: "identity_not_found" });
    },
    pickerSources: async (_req: FastifyRequest, reply: FastifyReply) => reply.send(await identityPickerSources(db)),
  };
}
