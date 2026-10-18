/**
 * ADR-0185 I9 — OWNERS FOR MCP SERVERS AND CONNECTORS.
 *
 * A server or connector nobody is accountable for is the first thing a buyer
 * finds. From this batch each carries `owner_user_id` (migration 0169, FK
 * users ON DELETE SET NULL):
 *
 *   - AT REGISTRATION the owner defaults to the registering admin
 *     (`resolveRegistrationOwner`). The bootstrap token is no person, so a row
 *     it registers without naming an owner is `unowned` (owner decision
 *     2026-10-07: flagged, never refused). A named owner must be an existing,
 *     active user: 422 `unknown_owner` / `owner_inactive`, nothing saved.
 *   - LATER an admin changes it with `PUT /v1/servers/:serverId/owner` or
 *     `PUT /v1/connectors/:connectorId/owner` (admin-only via the default
 *     gate), audited with `detail.transitions`; a refusal is audited too.
 *   - READS report `ownership`: `owned`, `unowned` (no owner recorded) or
 *     `orphaned` (the recorded owner's account is deactivated) — ADR-0089's
 *     vocabulary, the same `ownershipFlagFor` the agent inventory uses.
 *
 * An alert episode about a server or connector (`mcp_server:<id>` /
 * `connector:<id>` in its subject) is owned by that owner; an orphaned owner
 * owns nothing, so the SLA sweep escalates it (alert-ownership.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, auditLog, connectors, eq, inArray, isNull, mcpServers, sql, users, type Db } from "@regulait/db";
import { setOwnerSchema, type OwnershipState } from "@regulait/shared";
import { ownershipFlagFor } from "./inventory.js";
import { CHANGED_CONCURRENTLY, ownerChangeStepUpArgs, stepUpRefusal } from "./step-up.js";

export type OwnedKind = "mcp_server" | "connector";

export const OWNERSHIP_RULE_IDS = {
  changed: { mcp_server: "mcp-server-owner-changed", connector: "connector-owner-changed" },
  refused: { mcp_server: "mcp-server-owner-change-refused", connector: "connector-owner-change-refused" },
} as const;

const NIL = "00000000-0000-0000-0000-000000000000";
const requestedOwner = z.string().uuid().nullable().optional();

export type OwnerResolution =
  | { ok: true; ownerUserId: string | null }
  | { ok: false; status: 422; body: { error: "unknown_owner" | "owner_inactive"; detail: string } };

/** an owner someone names must be an existing, active user */
export async function checkOwnerTarget(db: Db, ownerUserId: string | null): Promise<OwnerResolution> {
  if (ownerUserId === null) return { ok: true, ownerUserId: null };
  const [u] = await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(eq(users.id, ownerUserId));
  if (!u) {
    return { ok: false, status: 422, body: { error: "unknown_owner", detail: "no user has this id; nothing was saved" } };
  }
  if (u.disabledAt) {
    return {
      ok: false,
      status: 422,
      body: { error: "owner_inactive", detail: "this user's account is deactivated and cannot own anything; nothing was saved" },
    };
  }
  return { ok: true, ownerUserId: u.id };
}

/**
 * The owner a NEW server or connector is registered with. `requested`
 * undefined = the registering admin (null for the bootstrap token: unowned);
 * null = explicitly unowned; a uuid = that user, if they exist and are active.
 * `requested` may be raw body data (a route whose schema does not name the
 * field yet): anything but a uuid or null is a 422 `unknown_owner`.
 */
export async function resolveRegistrationOwner(
  db: Db,
  args: { actorUserId: string | null | undefined; requested: unknown },
): Promise<OwnerResolution> {
  const parsed = requestedOwner.safeParse(args.requested);
  if (!parsed.success) {
    return { ok: false, status: 422, body: { error: "unknown_owner", detail: "ownerUserId must be a user id or null; nothing was saved" } };
  }
  if (parsed.data === undefined) return { ok: true, ownerUserId: args.actorUserId ?? null };
  return checkOwnerTarget(db, parsed.data);
}

/** `ownerUserId` + `ownership` for each row (GET /v1/servers, GET /v1/connectors) */
export async function withOwnership<T extends { ownerUserId: string | null }>(
  db: Db,
  rows: readonly T[],
): Promise<Array<T & { ownership: OwnershipState }>> {
  const ids = [...new Set(rows.flatMap((r) => (r.ownerUserId ? [r.ownerUserId] : [])))];
  const disabled = new Set<string>();
  if (ids.length > 0) {
    for (const u of await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(inArray(users.id, ids))) {
      if (u.disabledAt) disabled.add(u.id);
    }
  }
  return rows.map((r) => ({ ...r, ownership: ownershipFlagFor(r.ownerUserId, r.ownerUserId ? disabled.has(r.ownerUserId) : false) }));
}

async function ownershipOf(db: Db, ownerUserId: string | null): Promise<OwnershipState> {
  if (!ownerUserId) return "unowned";
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, ownerUserId), isNull(users.disabledAt)));
  return u ? "owned" : "orphaned";
}

const tableFor = (kind: OwnedKind) => (kind === "mcp_server" ? mcpServers : connectors);

export type OwnerChangeGate = (
  change: { from: string | null; to: string | null },
  opts?: { db: Db; spend: boolean },
) => Promise<{ status: number; body: Record<string, unknown> } | null>;

/** the in-transaction claim was refused: thrown so the owner write rolls back */
class OwnerClaimRefused extends Error {
  constructor(readonly refused: { status: number; body: Record<string, unknown> }) {
    super("step-up refused");
  }
}

/**
 * Change one server's or connector's owner, audited with `detail.transitions`
 * (refusals audited as `deny`). Used by the two PUT routes, and by
 * `PATCH /v1/servers/:serverId` when its body names `ownerUserId`.
 */
export async function changeOwner(
  db: Db,
  args: {
    kind: OwnedKind;
    id: string;
    ownerUserId: string | null;
    actorUserId: string | null | undefined;
    /** ADR-0186 A: the `owner_change` step-up, asked only when the owner really
     * changes. Looked at (`spend: false`, on `db`) after the target is validated
     * and before anything is written; then SPENT (`spend: true`) on the write's
     * own transaction, after the compare-and-set. A non-null answer is the
     * refusal, and nothing is written */
    gate?: OwnerChangeGate;
  },
): Promise<
  | { ok: true; body: { id: string; ownerUserId: string | null; ownership: OwnershipState } }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const table = tableFor(args.kind);
  const label = args.kind === "mcp_server" ? "MCP server" : "connector";
  const [before] = await db
    .select({ id: table.id, name: table.name, ownerUserId: table.ownerUserId })
    .from(table)
    .where(eq(table.id, args.id));
  if (!before) return { ok: false, status: 404, body: { error: args.kind === "mcp_server" ? "unknown_server" : "unknown_connector" } };
  const target = await checkOwnerTarget(db, args.ownerUserId);
  if (!target.ok) {
    await db.insert(auditLog).values({
      userId: args.actorUserId ?? NIL,
      objectType: args.kind,
      objectId: before.id,
      detail: { subsystem: "ownership", requested: args.ownerUserId, error: target.body.error, ownerUserId: before.ownerUserId, receiptClass: "configuration" },
      effect: "deny",
      ruleId: OWNERSHIP_RULE_IDS.refused[args.kind],
      ruleChain: [],
      reason: `${label} '${before.name}': owner change refused (${target.body.error})`,
    });
    return target;
  }
  const gate = args.gate && before.ownerUserId !== target.ownerUserId ? args.gate : null;
  const change = { from: before.ownerUserId, to: target.ownerUserId };
  // looked at (not spent) here, so a request without a grant is answered at once; SPENT inside the transaction, on
  // its connection, after the compare-and-set, so losing it to a concurrent change (409) never burns the grant
  if (gate) {
    const refused = await gate(change, { db, spend: false });
    if (refused) return { ok: false, ...refused };
  }
  const fromOwnership = await ownershipOf(db, before.ownerUserId);
  type Out =
    | { ok: true; body: { id: string; ownerUserId: string | null; ownership: OwnershipState } }
    | { ok: false; status: number; body: Record<string, unknown> };
  return db
    .transaction(async (tx): Promise<Out> => {
      // each table named statically, so rule-write-guard.test.ts can see the writers
      const [after] =
        args.kind === "mcp_server"
          ? await tx
              .update(mcpServers)
              .set({ ownerUserId: target.ownerUserId })
              // ADR-0186 A (Class A): compare-and-set on the owner the step-up was decided on
              .where(and(eq(mcpServers.id, before.id), sql`${mcpServers.ownerUserId} IS NOT DISTINCT FROM ${before.ownerUserId}`))
              .returning({ id: mcpServers.id, ownerUserId: mcpServers.ownerUserId })
          : await tx
              .update(connectors)
              .set({ ownerUserId: target.ownerUserId })
              .where(and(eq(connectors.id, before.id), sql`${connectors.ownerUserId} IS NOT DISTINCT FROM ${before.ownerUserId}`))
              .returning({ id: connectors.id, ownerUserId: connectors.ownerUserId });
      if (!after) return { ok: false, status: CHANGED_CONCURRENTLY.status, body: { ...CHANGED_CONCURRENTLY.body } };
      // write first, then spend: the single-use claim is made on THIS transaction's connection once the row is
      // written, and a refused claim throws to roll the write back
      if (gate) {
        const refused = await gate(change, { db: tx as unknown as Db, spend: true });
        if (refused) throw new OwnerClaimRefused(refused);
      }
      const toOwnership = await auditOwnerChanged(tx as unknown as Db, {
        kind: args.kind,
        id: before.id,
        name: before.name,
        from: before.ownerUserId,
        to: after.ownerUserId,
        fromOwnership,
        actorUserId: args.actorUserId,
      });
      return { ok: true, body: { id: after.id, ownerUserId: after.ownerUserId, ownership: toOwnership } };
    })
    .catch(async (e: unknown): Promise<Out> => {
      if (!(e instanceof OwnerClaimRefused) || !gate) throw e;
      // the claim's own `step-up-grant-refused` row rolled back with the write: a look records it again, spending nothing
      await gate(change, { db, spend: false });
      return { ok: false, ...e.refused };
    });
}

/**
 * The `*-owner-changed` audit row of one owner change, written on `db` (a write's own transaction when the owner is
 * changed together with other columns, as `PATCH /v1/servers/:serverId` does). `fromOwnership` is read before the
 * write (`ownershipStateOf`). Answers the new ownership state.
 */
export async function auditOwnerChanged(
  db: Db,
  args: {
    kind: OwnedKind;
    id: string;
    name: string;
    from: string | null;
    to: string | null;
    fromOwnership: OwnershipState;
    actorUserId: string | null | undefined;
  },
): Promise<OwnershipState> {
  const label = args.kind === "mcp_server" ? "MCP server" : "connector";
  const toOwnership: OwnershipState = args.to ? "owned" : "unowned";
  await db.insert(auditLog).values({
    userId: args.actorUserId ?? NIL,
    objectType: args.kind,
    objectId: args.id,
    detail: {
      subsystem: "ownership",
      transitions: {
        ownerUserId: { from: args.from, to: args.to },
        ownership: { from: args.fromOwnership, to: toOwnership },
      },
      receiptClass: "configuration",
    },
    effect: "allow",
    ruleId: OWNERSHIP_RULE_IDS.changed[args.kind],
    ruleChain: [],
    reason:
      `${label} '${args.name}': owner ${args.from ? `a user (id ${args.from})` : "none"} → ` +
      `${args.to ? `a user (id ${args.to})` : "none (unowned)"}`,
  });
  return toOwnership;
}

/** the ownership state an owner id stands for now (owned, orphaned by a deactivated user, or unowned) */
export const ownershipStateOf = ownershipOf;

/**
 * ADR-0186 A: the `owner_change` step-up, bound to the object and the new owner. Without `opts` it spends on the
 * root handle (POST /v1/agents/:id/owner); `changeOwner` looks on `db` first and spends on its own transaction.
 */
export function ownerChangeGate(db: Db, req: FastifyRequest, objectType: OwnedKind | "agent", objectId: string): OwnerChangeGate {
  return (change, opts = { db, spend: true }) =>
    stepUpRefusal(opts.db, req, ownerChangeStepUpArgs(objectType, objectId, change.to), { spend: opts.spend });
}

/**
 * Routes (admin-only via the default gate — neither is in NON_ADMIN_ROUTES):
 *   PUT /v1/servers/:serverId/owner         {"ownerUserId": "<uuid>" | null}
 *   PUT /v1/connectors/:connectorId/owner   {"ownerUserId": "<uuid>" | null}
 */
export function registerOwnershipRoutes(app: FastifyInstance, db: Db): void {
  const route = (kind: OwnedKind, param: "serverId" | "connectorId") => async (req: FastifyRequest, reply: FastifyReply) => {
    const id = z.object({ [param]: z.string().uuid() }).parse(req.params)[param] as string;
    const body = setOwnerSchema.parse(req.body);
    const out = await changeOwner(db, {
      kind,
      id,
      ownerUserId: body.ownerUserId,
      actorUserId: req.authCtx.userId ?? null,
      gate: ownerChangeGate(db, req, kind, id),
    });
    if (!out.ok) return reply.status(out.status).send(out.body);
    return out.body;
  };
  app.put("/v1/servers/:serverId/owner", route("mcp_server", "serverId"));
  app.put("/v1/connectors/:connectorId/owner", route("connector", "connectorId"));
}
