/**
 * ADR-0242 — THE ADMISSION-SCAN ENGINES, the stored half. (The report contract and the fail-closed decision are
 * pure, in packages/shared/src/engines/admission-scan.ts.)
 *
 * Two engines, each an ADR-0187 sidecar engine of kind `admission_scan`:
 *   - `mcpscanner` (Cisco mcp-scanner, offline static mode) scans an MCP server's manifest;
 *   - `skillscanner` (Cisco skill-scanner, core local analyzers) scans a builder skill.
 *
 * What this module owns:
 *
 *   1. `engineAdmissionFor` — the live overlay every gate consults: is the subject's engine on, and what did it
 *      say about THIS digest? With the engine on, only a `pass` for the current digest admits; no scan yet,
 *      `unknown` (an engine error, a timeout, an invalid or missing report) and `fail` all hold. With it off
 *      (the shipped default, ADR-0187 decision 3) it has no say and nothing changes.
 *   2. `withEngineMcpFindings` — the overlay folded into an MCP manifest scan, in the same shape as the vendored
 *      and reserved-name findings, so a held verdict is the existing `held` state with the existing audit.
 *   3. `recordAdmissionEngineScan` — one engine report in: interpreted (fail closed), stored as one
 *      `admission_engine_scans` row, audited, and folded into the subject's stored admission state when it is
 *      about the subject's current digest: `clean` (or `unscanned`/`grandfathered`) becomes `held` on a `fail` or
 *      `unknown`; a `held` whose ONLY findings were the engine's becomes `clean` again on a `pass`. A `refused`
 *      skill stands.
 *   4. A LATER `fail` REVOKES AN EARLIER CLEARANCE (owner question 2 of ADR-0242, built with the secure default
 *      by lane L4). An admin's `cleared` (MCP) or `admitted` (skill) decision for the current digest is re-held
 *      when the engine flags that digest and the admin had not already seen that same flag: no `fail` scan of the
 *      same digest under the same rule set was recorded at or before the clearance. A re-scan that repeats the
 *      fail the admin reviewed leaves the clearance alone; a fail from new rules (a rules upgrade moves the
 *      digest) or on a digest cleared before any engine verdict revokes it, audited as
 *      `admission-engine-clearance-revoked`. An `unknown` (an engine error) is not evidence and revokes nothing.
 *
 * Engine findings are recognisable by `where` starting `engine:` (counts and locations only, as every admission
 * finding). The status findings (`engine.<id>.pending`, `engine.<id>.unknown`) sit at the subject's hold line.
 */
import {
  and,
  auditLog,
  admissionEngineScans,
  builderAgentSkills,
  builderSkills,
  desc,
  eq,
  engines,
  isNull,
  lte,
  mcpServers,
  type Db,
} from "@regulait/db";
import {
  ADMISSION_SCAN_ENGINES,
  admissionFindingSummary,
  admissionScanEngineFor,
  engineAdmissionHold,
  interpretAdmissionScanReport,
  maxSeverity,
  severityAtLeast,
  type AdmissionScanEngineId,
  type AdmissionScanVerdict,
  type EngineAdmissionOutcome,
  type McpAdmissionFinding,
  type McpAdmissionScan,
} from "@regulait/shared";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

export type AdmissionScanSubject =
  | { kind: "mcp_server"; id: string; digest: string }
  | { kind: "builder_skill"; id: string; digest: string };

export function isEngineFinding(f: Pick<McpAdmissionFinding, "where">): boolean {
  return typeof f.where === "string" && f.where.startsWith("engine:");
}

/** the latest scan of this subject at this digest, or null */
async function latestScan(db: Db, subject: AdmissionScanSubject) {
  const col = subject.kind === "mcp_server" ? admissionEngineScans.mcpServerId : admissionEngineScans.builderSkillId;
  const [row] = await db
    .select({ verdict: admissionEngineScans.verdict, findings: admissionEngineScans.findings })
    .from(admissionEngineScans)
    .where(and(eq(col, subject.id), eq(admissionEngineScans.subjectDigest, subject.digest)))
    .orderBy(desc(admissionEngineScans.createdAt), desc(admissionEngineScans.id))
    .limit(1);
  return row ? { verdict: row.verdict as AdmissionScanVerdict, findings: row.findings as McpAdmissionFinding[] } : null;
}

/** the engine's live say on this subject at this digest (fail closed when on) */
export async function engineAdmissionFor(db: Db, subject: AdmissionScanSubject): Promise<EngineAdmissionOutcome & { engineId: AdmissionScanEngineId }> {
  const engineId = admissionScanEngineFor(subject.kind);
  const [eng] = await db.select({ enabled: engines.enabled }).from(engines).where(eq(engines.id, engineId));
  if (!eng?.enabled) return { engineId, ...engineAdmissionHold({ engineEnabled: false, scan: null }) };
  return { engineId, ...engineAdmissionHold({ engineEnabled: true, scan: await latestScan(db, subject) }) };
}

/** the findings a holding engine outcome contributes to the subject's verdict */
export function engineHoldFindings(engineId: AdmissionScanEngineId, outcome: EngineAdmissionOutcome): McpAdmissionFinding[] {
  if (!outcome.holds) return [];
  if (outcome.status === "fail" && outcome.findings.length) return [...outcome.findings];
  return [{ rule: `engine.${engineId}.${outcome.status === "fail" ? "unknown" : outcome.status}`, severity: ADMISSION_SCAN_ENGINES[engineId].holdAt, tool: "*", where: `engine:${engineId}:status`, count: 1 }];
}

/** the engine overlay joined to an MCP manifest scan, severity and hold recomputed (no-op with the engine off) */
export async function withEngineMcpFindings(db: Db, serverId: string, scan: McpAdmissionScan): Promise<McpAdmissionScan> {
  const outcome = await engineAdmissionFor(db, { kind: "mcp_server", id: serverId, digest: scan.digest });
  const extra = engineHoldFindings(outcome.engineId, outcome);
  if (extra.length === 0) return scan;
  const findings = [...scan.findings.filter((f) => !isEngineFinding(f)), ...extra];
  const severity = maxSeverity(findings);
  return { ...scan, findings, severity, holds: true };
}

/** a skill subject's engine refusal for the gates (null when the engine admits or is off) */
export async function skillEngineHold(db: Db, skillId: string, digest: string): Promise<EngineAdmissionOutcome | null> {
  const outcome = await engineAdmissionFor(db, { kind: "builder_skill", id: skillId, digest });
  return outcome.holds ? outcome : null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Did the admin see this same engine flag before clearing? True when a `fail` scan of the subject at this digest,
 * under the same rule set, was recorded at or before the clearance. (Both times come from writes in this database's
 * transactions; the clearance's is the gateway clock, so a scan within clock skew of a clearance counts as seen.)
 */
async function failSeenBeforeClearance(tx: Tx, subject: AdmissionScanSubject, rulesSha256: string | null, clearedAt: Date | null): Promise<boolean> {
  if (!clearedAt) return false;
  const col = subject.kind === "mcp_server" ? admissionEngineScans.mcpServerId : admissionEngineScans.builderSkillId;
  const [row] = await tx
    .select({ id: admissionEngineScans.id })
    .from(admissionEngineScans)
    .where(
      and(
        eq(col, subject.id),
        eq(admissionEngineScans.subjectDigest, subject.digest),
        eq(admissionEngineScans.verdict, "fail"),
        rulesSha256 === null ? isNull(admissionEngineScans.rulesSha256) : eq(admissionEngineScans.rulesSha256, rulesSha256),
        lte(admissionEngineScans.createdAt, clearedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface RecordedAdmissionScan {
  id: string;
  verdict: AdmissionScanVerdict;
  /** the subject's admission state after the scan was folded in (null: the subject is gone) */
  state: string | null;
  /** false when the scan is about a digest that is no longer the subject's current one */
  current: boolean;
  /** true when this scan revoked an admin's clearance of the current digest (a later fail) */
  revokedClearance: boolean;
}

/**
 * ONE engine report in. The report is untrusted engine output: it is parsed strictly and anything that is not a
 * completed, matching report is `unknown`, which holds.
 */
export async function recordAdmissionEngineScan(
  db: Db,
  input: { subject: AdmissionScanSubject; report: unknown; engineRunId?: string | null },
): Promise<RecordedAdmissionScan> {
  return db.transaction((tx) => recordAdmissionEngineScanTx(tx, input));
}

/**
 * The same, inside the caller's transaction (ADR-0242 L4.3: a `subject` run's end records its scan in the run's own
 * transaction). The subject row is locked FOR NO KEY UPDATE, which does not wait on the key-share lock a concurrent
 * run insert takes through its foreign key, so the run-then-subject lock order cannot deadlock with a queueing.
 */
export async function recordAdmissionEngineScanTx(
  tx: Tx,
  input: { subject: AdmissionScanSubject; report: unknown; engineRunId?: string | null },
): Promise<RecordedAdmissionScan> {
  const engineId = admissionScanEngineFor(input.subject.kind);
  const spec = ADMISSION_SCAN_ENGINES[engineId];
  const r = interpretAdmissionScanReport(input.report, { engine: engineId });
  {
    const subject = input.subject;
    const [row] = await tx
      .insert(admissionEngineScans)
      .values({
        engineId,
        mcpServerId: subject.kind === "mcp_server" ? subject.id : null,
        builderSkillId: subject.kind === "builder_skill" ? subject.id : null,
        subjectDigest: subject.digest,
        engineRunId: input.engineRunId ?? null,
        engineVersion: spec.version,
        rulesSha256: r.rulesSha256,
        verdict: r.verdict,
        findings: r.findings,
      })
      .returning({ id: admissionEngineScans.id });
    const outcome = engineAdmissionHold({ engineEnabled: true, scan: { verdict: r.verdict, findings: r.findings } });
    const extra = engineHoldFindings(engineId, outcome);

    let previous: string | null = null;
    let state: string | null = null;
    let current = false;
    let revokedClearance = false;
    let name = "";
    if (subject.kind === "mcp_server") {
      const [s] = await tx
        .select({
          name: mcpServers.name,
          state: mcpServers.admissionState,
          digest: mcpServers.admissionManifestDigest,
          findings: mcpServers.admissionFindings,
          clearedAt: mcpServers.admissionClearedAt,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, subject.id))
        .for("no key update");
      if (s) {
        name = s.name;
        previous = s.state;
        state = s.state;
        current = s.digest === subject.digest;
        if (current) {
          const base = ((s.findings as McpAdmissionFinding[] | null) ?? []).filter((f) => !isEngineFinding(f));
          const findings = [...base, ...extra];
          const baseHolds = severityAtLeast(maxSeverity(base), spec.holdAt);
          if (outcome.holds && (s.state === "clean" || s.state === "unscanned" || s.state === "grandfathered")) state = "held";
          else if (!outcome.holds && s.state === "held" && !baseHolds) state = "clean";
          else if (r.verdict === "fail" && s.state === "cleared" && !(await failSeenBeforeClearance(tx, subject, r.rulesSha256, s.clearedAt))) {
            state = "held";
            revokedClearance = true;
          }
          await tx
            .update(mcpServers)
            .set({
              admissionState: state as typeof s.state,
              admissionFindings: findings,
              admissionSeverity: maxSeverity(findings),
              // a revoked clearance is cleared out with it, as a drift re-hold does (mcp-admission.ts)
              ...(revokedClearance ? { admissionClearedBy: null, admissionClearedAt: null, admissionClearReason: null } : {}),
            })
            .where(eq(mcpServers.id, subject.id));
        }
      }
    } else {
      const [s] = await tx
        .select({
          name: builderSkills.name,
          state: builderSkills.admissionState,
          digest: builderSkills.contentDigest,
          findings: builderSkills.admissionFindings,
          admittedAt: builderSkills.admittedAt,
          admittedDigest: builderSkills.admittedDigest,
        })
        .from(builderSkills)
        .where(eq(builderSkills.id, subject.id))
        .for("no key update");
      if (s) {
        name = s.name;
        previous = s.state;
        state = s.state;
        current = s.digest === subject.digest;
        if (current) {
          const base = ((s.findings as McpAdmissionFinding[] | null) ?? []).filter((f) => !isEngineFinding(f));
          const findings = [...base, ...extra];
          const baseHolds = severityAtLeast(maxSeverity(base), spec.holdAt);
          if (outcome.holds && (s.state === "clean" || s.state === "unscanned")) state = "held";
          else if (!outcome.holds && s.state === "held" && !baseHolds) state = "clean";
          else if (
            r.verdict === "fail" &&
            s.state === "admitted" &&
            s.admittedDigest === subject.digest &&
            !(await failSeenBeforeClearance(tx, subject, r.rulesSha256, s.admittedAt))
          ) {
            state = "held";
            revokedClearance = true;
          }
          await tx
            .update(builderSkills)
            .set({
              admissionState: state as typeof s.state,
              admissionFindings: findings,
              admissionSeverity: maxSeverity(findings),
              ...(revokedClearance ? { admittedBy: null, admittedAt: null, admitReason: null, admittedDigest: null } : {}),
            })
            .where(eq(builderSkills.id, subject.id));
          // the pinned copies of the revoked digest lose their admission with it: the run-time loader holds them
          if (revokedClearance) {
            await tx
              .update(builderAgentSkills)
              .set({ snapshotAdmissionState: "held" })
              .where(
                and(
                  eq(builderAgentSkills.skillId, subject.id),
                  eq(builderAgentSkills.snapshotDigest, subject.digest),
                  eq(builderAgentSkills.snapshotAdmissionState, "admitted"),
                ),
              );
          }
        }
      }
    }

    await tx.insert(auditLog).values({
      userId: NIL_USER,
      serverId: subject.kind === "mcp_server" && state !== null ? subject.id : null,
      objectType: subject.kind,
      objectId: subject.id,
      detail: {
        phase: "admission-engine-scan",
        engineId,
        engineVersion: spec.version,
        engineRunId: input.engineRunId ?? null,
        verdict: r.verdict,
        digest: subject.digest,
        currentDigest: current,
        rulesSha256: r.rulesSha256,
        previousState: previous,
        admissionState: state,
        revokedClearance,
        // COUNTS AND LOCATIONS ONLY, as every admission finding
        findings: r.findings,
      },
      effect: outcome.holds ? "deny" : "allow",
      ruleId: revokedClearance ? "admission-engine-clearance-revoked" : outcome.holds ? "admission-engine-held" : "admission-engine-passed",
      ruleChain: [],
      reason:
        `${engineId} ${spec.version} ${r.verdict === "pass" ? "passed" : r.verdict === "fail" ? "flagged" : "could not scan (fail closed)"} ` +
        `${subject.kind === "mcp_server" ? "MCP server" : "skill"} '${name || subject.id}' at digest ${subject.digest.slice(0, 12)}` +
        (r.verdict === "fail" ? ` — ${admissionFindingSummary(r.findings)}` : r.verdict === "unknown" ? ` — ${r.reason}` : "") +
        (current ? (state !== previous ? ` (${previous} → ${state})` : ` (stays ${state})`) : " (not its current digest: recorded only)") +
        (revokedClearance ? "; the admin's earlier clearance of this digest is revoked: the engine's flag is new since it was given" : ""),
    });
    return { id: row!.id, verdict: r.verdict, state, current, revokedClearance };
  }
}
