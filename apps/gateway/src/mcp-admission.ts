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
  manifestDigest,
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
import {
  quarantineDetail,
  recordSighting,
  registerReleaseAgeRoutes,
  REGISTRATION_RELEASE,
  serverReleaseStatus,
} from "./release-age.js";
import { registerSkillAdmissionRoutes } from "./skill-admission.js";

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

/**
 * ADR-0175 A5 — the release-age cooldown's refusal. A SUBCLASS of the held
 * error on purpose: every caller already maps a held server to its ordinary
 * pre-hijack 403 / "contributes zero tools" handling, and a quarantined server
 * must be treated exactly the same way, with no new branch to forget.
 */
export class McpReleaseQuarantinedError extends McpAdmissionHeldError {
  constructor(serverId: string, state: McpAdmissionState, detail: string, readonly readyAt: string | null) {
    super(serverId, state, [], detail);
    this.name = "McpReleaseQuarantinedError";
  }
}

/**
 * ADR-0175 A5 — the cooldown half of the connect gate. A server is in
 * quarantine while the release it is on (its registration, its first
 * manifest, or a changed manifest — see `releaseSeenAt`) is younger than
 * `min_release_age_days`, unless an admin overrode the cooldown for it at that
 * release. Audited and thrown with nothing having left the box, like a hold.
 */
async function assertReleaseAged(db: Db, serverId: string, minDays: number): Promise<void> {
  const [row] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      admissionState: mcpServers.admissionState,
      releaseDigest: mcpServers.releaseDigest,
      releaseSeenAt: mcpServers.releaseSeenAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!row) return;
  const status = await serverReleaseStatus(db, row, minDays);
  if (!status.quarantined) return;
  const detail = quarantineDetail(`MCP server '${row.name}'`, minDays, status);
  await db.insert(auditLog).values({
    userId: NIL_USER,
    serverId,
    objectType: "mcp_server",
    objectId: serverId,
    detail: {
      phase: "connect",
      release: row.releaseDigest ?? REGISTRATION_RELEASE,
      firstSeenAt: row.releaseSeenAt.toISOString(),
      ageDays: status.ageDays,
      minReleaseAgeDays: minDays,
      readyAt: status.readyAt,
    },
    effect: "deny",
    ruleId: "mcp-release-quarantined",
    ruleChain: [],
    reason: detail,
  });
  throw new McpReleaseQuarantinedError(serverId, row.admissionState, detail, status.readyAt);
}

/**
 * ADR-0175 A5 — what a sync observed, for the cooldown. Only runs while the
 * cooldown is on, so `0` stays byte-identical.
 *
 *  - same digest as recorded: nothing changes;
 *  - FIRST manifest of a server: it is the release that was registered, so it
 *    keeps the registration's age (otherwise every new server would wait twice);
 *  - a CHANGED manifest: a new release, aged from the first time this
 *    deployment saw that exact digest (anywhere), and audited.
 */
async function observeRelease(
  db: Db,
  serverId: string,
  digest: string,
  minDays: number,
  trigger: McpAdmissionTrigger,
): Promise<{ quarantined: boolean; detail: string; readyAt: string | null; state: McpAdmissionState } | null> {
  const [row] = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      admissionState: mcpServers.admissionState,
      releaseDigest: mcpServers.releaseDigest,
      releaseSeenAt: mcpServers.releaseSeenAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!row) return null;
  let next = row;
  if (row.releaseDigest === null) {
    await recordSighting(db, "mcp_manifest", digest);
    await db.update(mcpServers).set({ releaseDigest: digest }).where(eq(mcpServers.id, serverId));
    next = { ...row, releaseDigest: digest };
  } else if (row.releaseDigest !== digest) {
    const seen = await recordSighting(db, "mcp_manifest", digest);
    await db.update(mcpServers).set({ releaseDigest: digest, releaseSeenAt: seen }).where(eq(mcpServers.id, serverId));
    next = { ...row, releaseDigest: digest, releaseSeenAt: seen };
    const status = await serverReleaseStatus(db, next, minDays);
    await db.insert(auditLog).values({
      userId: NIL_USER,
      serverId,
      objectType: "mcp_server",
      objectId: serverId,
      detail: {
        phase: "manifest-release",
        trigger,
        previousDigest: row.releaseDigest,
        digest,
        firstSeenAt: seen.toISOString(),
        minReleaseAgeDays: minDays,
        quarantined: status.quarantined,
        readyAt: status.readyAt,
      },
      effect: status.quarantined ? "deny" : "allow",
      ruleId: "mcp-release-changed",
      ruleChain: [],
      reason: status.quarantined
        ? `MCP server '${row.name}' changed its manifest: ${quarantineDetail("the new manifest", minDays, status)}`
        : `MCP server '${row.name}' changed its manifest to one this deployment has known for ${status.ageDays} day(s) — past the cooldown.`,
    });
  }
  const status = await serverReleaseStatus(db, next, minDays);
  return {
    quarantined: status.quarantined,
    detail: quarantineDetail(`MCP server '${row.name}'`, minDays, status),
    readyAt: status.readyAt,
    state: row.admissionState,
  };
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
  const org = await loadOrgSettings(db);
  const mode = org.mcpAdmissionMode;
  if (mode !== "enforce") {
    // ADR-0175 A5: the cooldown is its own knob and applies in every mode
    if (org.minReleaseAgeDays > 0) await assertReleaseAged(db, serverId, org.minReleaseAgeDays);
    return;
  }
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
  if (row.admissionState !== "held") {
    if (org.minReleaseAgeDays > 0) await assertReleaseAged(db, serverId, org.minReleaseAgeDays);
    return;
  }
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

/** ADR-0100: WHAT BROUGHT THE MANIFEST IN. `sync` is a live manifest sync — a
 * human or an agent called the server and the gateway fetched its tools on the
 * way. `rescan` is the scheduled admission re-scan sweep, which fetches a
 * manifest nobody asked for. The value is a LABEL on the audit row and nothing
 * else: same scanner, same threshold, same state rule, same columns. It exists
 * so an operator reading `mcp-admission-held` can tell "held by a call" from
 * "held by the sweep" from the row itself rather than by correlating
 * timestamps against the scheduler ledger. */
export type McpAdmissionTrigger = "sync" | "rescan";

/**
 * THE SCAN, at manifest-sync time. Returns the verdict the caller must act on.
 *
 * `off` short-circuits before the scan is even computed — no CPU, no write, no
 * audit row, no column touched. That is what makes the default byte-identical
 * rather than merely "equivalent in effect".
 *
 * ADR-0100 drives this SAME function from the scheduled re-scan sweep. There is
 * deliberately no second "is this manifest admissible" implementation and no
 * second threshold: a sweep with its own copy of this logic would drift from
 * the live path, and the drift would be discovered by whoever relied on the one
 * that was wrong.
 */
export async function recordManifestScan(
  db: Db,
  serverId: string,
  tools: readonly ScannableTool[],
  trigger: McpAdmissionTrigger = "sync",
): Promise<{ mode: McpAdmissionMode; scan: McpAdmissionScan | null; state: McpAdmissionState | null }> {
  const result = await scanAndPersistManifest(db, serverId, tools, trigger);
  // ADR-0175 A5 — the cooldown sees the manifest too (only while it is on). A
  // manifest that puts the server into quarantine is refused like a hold: not
  // stored, no tool from it returned, the call that fetched it refused. A
  // manifest the admission gate already refused under enforce is that gate's
  // refusal, not this one's.
  const minDays = (await loadOrgSettings(db)).minReleaseAgeDays;
  if (minDays > 0) {
    const rel = await observeRelease(db, serverId, manifestDigest(tools), minDays, trigger);
    const alreadyRefused = result.mode === "enforce" && result.state === "held";
    if (rel?.quarantined && !alreadyRefused) {
      throw new McpReleaseQuarantinedError(serverId, result.state ?? rel.state, rel.detail, rel.readyAt);
    }
  }
  return result;
}

async function scanAndPersistManifest(
  db: Db,
  serverId: string,
  tools: readonly ScannableTool[],
  trigger: McpAdmissionTrigger,
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
        // ADR-0100: a label, not a behaviour — see McpAdmissionTrigger
        trigger,
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
        (trigger === "rescan"
          ? " (observed by the ADR-0100 scheduled admission re-scan, not by a call)"
          : "") +
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
  const org = await loadOrgSettings(db);
  if (org.mcpAdmissionMode !== "enforce" && org.minReleaseAgeDays <= 0) return false;
  const [row] = await db
    .select({
      id: mcpServers.id,
      admissionState: mcpServers.admissionState,
      releaseDigest: mcpServers.releaseDigest,
      releaseSeenAt: mcpServers.releaseSeenAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, serverId));
  if (!row) return false;
  if (org.mcpAdmissionMode === "enforce" && row.admissionState === "held") return true;
  // ADR-0175 A5: a server in release-age quarantine contributes no tools either
  if (org.minReleaseAgeDays > 0) return (await serverReleaseStatus(db, row, org.minReleaseAgeDays)).quarantined;
  return false;
}

// ---------------------------------------------------------------------------
// The admin review surface
// ---------------------------------------------------------------------------

export function registerMcpAdmissionRoutes(app: FastifyInstance, db: Db) {
  // ADR-0175: the builder-skill review queue (A6) and the release-age
  // cooldown's admin surface (A5) live beside the MCP review queue — one
  // admission review page, one set of admin-only routes.
  registerSkillAdmissionRoutes(app, db);
  registerReleaseAgeRoutes(app, db);
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
