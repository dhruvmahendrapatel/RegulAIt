/**
 * ADR-0204 — A STATIC UPSTREAM CREDENTIAL PER MCP SERVER.
 *
 * An admin attaches one secret to a network MCP server; the gateway sends it on every request to that server, as
 * `Authorization: Bearer <secret>` or in a header the admin names. It is the guaranteed way to authenticate the
 * gateway to an upstream that validates its own API keys or bearer tokens, alongside ADR-0188 S8's signed assertion
 * (`RegulAIt-Identity-Assertion`, which a credential can never name, so the two headers never collide).
 *
 * STORAGE. `mcp_server_upstream_credentials` (migration 0214), its own table so no read of `mcp_servers` can carry
 * the ciphertext. The secret is the data-key envelope every connector secret uses (`encryptSecret`), listed in
 * `CIPHERTEXT_COLUMNS`. No read returns it: `upstreamCredentialView` shows set / not set, the scheme and header, the
 * last four characters, and who set it and when. No audit row, error or log line carries it.
 *
 * WRITES. Set, rotate and clear are admin-only (the default gate), each a `settings_relax` step-up (the class the
 * discovery static credential uses) bound to the server, its url and the scheme and header, claimed in the write's
 * transaction after a compare-and-set on the url, and audited in that transaction. A url move on
 * `PATCH /v1/servers/:id` deletes the credential (`clearUpstreamCredentialOnUrlMove`, audited), as S8's identity
 * propagation resets: a secret never follows the url to a new destination.
 *
 * SENDING. `upstreamCredentialMiddleware` wraps the egress-guarded fetch of one connect (`guardedMcpConnect`). It
 * removes any value already in the credential's header, and sets it only on a request to the registered origin. The
 * guarded fetch refuses every redirect, so the secret never reaches another origin by one. A credential that cannot be
 * opened (no data key, the wrong key) refuses the connect as our own audited refusal; nothing is sent without it.
 *
 * Open source first (ADR-0176): node's AES-256-GCM through our existing envelope, the MCP SDK's own fetch middleware
 * hook (`createMiddleware`), the existing step-up and audit helpers. What is ours is when the secret may leave.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createMiddleware, type Middleware } from "@modelcontextprotocol/sdk/client/middleware.js";
import {
  and,
  auditLog,
  eq,
  mcpServers,
  mcpServerUpstreamCredentials,
  type Db,
  type McpServerUpstreamCredentialRow,
} from "@regulait/db";
import {
  MCP_UPSTREAM_BEARER_HEADER,
  MCP_UPSTREAM_CREDENTIAL_RULE_IDS,
  mcpUpstreamHeaderNameProblem,
  mcpUpstreamSecretProblem,
  setMcpUpstreamCredentialSchema,
  type McpUpstreamCredentialScheme,
  type McpUpstreamCredentialView,
  IDENTITY_ASSERTION_BEARER_CONFLICT,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { CHANGED_CONCURRENTLY, checkStepUp, type StepUpCheckArgs } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const serverParam = z.object({ serverId: z.string().uuid() });

// ---------------------------------------------------------------------------
// The data key the proxy opens credentials with
// ---------------------------------------------------------------------------

/**
 * The data key every connect opens a credential with. Set once when the app is built (`buildApp`'s `dataKey`), so the
 * connects that have no request behind them (the health probe, the admission rescan) open it too. Unset = a server
 * with a credential refuses every connect (fail closed), never a connect without its credential.
 */
let connectDataKey: string | undefined;
export function configureUpstreamCredentialKey(dataKey: string | undefined): void {
  connectDataKey = dataKey;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function upstreamCredentialView(row: McpServerUpstreamCredentialRow | undefined | null): McpUpstreamCredentialView {
  if (!row) return { set: false, scheme: null, headerName: null, last4: null, setBy: null, setAt: null };
  return {
    set: true,
    scheme: row.scheme,
    headerName: row.headerName,
    last4: row.secretLast4,
    setBy: row.setBy,
    setAt: row.secretSetAt.toISOString(),
  };
}

/** what one connect sends: the header (lowercased) and its full value */
export interface OpenedUpstreamCredential {
  headerName: string;
  value: string;
  scheme: McpUpstreamCredentialScheme;
}

/** why a stored credential could not be opened (the connect is refused, nothing is sent) */
export type UpstreamCredentialUnavailable = "data_key_unavailable" | "undecryptable";

/**
 * The credential of `serverId`, opened, or null when none is set. Read fresh per connect, never cached: a clear, a
 * rotation or a url move applies to the next connect.
 */
export async function openUpstreamCredential(
  db: Db,
  serverId: string,
): Promise<{ ok: true; credential: OpenedUpstreamCredential | null } | { ok: false; reason: UpstreamCredentialUnavailable }> {
  const [row] = await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
  if (!row) return { ok: true, credential: null };
  if (!connectDataKey) return { ok: false, reason: "data_key_unavailable" };
  let secret: string;
  try {
    secret = decryptSecret(connectDataKey, row.secretCiphertext);
  } catch {
    return { ok: false, reason: "undecryptable" };
  }
  return {
    ok: true,
    credential: {
      headerName: row.headerName,
      value: row.scheme === "bearer" ? `Bearer ${secret}` : secret,
      scheme: row.scheme,
    },
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const originOf = (input: string | URL): string => {
  try {
    return new URL(typeof input === "string" ? input : input.toString()).origin;
  } catch {
    return "invalid";
  }
};

/**
 * The init to send for one request: any value already in the credential's header removed, and the credential set
 * only when the request is bound for `registeredOrigin`. Pure, so the origin rule is tested on its own.
 */
export function withUpstreamCredential(
  credential: OpenedUpstreamCredential,
  registeredOrigin: string,
  input: string | URL,
  init: RequestInit | undefined,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.delete(credential.headerName);
  if (registeredOrigin !== "invalid" && originOf(input) === registeredOrigin) headers.set(credential.headerName, credential.value);
  return { ...init, headers };
}

/**
 * The fetch middleware (the MCP SDK's own hook) that adds the credential. It wraps OUTSIDE the identity assertion's
 * middleware, so the assertion's holder still receives the exact init the guarded fetch is given.
 */
export function upstreamCredentialMiddleware(credential: OpenedUpstreamCredential, registeredUrl: string): Middleware {
  const registeredOrigin = originOf(registeredUrl);
  return createMiddleware(async (next, input, init) => next(input, withUpstreamCredential(credential, registeredOrigin, input, init)));
}

// ---------------------------------------------------------------------------
// The url move (called by PATCH /v1/servers/:id inside its transaction)
// ---------------------------------------------------------------------------

/**
 * A server whose url moved loses its credential: deleted in the PATCH's transaction, after the row update (so the row
 * lock orders it against a concurrent set), and audited there. Returns whether one was cleared.
 */
export async function clearUpstreamCredentialOnUrlMove(
  tx: Db,
  args: { serverId: string; label: string; fromUrl: string; toUrl: string; userId: string | null },
): Promise<boolean> {
  const cleared = await tx
    .delete(mcpServerUpstreamCredentials)
    .where(eq(mcpServerUpstreamCredentials.serverId, args.serverId))
    .returning({ scheme: mcpServerUpstreamCredentials.scheme, headerName: mcpServerUpstreamCredentials.headerName });
  const was = cleared[0];
  if (!was) return false;
  await tx.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    serverId: args.serverId,
    objectType: "mcp_server",
    objectId: args.serverId,
    detail: { phase: "update", upstreamCredential: "cleared", cause: "url_move", scheme: was.scheme, headerName: was.headerName, from: args.fromUrl, to: args.toUrl },
    effect: "allow",
    ruleId: MCP_UPSTREAM_CREDENTIAL_RULE_IDS.clearedOnUrlMove,
    ruleChain: [],
    reason: `${args.label}: the url moved, so its upstream credential was cleared (it never follows the url to a new destination)`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The admin routes
// ---------------------------------------------------------------------------

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

/** a step-up refused while claimed inside the write's transaction: rolls the write back */
class StepUpRefusedInTx extends Error {
  constructor(readonly refusal: Refusal, readonly args: StepUpCheckArgs) {
    super("step_up_refused_in_transaction");
  }
}

export function upstreamCredentialStepUpArgs(
  op: "set" | "rotate" | "clear",
  server: { id: string; url: string },
  values: { scheme: McpUpstreamCredentialScheme; headerName: string } | null,
): StepUpCheckArgs {
  return {
    kind: "settings_relax",
    facts: {
      op: `mcp_upstream_credential_${op}`,
      serverId: server.id,
      url: server.url,
      ...(values ? { values: { upstreamCredential: values } } : {}),
    },
  };
}

async function auditRefusal(db: Db, req: FastifyRequest, serverId: string, label: string, code: string, detail: string, extra: Record<string, unknown> = {}): Promise<void> {
  await db.insert(auditLog).values({
    userId: req.authCtx.userId ?? NIL_USER,
    serverId,
    objectType: "mcp_server",
    objectId: serverId,
    detail: { phase: "upstream-credential", code, ...extra },
    effect: "deny",
    ruleId: MCP_UPSTREAM_CREDENTIAL_RULE_IDS.refused,
    ruleChain: [],
    reason: `${label}: upstream credential refused (${code}): ${detail}. Nothing was saved.`,
  });
}

/**
 * Run `write` in a transaction that locks the server row, re-checks that its url is still the one the step-up was
 * decided on, claims the step-up on the transaction's connection after the write, and rolls everything back on a
 * refusal. A refused claim's `step-up-grant-refused` row rolled back with it, so a look records it again.
 */
async function underServerLock<T>(
  db: Db,
  req: FastifyRequest,
  server: { id: string; url: string },
  stepUp: StepUpCheckArgs,
  write: (tx: Db) => Promise<T | Refusal>,
): Promise<T | Refusal> {
  try {
    return await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [locked] = await t.select({ url: mcpServers.url }).from(mcpServers).where(eq(mcpServers.id, server.id)).for("update");
      if (!locked) return { status: 404, body: { error: "unknown_server" } };
      if (locked.url !== server.url) return { status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
      const out = await write(t);
      if (isRefusal(out)) return out;
      const su = await checkStepUp(t, req, stepUp);
      if (!su.ok) throw new StepUpRefusedInTx({ status: su.status, body: su.body }, stepUp);
      return out;
    });
  } catch (err) {
    if (!(err instanceof StepUpRefusedInTx)) throw err;
    await checkStepUp(db, req, err.args, { spend: false });
    return err.refusal;
  }
}

const BEARER_CONFLICT_DETAIL =
  "this server sends its identity assertion as Authorization: Bearer (the oidc_bearer profile), so a Bearer credential " +
  "would collide with it. Use the header scheme, or return the server to the regulait_header profile first";

const isRefusal = (x: unknown): x is Refusal =>
  typeof x === "object" && x !== null && "status" in x && "body" in x && typeof (x as Refusal).status === "number";

export function registerMcpUpstreamCredentialRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  configureUpstreamCredentialKey(opts.dataKey);

  app.get("/v1/servers/:serverId/upstream-credential", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const [server] = await db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const [row] = await db.select().from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
    return { credential: upstreamCredentialView(row) };
  });

  /** set (`rotate` false or absent) or rotate (`rotate: true`) */
  app.put("/v1/servers/:serverId/upstream-credential", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const parsed = setMcpUpstreamCredentialSchema.safeParse(req.body);
    // the zod issue list could echo the body back, and the body holds the secret: a fixed sentence instead
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", detail: "expected { scheme: 'bearer' | 'header', headerName?, secret, rotate? }" });
    }
    const body = parsed.data;
    const [server] = await db
      .select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport, identityAssertionProfile: mcpServers.identityAssertionProfile })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const label = `MCP server '${server.name}'`;
    const refuse = async (status: number, error: string, code: string, detail: string, extra: Record<string, unknown> = {}) => {
      await auditRefusal(db, req, serverId, label, code, detail, extra);
      return reply.status(status).send({ error, code, detail });
    };
    if (server.transport === "stdio") {
      return refuse(409, "mcp_upstream_credential_unsupported", "stdio", "a stdio server has no HTTP request to carry a credential");
    }
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a secret cannot be stored encrypted" });
    }
    const headerName = body.scheme === "bearer" ? MCP_UPSTREAM_BEARER_HEADER : (body.headerName ?? "").trim().toLowerCase();
    if (body.scheme === "bearer" && body.headerName !== undefined && body.headerName.trim().toLowerCase() !== MCP_UPSTREAM_BEARER_HEADER) {
      return refuse(400, "mcp_upstream_credential_refused", "header_with_bearer", "the Bearer scheme always uses Authorization; choose the header scheme to name another header");
    }
    if (body.scheme === "header") {
      const problem = mcpUpstreamHeaderNameProblem(body.headerName ?? "");
      // the name is shape-checked before it is written to the trail
      if (problem) return refuse(400, "mcp_upstream_credential_refused", "header_refused", problem, { headerName: /^[a-z0-9-]{1,64}$/.test(headerName) ? headerName : null });
    }
    // ADR-0210: the server's OIDC-profile assertion already rides in Authorization: Bearer (re-checked under the lock)
    if (body.scheme === "bearer" && server.identityAssertionProfile === "oidc_bearer") {
      return refuse(409, IDENTITY_ASSERTION_BEARER_CONFLICT, "oidc_bearer_profile", BEARER_CONFLICT_DETAIL);
    }
    const secretProblem = mcpUpstreamSecretProblem(body.secret);
    if (secretProblem) return refuse(400, "mcp_upstream_credential_refused", "secret_refused", secretProblem, { scheme: body.scheme, headerName });
    const rotate = body.rotate === true;
    const [existing] = await db.select({ id: mcpServerUpstreamCredentials.id }).from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
    if (Boolean(existing) !== rotate) {
      return reply.status(409).send(
        existing
          ? { error: "upstream_credential_exists", detail: "this server already has an upstream credential: rotate it to replace it" }
          : { error: "no_upstream_credential", detail: "this server has no upstream credential to rotate: set one" },
      );
    }
    const stepUp = upstreamCredentialStepUpArgs(rotate ? "rotate" : "set", server, { scheme: body.scheme, headerName });
    // looked at (not spent) before anything is written, so a refusal here never burns a grant
    const look = await checkStepUp(db, req, stepUp, { spend: false });
    if (!look.ok) return reply.status(look.status).send(look.body);
    const values = {
      scheme: body.scheme,
      headerName,
      secretCiphertext: encryptSecret(opts.dataKey, body.secret),
      secretLast4: body.secret.slice(-4),
      setBy: req.authCtx.userId ?? null,
    };
    const out = await underServerLock(db, req, server, stepUp, async (t) => {
      if (body.scheme === "bearer") {
        // the row is locked: a concurrent PATCH turning the OIDC profile on is ordered against this write
        const [now] = await t.select({ profile: mcpServers.identityAssertionProfile }).from(mcpServers).where(eq(mcpServers.id, serverId));
        if (now?.profile === "oidc_bearer") return { status: 409, body: { error: IDENTITY_ASSERTION_BEARER_CONFLICT, code: "oidc_bearer_profile", detail: BEARER_CONFLICT_DETAIL } };
      }
      let row: McpServerUpstreamCredentialRow | undefined;
      if (rotate) {
        [row] = await t.update(mcpServerUpstreamCredentials).set(values).where(eq(mcpServerUpstreamCredentials.serverId, serverId)).returning();
      } else {
        [row] = await t.insert(mcpServerUpstreamCredentials).values({ serverId, ...values }).onConflictDoNothing().returning();
      }
      // a concurrent set or clear since the read above
      if (!row) return { status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
      await t.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "upstream-credential", upstreamCredential: rotate ? "rotated" : "set", scheme: row.scheme, headerName: row.headerName, url: server.url, relaxation: true },
        effect: "allow",
        ruleId: rotate ? MCP_UPSTREAM_CREDENTIAL_RULE_IDS.rotated : MCP_UPSTREAM_CREDENTIAL_RULE_IDS.set,
        ruleChain: [],
        reason: `${label}: upstream credential ${rotate ? "rotated" : "set"} (${row.scheme === "bearer" ? "Authorization: Bearer" : `header ${row.headerName}`}), sent only to ${new URL(server.url).origin}`,
      });
      return row;
    });
    if (isRefusal(out)) return reply.status(out.status).send(out.body);
    return reply.status(rotate ? 200 : 201).send({ credential: upstreamCredentialView(out) });
  });

  app.delete("/v1/servers/:serverId/upstream-credential", async (req, reply) => {
    const { serverId } = serverParam.parse(req.params);
    const [server] = await db.select({ id: mcpServers.id, name: mcpServers.name, url: mcpServers.url }).from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!server) return reply.status(404).send({ error: "unknown_server" });
    const [existing] = await db.select({ id: mcpServerUpstreamCredentials.id }).from(mcpServerUpstreamCredentials).where(eq(mcpServerUpstreamCredentials.serverId, serverId));
    if (!existing) return reply.status(404).send({ error: "no_upstream_credential", detail: "this server has no upstream credential" });
    const stepUp = upstreamCredentialStepUpArgs("clear", server, null);
    const look = await checkStepUp(db, req, stepUp, { spend: false });
    if (!look.ok) return reply.status(look.status).send(look.body);
    const label = `MCP server '${server.name}'`;
    const out = await underServerLock(db, req, server, stepUp, async (t) => {
      const [gone] = await t
        .delete(mcpServerUpstreamCredentials)
        .where(and(eq(mcpServerUpstreamCredentials.serverId, serverId), eq(mcpServerUpstreamCredentials.id, existing.id)))
        .returning({ scheme: mcpServerUpstreamCredentials.scheme, headerName: mcpServerUpstreamCredentials.headerName });
      if (!gone) return { status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
      await t.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        serverId,
        objectType: "mcp_server",
        objectId: serverId,
        detail: { phase: "upstream-credential", upstreamCredential: "cleared", scheme: gone.scheme, headerName: gone.headerName, url: server.url },
        effect: "allow",
        ruleId: MCP_UPSTREAM_CREDENTIAL_RULE_IDS.cleared,
        ruleChain: [],
        reason: `${label}: upstream credential cleared; its stored secret was destroyed`,
      });
      return { cleared: true as const };
    });
    if (isRefusal(out)) return reply.status(out.status).send(out.body);
    return { credential: upstreamCredentialView(null) };
  });
}
