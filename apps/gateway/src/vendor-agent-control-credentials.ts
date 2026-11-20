/**
 * ADR-0338 slice 1b: a source's vendor CONTROL credential, the `platform_write` row of `discovery_credentials`.
 *
 * The purposes never cross (ADR-0338 §2): the discovery scanner and the read-credential routes load only
 * `purpose = 'discovery_read'` (discovery-worker.ts, discovery-routes.ts); this module loads only
 * `purpose = 'platform_write'`. A row's purpose, mode, public config and expiry are fixed at insert (the
 * `discovery_credentials_guard` trigger), so a rotation is a replacement: the old row is revoked and its secret destroyed.
 *
 * STRICT DEFAULT (ADR-0180): a source has no control credential until an admin stores one with a `settings_relax`
 * step-up bound to the source, the mode, the app and the row it replaces, audited in the same transaction. Federated
 * (Entra workload identity, no stored secret) is the default; a stored client secret is accepted on the same step-up;
 * a delegated (named admin) credential is refused here, since it is connected through the vendor's sign-in flow
 * (ADR-0338 §3a, `@azure/msal-node`), which is slice 1c. Revoking is free and audited. The write app must not be the
 * source's read app, and it must be in the source's tenant.
 *
 * Routes (admin-only, API-only: KNOWN_UI_GAPS against #453):
 *   GET    /v1/discovery/sources/:sourceId/control-credential   the live control credential's metadata, never a secret
 *   PUT    /v1/discovery/sources/:sourceId/control-credential   store or replace it (`settings_relax` step-up)
 *   DELETE /v1/discovery/sources/:sourceId/control-credential   revoke it (free)
 *
 * The token (open source first, ADR-0176): `@azure/identity` through `@regulait/cloud-discovery`'s `azureCredential`
 * (already the discovery path's Entra client), over the tenant's guarded fetch, for exactly the control's scope. A
 * federated assertion is minted for the CONTROL subject (`vendorAgentControlSubject`), never the read subject.
 */
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, auditLog, discoveryCredentials, discoverySettings, discoverySources, eq, isNull, sql, type Db, type DiscoveryCredentialRow } from "@regulait/db";
import {
  AGENT_REGISTRIES_BY_KIND,
  FEDERATION_AUDIENCES,
  vendorAgentControlSubject,
  type DiscoverySourceKind,
  type DiscoveryStoredCredentialMode,
} from "@regulait/shared";
import { azureCredential } from "@regulait/cloud-discovery";
import { federationTokenMinter } from "./federation-signing-keys.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";
import type { ControlTokenSpec, VendorAgentControl } from "./vendor-agent-control-contract.js";

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** a usable control credential: its row id (bound into an action's approval digest) and how to get its token */
export interface ControlCredential {
  readonly id: string;
  readonly mode: DiscoveryStoredCredentialMode;
  /** a short-lived token for the control's scope; called outside any database transaction */
  acquire(signal: AbortSignal): Promise<string>;
}
export const CONTROL_CREDENTIAL_REFUSALS = ["no_control_credential", "credential_expired", "credential_mode_disabled", "credential_mode_not_accepted"] as const;
export type ControlCredentialRefusal = (typeof CONTROL_CREDENTIAL_REFUSALS)[number];
export type ControlCredentialLookup = { ok: true; credential: ControlCredential } | { ok: false; code: ControlCredentialRefusal; detail: string };
/** the source's live `platform_write` credential for this control, or why there is none usable */
export type ControlCredentialResolver = (db: Db, sourceId: string, control: VendorAgentControl) => Promise<ControlCredentialLookup>;

/** a token could not be obtained; `code` is fixed, never vendor or Entra text (only an AADSTS code is kept) */
export class ControlTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** the ONE query for a source's live control credential: `platform_write` only (pinned by the ADR-0338 tests) */
export async function liveControlCredentialRow(db: Db, sourceId: string): Promise<{ cred: DiscoveryCredentialRow; expired: boolean; ageDays: number } | undefined> {
  const [row] = await db
    .select({
      cred: discoveryCredentials,
      // the database clock (M-075)
      expired: sql<boolean>`coalesce(${discoveryCredentials.expiresAt} <= now(), false)`,
      ageDays: sql<number>`floor(extract(epoch from (now() - ${discoveryCredentials.createdAt})) / 86400)::int`,
    })
    .from(discoveryCredentials)
    .where(and(eq(discoveryCredentials.sourceId, sourceId), eq(discoveryCredentials.purpose, "platform_write"), isNull(discoveryCredentials.revokedAt)));
  return row ? { cred: row.cred, expired: row.expired, ageDays: Number(row.ageDays) } : undefined;
}

const refused = (code: ControlCredentialRefusal, detail: string): ControlCredentialLookup => ({ ok: false, code, detail });

/** why a live row is not usable for this control right now, or null (no token is requested) */
async function usabilityProblem(db: Db, row: { cred: DiscoveryCredentialRow; expired: boolean }, control: VendorAgentControl): Promise<ControlCredentialLookup | null> {
  const mode = row.cred.credentialMode;
  if (!control.acceptedModes.includes(mode)) return refused("credential_mode_not_accepted", `this vendor does not accept a ${mode} control credential`);
  if (mode === "delegated") {
    const [s] = await db.select({ on: discoverySettings.vendorAgentControlDelegatedEnabled }).from(discoverySettings).where(eq(discoverySettings.id, 1));
    if (!s?.on) return refused("credential_mode_disabled", "delegated control credentials are turned off in the discovery settings; revoke it or turn the opt-in back on (a step-up)");
  }
  if (row.expired) return refused("credential_expired", "the control credential expired; store a new one (a step-up)");
  return null;
}

export interface ControlTokenDeps {
  dataKey?: string;
  /** the tenant's guarded fetch (egress allow-list, SSRF guard), built per call */
  fetch: () => Promise<typeof fetch>;
  /** TEST SEAM: the federation token supplier for a source's control subject (default: the federation issuer) */
  federationToken?: (db: Db, sourceId: string) => (audience: string) => Promise<string>;
}

/** the production resolver: the live `platform_write` row, its usability, and an Entra token for the control's scope */
export function controlCredentialResolver(deps: ControlTokenDeps): ControlCredentialResolver {
  return async (db, sourceId, control) => {
    const row = await liveControlCredentialRow(db, sourceId);
    if (!row) return refused("no_control_credential", "the source has no live control credential (a separate platform_write credential, never the read credential)");
    const problem = await usabilityProblem(db, row, control);
    if (problem) return problem;
    const cred = row.cred;
    return { ok: true, credential: { id: cred.id, mode: cred.credentialMode, acquire: (signal) => acquireToken(db, deps, cred, control.token, signal) } };
  };
}

async function acquireToken(db: Db, deps: ControlTokenDeps, cred: DiscoveryCredentialRow, spec: ControlTokenSpec, signal: AbortSignal): Promise<string> {
  if (spec.provider !== "entra") throw new ControlTokenError("token_provider_unsupported", "this control's token provider is not supported");
  const tenantId = cred.publicConfig.tenantId;
  const clientId = cred.publicConfig.clientId;
  if (!tenantId || !clientId) throw new ControlTokenError("credential_incomplete", "the control credential names no tenant or app");
  const [source] = await db.select({ target: discoverySources.target }).from(discoverySources).where(eq(discoverySources.id, cred.sourceId));
  if (!source || String(source.target.tenantId ?? "").toLowerCase() !== tenantId.toLowerCase()) {
    throw new ControlTokenError("credential_target_mismatch", "the control credential's tenant is not the source's tenant");
  }
  let credential: Parameters<typeof azureCredential>[0]["credential"];
  let oidcToken: ((audience: string) => Promise<string>) | undefined;
  if (cred.credentialMode === "static") {
    if (!deps.dataKey || !cred.secretCiphertext) throw new ControlTokenError("data_key_unavailable", "the stored secret cannot be read without the data key");
    let clientSecret: string;
    try {
      clientSecret = decryptSecret(deps.dataKey, cred.secretCiphertext);
    } catch {
      throw new ControlTokenError("credential_unreadable", "the control credential does not decrypt under the current data key");
    }
    credential = { mode: "azure_client_secret", tenantId, clientId, clientSecret };
  } else if (cred.credentialMode === "federated") {
    credential = { mode: "azure_federated", tenantId, clientId };
    oidcToken = (deps.federationToken ?? defaultFederationToken(deps.dataKey))(db, cred.sourceId);
  } else {
    throw new ControlTokenError("delegated_connect_not_available", "a delegated control credential is connected through the vendor's sign-in flow, which is not built yet (ADR-0338 slice 1c)");
  }
  const tokenSource = azureCredential({ fetch: await deps.fetch(), credential, ...(oidcToken ? { oidcToken } : {}) });
  try {
    const tok = await tokenSource.getToken(spec.scope, { abortSignal: signal });
    if (!tok?.token) throw new Error("no token");
    return tok.token;
  } catch (err) {
    // only the AADSTS code is kept from the error text (as discovery-wider-scanners.ts does)
    const aad = /AADSTS[0-9]{5,7}/.exec(err instanceof Error ? err.message : String(err))?.[0];
    throw new ControlTokenError("control_token_failed", `the Entra token request failed${aad ? ` (${aad})` : ""}`);
  }
}

const defaultFederationToken = (dataKey: string | undefined) => (db: Db, sourceId: string) =>
  federationTokenMinter(db, { dataKey, subject: vendorAgentControlSubject(sourceId), allowedAudiences: [FEDERATION_AUDIENCES.azure] });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const sourceParam = z.object({ sourceId: z.string().uuid() });
export const controlCredentialSchema = z
  .object({
    mode: z.enum(["federated", "static", "delegated"]).default("federated"),
    /** identifiers only: the tenant and the write app (never a key; anything else is refused) */
    publicConfig: z.object({ tenantId: z.string().regex(GUID), clientId: z.string().regex(GUID) }).strict(),
    /** a static credential's client secret; encrypted with the data key, never returned */
    secret: z.string().min(1).max(4096).optional(),
    /** the live control credential this replaces, or null when there is none (no silent overwrite) */
    replacesCredentialId: z.string().uuid().nullable(),
  })
  .strict();
export type ControlCredentialBody = z.infer<typeof controlCredentialSchema>;

/** the store step-up: bound to the source, the mode, the app and the row it replaces */
export const controlCredentialStepUp = (sourceId: string, b: ControlCredentialBody): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: {
    op: "vendor_control_credential",
    sourceId: sourceId.toLowerCase(),
    mode: b.mode,
    tenantId: b.publicConfig.tenantId.toLowerCase(),
    clientId: b.publicConfig.clientId.toLowerCase(),
    replacesCredentialId: b.replacesCredentialId?.toLowerCase() ?? null,
  },
});

/** the control a source kind's records are executed by, or null (its registries declare none) */
export function controlForKind(controls: Readonly<Record<string, VendorAgentControl>>, kind: DiscoverySourceKind): VendorAgentControl | null {
  for (const r of AGENT_REGISTRIES_BY_KIND[kind] ?? []) if (Object.hasOwn(controls, r)) return controls[r]!;
  return null;
}

type Refusal = { status: number; body: Record<string, unknown> };
const refusal = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}): Refusal => ({ status, body: { error, detail, ...extra } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

const audit = (t: Db, userId: string, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
  t.insert(auditLog).values({ userId, objectType: "discovery_credential", objectId, detail: { subsystem: "vendor-agent-control", adr: "0338", purpose: "platform_write", ...detail }, effect, ruleId, ruleChain: [], reason });

/** what an admin sees: never the secret, the ciphertext or a token */
function view(row: { cred: DiscoveryCredentialRow; ageDays: number }, problem: ControlCredentialLookup | null) {
  const c = row.cred;
  return {
    id: c.id,
    sourceId: c.sourceId,
    purpose: "platform_write" as const,
    mode: c.credentialMode,
    publicConfig: c.publicConfig,
    hasSecret: c.secretCiphertext !== null,
    createdAt: c.createdAt.toISOString(),
    ageDays: row.ageDays,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    // §3a: whether the vendor accepts this credential for control is proven only by a live tenant (owner-gated)
    controlScope: "unverified" as const,
    usable: problem === null,
    refusal: problem && !problem.ok ? problem.code : null,
  };
}

export function registerVendorControlCredentialRoutes(app: FastifyInstance, db: Db, opts: { controls: Readonly<Record<string, VendorAgentControl>>; dataKey?: string }): void {
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send(r.body);
  const personOf = (req: FastifyRequest) => req.authCtx.userId ?? null;
  const PERSON = refusal(403, "person_required", "a control credential is managed by a signed-in administrator");

  app.get("/v1/discovery/sources/:sourceId/control-credential", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const [s] = await db.select({ id: discoverySources.id, kind: discoverySources.kind }).from(discoverySources).where(eq(discoverySources.id, p.data.sourceId));
    if (!s) return send(reply, refusal(404, "not_found", "no such discovery source"));
    const row = await liveControlCredentialRow(db, s.id);
    if (!row) return send(reply, refusal(404, "no_control_credential", "this source has no live control credential"));
    const control = controlForKind(opts.controls, s.kind);
    const problem = control ? await usabilityProblem(db, row, control) : refused("credential_mode_not_accepted", "this source's registry offers no control");
    return reply.send({ credential: view(row, problem) });
  });

  app.put("/v1/discovery/sources/:sourceId/control-credential", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = controlCredentialSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const b = parsed.data;
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    if (b.mode === "delegated") {
      return send(reply, refusal(409, "delegated_connect_not_available", "a delegated control credential is connected through the vendor's sign-in flow as the named admin (ADR-0338 §3a), which is not built yet; store a federated service principal instead"));
    }
    if (b.mode === "federated" && b.secret !== undefined) return send(reply, refusal(400, "federated_has_no_secret", "a federated credential is short-lived and has no stored secret"));
    if (b.mode === "static" && b.secret === undefined) return send(reply, refusal(400, "secret_required", "a static credential needs its client secret"));
    if (b.mode === "static" && !opts.dataKey) return send(reply, refusal(503, "data_key_unavailable", "the data key is not configured, so a secret cannot be stored encrypted"));
    const out = await db.transaction(async (tx): Promise<Refusal | { cred: DiscoveryCredentialRow; ageDays: number }> => {
      const t = tx as unknown as Db;
      const [s] = await t.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId)).for("update");
      if (!s) return refusal(404, "not_found", "no such discovery source");
      const control = controlForKind(opts.controls, s.kind);
      if (!control) return refusal(409, "control_not_offered", `a ${s.kind} source's registry offers no vendor control`);
      if (!control.acceptedModes.includes(b.mode)) return refusal(409, "credential_mode_not_accepted", `this vendor does not accept a ${b.mode} control credential`);
      if (String(s.target.tenantId ?? "").toLowerCase() !== b.publicConfig.tenantId.toLowerCase()) {
        return refusal(400, "credential_target_mismatch", "the control credential names a different tenant than the source's target");
      }
      // §2: the read credential is never used to write: the write app must be a different app from the read app
      const [read] = await t
        .select({ publicConfig: discoveryCredentials.publicConfig })
        .from(discoveryCredentials)
        .where(and(eq(discoveryCredentials.sourceId, s.id), eq(discoveryCredentials.purpose, "discovery_read"), isNull(discoveryCredentials.revokedAt)));
      if (read && String(read.publicConfig.clientId ?? "").toLowerCase() === b.publicConfig.clientId.toLowerCase()) {
        return refusal(400, "write_app_is_read_app", "the control credential must be a separate app from the source's read-only discovery app");
      }
      const live = await liveControlCredentialRow(t, s.id);
      if ((live?.cred.id ?? null) !== (b.replacesCredentialId?.toLowerCase() ?? null)) {
        return refusal(409, "credential_conflict", live ? `this source already has a control credential (${live.cred.id}); name it in replacesCredentialId to replace it` : "this source has no control credential; replacesCredentialId must be null");
      }
      // ADR-0338 §2: adding a control credential is a relaxation; the grant is spent with the writes it authorises
      const stepUp = controlCredentialStepUp(s.id, b);
      const su = await checkStepUp(t, req, stepUp, { spend: true });
      if (!su.ok) {
        if (!isStepUpPrompt(su.body)) {
          await audit(t, userId, null, "vendor-control-credential-step-up-refused", "deny", `storing a vendor control credential was refused: ${String(su.body.error)} (ADR-0338)`, { sourceId: s.id, error: su.body.error });
        }
        return { status: su.status, body: su.body };
      }
      if (live) {
        await t.update(discoveryCredentials).set({ revokedAt: sql`now()`, revokedBy: userId, secretCiphertext: null }).where(eq(discoveryCredentials.id, live.cred.id));
      }
      const [row] = await t
        .insert(discoveryCredentials)
        .values({
          sourceId: s.id,
          purpose: "platform_write",
          credentialMode: b.mode,
          publicConfig: { tenantId: b.publicConfig.tenantId.toLowerCase(), clientId: b.publicConfig.clientId.toLowerCase() },
          secretCiphertext: b.mode === "static" ? encryptSecret(opts.dataKey!, b.secret!) : null,
          createdBy: userId,
        })
        .returning();
      await audit(
        t,
        userId,
        row!.id,
        live ? "vendor-control-credential-replaced" : "vendor-control-credential-stored",
        "allow",
        `${b.mode} vendor control credential ${live ? "replaced" : "stored"} for discovery source '${s.name}' (a relaxation, confirmed with a step-up ${su.method}) (ADR-0338)`,
        { sourceId: s.id, kind: s.kind, mode: b.mode, tenantId: row!.publicConfig.tenantId, clientId: row!.publicConfig.clientId, replacedCredentialId: live?.cred.id ?? null, stepUp: su.method },
      );
      return { cred: row!, ageDays: 0 };
    });
    if (isRefusal(out)) return send(reply, out);
    return reply.status(201).send({ credential: view(out, null) });
  });

  app.delete("/v1/discovery/sources/:sourceId/control-credential", async (req, reply) => {
    const p = sourceParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const userId = personOf(req);
    if (!userId) return send(reply, PERSON);
    // revoking narrows, so it needs no step-up; the revoke and its audit row commit together
    const out = await db.transaction(async (tx): Promise<Refusal | { revoked: string }> => {
      const t = tx as unknown as Db;
      const [s] = await t.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId)).for("update");
      if (!s) return refusal(404, "not_found", "no such discovery source");
      const live = await liveControlCredentialRow(t, s.id);
      if (!live) return refusal(404, "no_control_credential", "this source has no live control credential");
      await t.update(discoveryCredentials).set({ revokedAt: sql`now()`, revokedBy: userId, secretCiphertext: null }).where(eq(discoveryCredentials.id, live.cred.id));
      await audit(t, userId, live.cred.id, "vendor-control-credential-revoked", "allow", `the vendor control credential of discovery source '${s.name}' was revoked; its stored secret was destroyed (ADR-0338)`, {
        sourceId: s.id,
        kind: s.kind,
        mode: live.cred.credentialMode,
      });
      return { revoked: live.cred.id };
    });
    if (isRefusal(out)) return send(reply, out);
    return reply.send(out);
  });
}
