/**
 * ADR-0255 (P31) — THE GOVERNED CONNECTOR CATALOGUE.
 *
 * The catalogue is the curated Activepieces community pieces RegulAIt has a clean-room adapter for
 * (`CURATED_PIECES`, @regulait/connector-provider) plus the rest of the community catalogue, listed as "available,
 * not enabled" (`AVAILABLE_PIECES`, names and versions only).
 *
 * What this module adds, and what it deliberately does not:
 *  - ENABLEMENT. A curated piece is off until an admin enables it (ADR-0180): no row in
 *    `connector_piece_enablements` = not enabled. Enabling widens the deployment's footprint, so it is an admin route
 *    (the default gate; not in NON_ADMIN_ROUTES), takes a `settings_relax` step-up, and writes its audit row in the
 *    same transaction as the row. Disabling tightens, so it takes no step-up, and is audited the same way.
 *  - THE GATE (`refusePieceConnector`): a piece-kind connector can be neither created nor invoked while its piece is
 *    not enabled, on an air-gapped deployment, or with a `baseUrl` override. It runs inside the governed connector
 *    call, after the entitlement decision, so it never stands in for a grant.
 *  - NOTHING ELSE. Per-user default-deny entitlement (connector grants, with `allowedObjects` naming the ACTIONS a
 *    person may run), cost attribution, the approvals hold, PII, guardrails, the egress guard and the audit row are
 *    the existing connector interception point (`executeGovernedConnectorCall`); a piece is one more connector kind
 *    behind it, not a second path.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, connectorPieceEnablements, eq, type Db } from "@regulait/db";
import {
  AVAILABLE_PIECES,
  AVAILABLE_PIECES_SOURCE,
  CURATED_PIECES,
  curatedPieceByKey,
  curatedPieceByKind,
  isPieceProviderKind,
} from "@regulait/connector-provider";
import { resolveDeployMode } from "./deploy-posture.js";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** ONE stable ruleId, so one audit query answers "who enabled or disabled which piece, when and why". */
export const CONNECTOR_CATALOGUE_RULE_ID = "connector-catalogue-enablement-changed";
/** the ruleId of a piece-connector refusal (create or invoke) */
export const CONNECTOR_PIECE_GATE_RULE_ID = "connector-piece-gate";

export async function isPieceEnabled(db: Pick<Db, "select">, pieceKey: string): Promise<boolean> {
  const [row] = await db
    .select({ pieceKey: connectorPieceEnablements.pieceKey })
    .from(connectorPieceEnablements)
    .where(eq(connectorPieceEnablements.pieceKey, pieceKey));
  return !!row;
}

export interface PieceRefusal {
  status: number;
  error: "piece_air_gapped" | "piece_not_enabled" | "piece_base_url_refused";
  detail: string;
}

/**
 * The one predicate every path asks (M-075: one shared "is it live" check): may a connector of `providerKind` run?
 * Null for a non-piece kind, or a piece that is enabled on a deployment that permits it.
 */
export async function refusePieceConnector(
  db: Pick<Db, "select">,
  args: { providerKind: string | null | undefined; baseUrl: string | null | undefined; label: string },
): Promise<PieceRefusal | null> {
  if (!args.providerKind || !isPieceProviderKind(args.providerKind)) return null;
  const piece = curatedPieceByKind(args.providerKind)!;
  if (resolveDeployMode() === "air_gapped") {
    return {
      status: 403,
      error: "piece_air_gapped",
      detail: `${args.label}: catalogue pieces call public SaaS APIs, and this deployment is air-gapped (REGULAIT_DEPLOY_MODE=air_gapped). Refused.`,
    };
  }
  if (args.baseUrl) {
    return {
      status: 409,
      error: "piece_base_url_refused",
      detail: `${args.label}: a catalogue piece reaches only its vendor's API; it takes no baseUrl override`,
    };
  }
  if (!(await isPieceEnabled(db, piece.key))) {
    return {
      status: 403,
      error: "piece_not_enabled",
      detail: `${args.label}: the catalogue piece '${piece.key}' is not enabled. An admin enables it under the connector catalogue.`,
    };
  }
  return null;
}

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    /** a case-insensitive substring of the piece key; plain text, matched with `includes`, never a pattern */
    q: z.string().trim().max(80).optional(),
  })
  .strict();

const enablementBodySchema = z
  .object({
    enabled: z.boolean(),
    /** why: an enablement nobody can explain is no evidence */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

async function curatedView(db: Pick<Db, "select">) {
  const rows = await db.select().from(connectorPieceEnablements);
  const byKey = new Map(rows.map((r) => [r.pieceKey, r]));
  return CURATED_PIECES.map((p) => {
    const row = byKey.get(p.key);
    return {
      key: p.key,
      providerKind: p.kind,
      displayName: p.displayName,
      upstream: p.upstream,
      status: row ? ("enabled" as const) : ("not_enabled" as const),
      enabledAt: row ? row.enabledAt.toISOString() : null,
      enabledByUserId: row?.enabledByUserId ?? null,
      actions: p.actions.map((a) => ({ name: a.name, displayName: a.displayName, operation: a.classification })),
    };
  });
}

export function registerConnectorCatalogueRoutes(app: FastifyInstance, db: Db): void {
  // admin-only through the default gate (not in NON_ADMIN_ROUTES)
  app.get("/v1/connector-catalogue", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_query", detail: "expected limit (1-200), offset (0-100000), q (up to 80 characters)" });
    }
    const { limit, offset, q } = parsed.data;
    const needle = q?.toLowerCase();
    const matching = needle ? AVAILABLE_PIECES.filter(([key]) => key.includes(needle)) : AVAILABLE_PIECES;
    const mode = resolveDeployMode();
    return {
      deployMode: mode,
      // on an air-gapped deployment nothing in the catalogue can run, enabled or not
      runnable: mode !== "air_gapped",
      curated: await curatedView(db),
      available: {
        total: matching.length,
        limit,
        offset,
        // each row was checked against the upstream tree at `source.commit` (scripts/connector-catalogue-refresh.mjs)
        source: AVAILABLE_PIECES_SOURCE,
        items: matching.slice(offset, offset + limit).map(([key, version, upstreamPath]) => ({
          key,
          npm: `@activepieces/piece-${key}`,
          version,
          upstreamPath,
          status: "available_not_enabled" as const,
        })),
      },
    };
  });

  app.post<{ Params: { pieceKey: string } }>("/v1/connector-catalogue/:pieceKey/enablement", async (req, reply) => {
    const { pieceKey } = req.params;
    const piece = curatedPieceByKey(pieceKey);
    if (!piece) {
      const listed = AVAILABLE_PIECES.some(([key]) => key === pieceKey);
      return listed
        ? reply.status(409).send({
            error: "piece_has_no_adapter",
            detail: `'${pieceKey}' is in the catalogue but RegulAIt has no governed adapter for it yet, so it cannot be enabled (ADR-0255)`,
          })
        : reply.status(404).send({ error: "unknown_piece" });
    }
    const parsed = enablementBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: "expected { enabled: boolean, reason: string (3-500 characters) }" });
    }
    const { enabled, reason } = parsed.data;
    if (enabled && resolveDeployMode() === "air_gapped") {
      return reply.status(409).send({
        error: "piece_air_gapped",
        detail: `'${pieceKey}' calls a public SaaS API, and this deployment is air-gapped; it cannot be enabled`,
      });
    }
    // enabling widens what the deployment reaches: a settings relaxation (ADR-0180), so it takes a step-up
    if (enabled && !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { connectorPiece: pieceKey, values: { enabled: true } } })).ok) {
      return reply;
    }
    const userId = req.authCtx.userId ?? null;
    const view = await db.transaction(async (tx) => {
      // The write itself says what the state was, so two concurrent enables cannot both record "not_enabled ->
      // enabled": the insert that loses the primary-key race returns no row (and the delete that finds nothing, none).
      // A `SELECT ... FOR UPDATE` cannot serve here, because it locks nothing when the row does not exist yet.
      const changed = enabled
        ? await tx
            .insert(connectorPieceEnablements)
            .values({ pieceKey, enabledByUserId: userId }) // enabled_at is the database clock (M-075)
            .onConflictDoNothing()
            .returning({ pieceKey: connectorPieceEnablements.pieceKey })
        : await tx
            .delete(connectorPieceEnablements)
            .where(eq(connectorPieceEnablements.pieceKey, pieceKey))
            .returning({ pieceKey: connectorPieceEnablements.pieceKey });
      const to = enabled ? "enabled" : "not_enabled";
      const from = changed.length > 0 ? (enabled ? "not_enabled" : "enabled") : to;
      await tx.insert(auditLog).values({
        // bootstrap has no user identity; the nil uuid marks a non-user actor and `via` says which it was
        userId: userId ?? NIL_USER,
        objectType: "connector_piece",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          pieceKey,
          providerKind: piece.kind,
          upstream: piece.upstream,
          transition: { from, to },
          reason,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: CONNECTOR_CATALOGUE_RULE_ID,
        ruleChain: [],
        reason:
          from === to
            ? `connector catalogue piece '${pieceKey}' re-confirmed ${to}: ${reason}`
            : `connector catalogue piece '${pieceKey}' ${from} -> ${to}: ${reason}`,
      });
      return (await curatedView(tx)).find((p) => p.key === pieceKey);
    });
    return reply.send({ piece: view });
  });
}
