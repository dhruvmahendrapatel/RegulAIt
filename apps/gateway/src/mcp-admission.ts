/**
 * ADR-0097 — MCP ADMISSION SCANNING: the enforcement half.
 *
 * `packages/shared/src/mcp-admission.ts` owns the pure scan (deterministic,
 * local, no network, no model, air-gap safe per ADR-0062). This module owns the
 * three things that touch the database and the request path:
 *
 *   1. `assertAdmitted(db, serverId)` — THE GATE. Called at the top of
 *      `connectUpstream`, which is the single funnel every one of the four MCP
 *      connect paths goes through, and called BEFORE `guardedMcpConnect`, which
 *      is the only thing in this codebase that opens an outbound MCP socket. A
 *      held server is therefore refused with provably zero outbound attempt —
 *      the same standard ADR-0043's egress guard holds itself to, and the same
 *      way its tests prove it.
 *
 *   2. `recordManifestScan(db, serverId, tools)` — THE SCAN, run inside
 *      `syncUpstreamTools` BEFORE the manifest is upserted. Persisting the
 *      verdict is what makes the state meaningful; scanning before the upsert
 *      is what keeps a poisoned description out of `mcp_tools` entirely, so it
 *      can never be read back by a discovery surface even once.
 *
 *   3. The admin review surface — list what is held, and clear one with a
 *      reason, audited. Nothing auto-clears.
 *
 * THE POSTURE, in one place. `org_settings.mcp_admission_mode`:
 *   - `off`   (SHIPPED DEFAULT) — no scan runs at all. Byte-identical to
 *              pre-ADR-0097. Asserted by a test, not asserted in prose.
 *   - `log`   — every sync is scanned and the verdict/findings land on the row.
 *              NOTHING is ever refused. A server can sit in state `held` and
 *              keep serving: `held` is the SCAN VERDICT, and whether it holds
 *              anything is this knob's business. That is what "observe before
 *              you enforce" has to mean if flipping the switch is to be an
 *              informed act.
 *   - `enforce` — a `held` server is refused before any connect and contributes
 *              nothing to tool discovery, until an admin clears it.
 *
 * DRIFT RE-OPENS THE GATE. A `cleared` server's clearance is pinned to the
 * manifest digest it was granted for. Every sync re-scans and re-adjudicates;
 * a changed manifest that scans dirty returns to `held` even though it was
 * cleared five minutes ago. This is the half that actually matters, because the
 * realistic compromise is not a server that was always malicious but one that
 * turned — and a gate that only ever ran once would have nothing to say about
 * it.
 */

import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  desc,
  eq,
  mcpServers,
  ne,
  type Db,
} from "@regulait/db";
import {
  admissionFindingSummary,
  clearMcpAdmissionSchema,
  mcpAdmissionRuleIds,
  MCP_ADMISSION_HOLD_AT,
  MCP_ADMISSION_SCANNER_VERSION,
  nextAdmissionState,
  scanMcpManifest,
  type McpAdmissionFinding,
  type McpAdmissionMode,
  type McpAdmissionScan,
  type McpAdmissionState,
  type ScannableTool,
} from "@regulait/shared";
import { z } from "zod";
import { loadOrgSettings } from "./org-settings.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** Thrown by the gate and by a sync that just went dirty under `enforce`. The
 * MCP proxy route maps it to its ordinary pre-hijack 403 (the exact shape
 * ADR-0043's `McpEgressBlockedError` gets); the governed-tool-call and
 * node-tool paths let it ride their existing upstream-failure handling, which
 * means a held server contributes zero tools rather than authority. */
export class McpAdmissionHeldError extends Error {
  constructor(
    readonly serverId: string,
    readonly state: McpAdmissionState,
    readonly findings: readonly McpAdmissionFinding[],
    readonly detail: string,
  ) {
    super(detail);
    this.name = "McpAdmissionHeldError";
  }
}

export async function loadAdmissionMode(db: Db): Promise<McpAdmissionMode> {
  const org = await loadOrgSettings(db);
  return org.mcpAdmissionMode;
}

/**
 * THE GATE. Re-read from the row every time — a verdict recorded at the last
 * sync is not a fact about this request, the knob can flip between calls, and a
 * row written directly into Postgres must be adjudicated too (the ADR-0043
 * lesson: the guard cannot be dodged by a row the API never saw).
 *
 * Returns silently when the call may proceed. Throws `McpAdmissionHeldError`
 * with NOTHING having left the box when it may not.
 */
export async function assertAdmitted(db: Db, serverId: string): Promise<void> {
  const mode = await loadAdmissionMode(db);
  if (mode !== "enforce") return;
  const [row] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      admissionState: mcpServers.admissionState,
      admissionFindings: mcpServers.admissionFindings,
      admissionSeverity: mcpServers.admissionSeverity,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!row) return; // an unknown server is the caller's own 404, not ours
  if (row.admissionState !== "held") return;
  const findings = (row.admissionFindings as McpAdmissionFinding[] | null) ?? [];
  const detail =
    `MCP server '${row.name}' is HELD by admission scanning (severity ` +
    `${row.admissionSeverity ?? "unknown"}, hold threshold ${MCP_ADMISSION_HOLD_AT}): ` +
    `${admissionFindingSummary(findings)}. Its tool manifest carries model-directed ` +
    `content. An admin must review the findings and clear the server with a reason ` +
    `before it can be reached again.`;
  await db.insert(auditLog).values({
    userId: NIL_USER,
    serverId,
    objectType: "mcp_server",
    objectId: serverId,
    detail: {
      phase: "connect",
      admissionState: row.admissionState,
      severity: row.admissionSeverity,
      findingCount: findings.length,
      scannerVersion: MCP_ADMISSION_SCANNER_VERSION,
    },
    effect: "deny",
    ruleId: "mcp-admission-held",
    ruleChain: [],
    reason: detail,
  });
  throw new McpAdmissionHeldError(serverId, row.admissionState, findings, detail);
}

/**
 * THE SCAN, at manifest-sync time. Returns the verdict the caller must act on.
 *
 * `off` short-circuits before the scan is even computed — no CPU, no write, no
 * audit row, no column touched. That is what makes the default byte-identical
 * rather than merely "equivalent in effect".
 */
export async function recordManifestScan(
  db: Db,
  serverId: string,
  tools: readonly ScannableTool[],
): Promise<{ mode: McpAdmissionMode; scan: McpAdmissionScan | null; state: McpAdmissionState | null }> {
  const mode = await loadAdmissionMode(db);
  if (mode === "off") return { mode, scan: null, state: null };

  const [before] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      admissionState: mcpServers.admissionState,
      admissionManifestDigest: mcpServers.admissionManifestDigest,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!before) return { mode, scan: null, state: null };

  const scan = scanMcpManifest(tools);
  const state = nextAdmissionState({
    scan,
    previousState: before.admissionState,
    // a clearance is only ever honoured for the digest it was granted for
    clearedDigest: before.admissionState === "cleared" ? before.admissionManifestDigest : null,
  });

  // DRIFT: a server that was clean/cleared and now holds is the event worth
  // filing. Recorded whether the mode enforces or only logs, because the whole
  // point of `log` is that an admin can see what enforcing WOULD have done.
  const reopened =
    state === "held" && (before.admissionState === "cleared" || before.admissionState === "clean");

  await db
    .update(mcpServers)
    .set({
      admissionState: state,
      admissionScannedAt: new Date(),
      admissionFindings: scan.findings,
      admissionSeverity: scan.severity,
      admissionScannerVersion: scan.scannerVersion,
      admissionManifestDigest: scan.digest,
      // a re-held server's stale clearance is cleared out with it — leaving
      // "cleared by Alice, reason: reviewed" beside state `held` would read as
      // an approval that is still in force
      ...(state === "held"
        ? { admissionClearedBy: null, admissionClearedAt: null, admissionClearReason: null }
        : {}),
    })
    .where(eq(mcpServers.id, serverId));

  if (state === "held" || reopened) {
    await db.insert(auditLog).values({
      userId: NIL_USER,
      serverId,
      objectType: "mcp_server",
      objectId: serverId,
      detail: {
        phase: "manifest-scan",
        mode,
        previousState: before.admissionState,
        admissionState: state,
        severity: scan.severity,
        digest: scan.digest,
        driftReopened: reopened,
        scannerVersion: scan.scannerVersion,
        toolCount: scan.toolCount,
        unitCount: scan.unitCount,
        // COUNTS AND LOCATIONS ONLY — the ADR-0042 contract, verbatim
        findings: scan.findings,
      },
      // `log` mode records the finding but denies nothing, so its audit row is
      // an `allow` — an audit trail that recorded a deny that never happened
      // would be a lie about what the gateway did.
      effect: mode === "enforce" ? "deny" : "allow",
      ruleId: reopened ? "mcp-admission-drift-reheld" : "mcp-admission-held",
      ruleChain: [],
      reason:
        (reopened
          ? `MCP server '${before.name}' RE-HELD by admission scanning: its manifest changed ` +
            `(was ${before.admissionState}) and the new manifest scans dirty — `
          : `MCP server '${before.name}' held by admission scanning — `) +
        `${admissionFindingSummary(scan.findings)}` +
        (mode === "enforce"
          ? ". Refused until an admin clears it."
          : ". mcp_admission_mode='log' — RECORDED ONLY, nothing was refused."),
    });
  }

  return { mode, scan, state };
}

/** The registration path's explicit write. The migration's DEFAULT exists for
 * rows that predate the scanner; a row this code creates says what it means. */
export const REGISTRATION_ADMISSION_STATE: McpAdmissionState = "unscanned";

/** Does this server contribute tools to a discovery surface right now? A held
 * server under `enforce` contributes NOTHING — not through the MCP proxy's
 * tools/list (which cannot even connect), not through a worker node's declared
 * tools, and not through the entitlement-preview read that never connects at
 * all and would otherwise still hand back the last synced inventory. */
export async function admissionHidesTools(db: Db, serverId: string): Promise<boolean> {
  const mode = await loadAdmissionMode(db);
  if (mode !== "enforce") return false;
  const [row] = await db
    .select({ admissionState: mcpServers.admissionState })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  return row?.admissionState === "held";
}

// ---------------------------------------------------------------------------
// The admin review surface
// ---------------------------------------------------------------------------

export function registerMcpAdmissionRoutes(app: FastifyInstance, db: Db) {
  /**
   * THE REVIEW QUEUE. Admin-only via the default gate (deliberately absent
   * from NON_ADMIN_ROUTES), like every other MCP registry write. Returns every
   * server whose admission state is not `clean`, newest scan first, with the
   * counts-only findings and the ruleset that produced them — so an operator
   * can see WHAT is held, WHY, and under which scanner version, without
   * needing a second tool.
   */
  app.get("/v1/mcp/admission", async () => {
    const mode = await loadAdmissionMode(db);
    const rows = await db
      .select({
        id: mcpServers.id,
        name: mcpServers.name,
        url: mcpServers.url,
        admissionState: mcpServers.admissionState,
        admissionSeverity: mcpServers.admissionSeverity,
        admissionScannedAt: mcpServers.admissionScannedAt,
        admissionFindings: mcpServers.admissionFindings,
        admissionScannerVersion: mcpServers.admissionScannerVersion,
        admissionManifestDigest: mcpServers.admissionManifestDigest,
        admissionClearedBy: mcpServers.admissionClearedBy,
        admissionClearedAt: mcpServers.admissionClearedAt,
        admissionClearReason: mcpServers.admissionClearReason,
      })
      .from(mcpServers)
      .where(ne(mcpServers.admissionState, "clean"))
      .orderBy(desc(mcpServers.admissionScannedAt));
    return {
      mode,
      holdAt: MCP_ADMISSION_HOLD_AT,
      scannerVersion: MCP_ADMISSION_SCANNER_VERSION,
      rules: mcpAdmissionRuleIds(),
      servers: rows,
      // stated on the surface, not only in the ADR: in 'log' the states below
      // are recorded verdicts and nothing is being refused
      enforcing: mode === "enforce",
    };
  });

  /**
   * THE CLEAR. Admin-only, REASON REQUIRED, audited, and it clears exactly one
   * server against exactly the manifest digest that was scanned — so the
   * clearance cannot outlive the thing it was granted for. There is no bulk
   * clear and no expiry: nothing auto-clears, in either direction.
   */
  app.post("/v1/servers/:serverId/admission/clear", async (req, reply) => {
    const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params);
    const body = clearMcpAdmissionSchema.parse(req.body);
    const [before] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!before) return reply.status(404).send({ error: "unknown_server" });
    if (before.admissionState !== "held") {
      return reply.status(409).send({
        error: "not_held",
        detail:
          `MCP server '${before.name}' is in admission state '${before.admissionState}', not 'held' — ` +
          `there is nothing to clear. Clearing is only ever an override of a scan verdict.`,
      });
    }
    const findings = (before.admissionFindings as McpAdmissionFinding[] | null) ?? [];
    const [row] = await db
      .update(mcpServers)
      .set({
        admissionState: "cleared",
        admissionClearedBy: req.authCtx.userId ?? null,
        admissionClearedAt: new Date(),
        admissionClearReason: body.reason,
      })
      .where(and(eq(mcpServers.id, serverId), eq(mcpServers.admissionState, "held")))
      .returning();
    if (!row) return reply.status(409).send({ error: "not_held" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      serverId,
      objectType: "mcp_server",
      objectId: serverId,
      detail: {
        phase: "admission-clear",
        via: req.authCtx.via,
        previousState: before.admissionState,
        severity: before.admissionSeverity,
        digest: before.admissionManifestDigest,
        scannerVersion: before.admissionScannerVersion,
        findings,
        reason: body.reason,
      },
      effect: "allow",
      ruleId: "mcp-admission-cleared",
      ruleChain: [],
      reason:
        `MCP server '${before.name}' admitted despite admission findings ` +
        `[${admissionFindingSummary(findings)}] — reason: ${body.reason}. The clearance is pinned ` +
        `to manifest digest ${before.admissionManifestDigest ?? "unknown"}; a changed manifest is ` +
        `re-scanned and can re-hold the server.`,
    });
    return reply.send(row);
  });
}
