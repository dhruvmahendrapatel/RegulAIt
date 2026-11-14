/**
 * ADR-0242 phase 2 (lane L4, amendment L4.3) — THE ADMISSION-SCAN RUNS: the `subject` engine target.
 *
 * The gateway's own admission gate starts these runs (trigger `admission`), never a person: POST /v1/engine-runs
 * refuses an admission-scan engine. A run scans one subject at one digest:
 *   - `mcpscanner` an MCP server's manifest (the canonical tool list, captured ENCRYPTED when the run is queued,
 *     because a held manifest is never stored in `mcp_tools`; cleared at the run's end);
 *   - `skillscanner` a builder skill (its SKILL.md, built by the gateway from the stored name and body, or from a
 *     pinned copy, whichever carries the run's digest).
 *
 * What this module owns:
 *   1. `enqueueAdmissionScanRun` — queue one run for a subject's digest when its engine is ON (a no-op when off, the
 *      shipped default). One live run per engine, subject and digest (a partial unique index); a subject that
 *      already has a decisive scan (`pass` or `fail`) at this digest under the shipped rule set is not queued again.
 *      No data key for an MCP snapshot: nothing is queued, the refusal is audited and the subject stays held (fail
 *      closed: with the engine on, only a pass admits).
 *   2. `subjectInputTx` — the run's one input file, built by the gateway from its own records and checked against
 *      the run's digest; the lease and the task start both call it, and a refusal ends the run `not_run`.
 *   3. `recordSubjectRunEndTx` — at the run's end, in the same transaction, the engine's report (or `unknown` when
 *      the engine ran and reported nothing usable) is recorded through `recordAdmissionEngineScanTx`.
 *
 * This module imports nothing from engine-runs.ts (that module imports this one); the data key reaches it through
 * `setAdmissionScanRuntime`, which `setEngineRuntime` calls.
 */
import { createHash } from "node:crypto";
import {
  and,
  auditLog,
  admissionEngineScans,
  builderAgentSkills,
  builderSkills,
  desc,
  engineRuns,
  engines,
  eq,
  inArray,
  mcpServers,
  orgSettings,
  ORG_SETTINGS_ID,
  type Db,
  type EngineRunRow,
} from "@regulait/db";
import {
  ADMISSION_SCAN_ENGINES,
  admissionScanEngineFor,
  ENGINE_QUEUE_TTL_SECONDS,
  ENGINE_ROW_LIMITS,
  skillPromptSection,
  type EngineTerminalRunStatus,
} from "@regulait/shared";
import { recordAdmissionEngineScanTx, type AdmissionScanSubject } from "./admission-engine-scans.js";
import { databaseWallNow } from "./db-clock.js";
import { decryptSecret, encryptSecret } from "./secrets.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/**
 * the placement sensitivity of an admission scan, which belongs to no project. `confidential`: its input is a
 * customer's own skill or a third-party manifest, never regulated personal data, and ADR-0242 §6.1 places the task
 * in the executor's gVisor sandbox (L2), which is the `confidential` floor's shipped class. The org's floors still
 * decide the class, so an admin who raises the `confidential` floor raises admission scans with it.
 */
export const ADMISSION_SCAN_SENSITIVITY = "confidential" as const;

/** the one input file each engine's driver reads (engines/<id>/scan.py) */
export const ADMISSION_SCAN_INPUT_FILE = { mcpscanner: "tools.json", skillscanner: "SKILL.md" } as const;

let dataKey: string | undefined;
/** set by `setEngineRuntime` (engine-runs.ts): the data key the MCP manifest snapshot is encrypted under */
export function setAdmissionScanRuntime(opts: { dataKey?: string | undefined }): void {
  dataKey = opts.dataKey;
}

const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type EnqueueOutcome =
  | { kind: "queued"; runId: string }
  | { kind: "duplicate" }
  | { kind: "engine_off" }
  | { kind: "already_scanned" }
  | { kind: "refused"; code: "no_data_key" | "input_mismatch" | "no_input" };

/**
 * Queue an admission-scan run for `subject` at its digest. `toolsCanonicalJson` (an MCP subject only) is
 * `manifestCanonicalJson(tools)`, whose sha256 is the manifest digest; it is checked here.
 */
export async function enqueueAdmissionScanRun(
  db: Db,
  subject: AdmissionScanSubject,
  input: { toolsCanonicalJson?: string } = {},
): Promise<EnqueueOutcome> {
  const engineId = admissionScanEngineFor(subject.kind);
  const spec = ADMISSION_SCAN_ENGINES[engineId];
  // the cheap, lock-free check first: with the engine off (the default) nothing else happens at all
  const [probe] = await db.select({ enabled: engines.enabled }).from(engines).where(eq(engines.id, engineId));
  if (!probe?.enabled) return { kind: "engine_off" };

  let ciphertext: string | null = null;
  if (subject.kind === "mcp_server") {
    const json = input.toolsCanonicalJson;
    const refusal: "no_input" | "input_mismatch" | "no_data_key" | null =
      json === undefined ? "no_input" : sha256Hex(json) !== subject.digest ? "input_mismatch" : !dataKey ? "no_data_key" : null;
    if (refusal) {
      await db.insert(auditLog).values({
        userId: NIL_USER,
        serverId: subject.id,
        objectType: "mcp_server",
        objectId: subject.id,
        detail: { phase: "admission-scan-queue", engineId, digest: subject.digest, code: refusal },
        effect: "deny",
        ruleId: "admission-scan-not-queued",
        ruleChain: [],
        reason:
          `no ${engineId} scan was queued for MCP server ${subject.id} at digest ${subject.digest.slice(0, 12)} (${refusal}); ` +
          "the server stays held until the engine passes this digest",
      });
      return { kind: "refused", code: refusal };
    }
    ciphertext = encryptSecret(dataKey!, json!);
  }

  return db.transaction(async (tx) => {
    // lock order as createEngineRun: org settings, then the engine row, both FOR SHARE
    const [org] = await tx.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID)).for("share");
    const [engine] = await tx.select().from(engines).where(eq(engines.id, engineId)).for("share");
    if (!engine?.enabled) return { kind: "engine_off" as const };
    if (await decisiveScanExists(tx, subject, spec.rulesSha256)) return { kind: "already_scanned" as const };
    const now = await databaseWallNow(tx);
    const maxMinutes = org?.engineMaxRunTimeoutMinutes ?? 30;
    const timeoutSeconds = Math.max(ENGINE_ROW_LIMITS.timeoutSeconds.min, Math.min(engine.timeoutSeconds, maxMinutes * 60));
    const [row] = await tx
      .insert(engineRuns)
      .values({
        engineId,
        engineVersion: engine.version,
        status: "queued",
        trigger: "admission",
        runAsUserId: null,
        projectId: null,
        targetKind: "subject",
        targetMcpServerId: subject.kind === "mcp_server" ? subject.id : null,
        targetBuilderSkillId: subject.kind === "builder_skill" ? subject.id : null,
        targetSubjectDigest: subject.digest,
        targetSubjectInputCiphertext: ciphertext,
        config: { sets: ["scan"], params: {} },
        configHash: sha256Hex(JSON.stringify({ engineId, subject: subject.kind, digest: subject.digest })),
        trials: 1,
        // no model access: the smallest budget the row allows (the CHECK needs > 0); nothing is ever spent
        budgetUsd: ENGINE_ROW_LIMITS.maxBudgetUsd.min,
        timeoutSeconds,
        queueExpiresAt: new Date(now.getTime() + ENGINE_QUEUE_TTL_SECONDS * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: engineRuns.id });
    if (!row) return { kind: "duplicate" as const };
    await tx.insert(auditLog).values({
      userId: NIL_USER,
      serverId: subject.kind === "mcp_server" ? subject.id : null,
      objectType: "engine_run",
      objectId: row.id,
      detail: { phase: "admission-scan-queue", engineId, target: { kind: subject.kind, id: subject.id, digest: subject.digest } },
      effect: "allow",
      ruleId: "engine-run-created",
      ruleChain: [],
      reason: `${engineId} admission scan queued for ${subject.kind === "mcp_server" ? "MCP server" : "skill"} ${subject.id} at digest ${subject.digest.slice(0, 12)}`,
    });
    return { kind: "queued" as const, runId: row.id };
  });
}

/** is this admission-scan engine on? (the sweeps ask once per pass, not once per subject) */
export async function admissionScanEngineOn(db: Db, engineId: "mcpscanner" | "skillscanner"): Promise<boolean> {
  const [row] = await db.select({ enabled: engines.enabled }).from(engines).where(eq(engines.id, engineId));
  return row?.enabled === true;
}

/** a pass or fail of this subject at this digest under the shipped rule set: scanning again would say the same */
async function decisiveScanExists(tx: Exec, subject: AdmissionScanSubject, rulesSha256: string): Promise<boolean> {
  const col = subject.kind === "mcp_server" ? admissionEngineScans.mcpServerId : admissionEngineScans.builderSkillId;
  const [row] = await tx
    .select({ id: admissionEngineScans.id })
    .from(admissionEngineScans)
    .where(
      and(
        eq(col, subject.id),
        eq(admissionEngineScans.subjectDigest, subject.digest),
        eq(admissionEngineScans.rulesSha256, rulesSha256),
        inArray(admissionEngineScans.verdict, ["pass", "fail"]),
      ),
    )
    .orderBy(desc(admissionEngineScans.createdAt))
    .limit(1);
  return row !== undefined;
}

/** the subject a `subject` run names (null: its subject was deleted and the foreign key nulled) */
export function subjectOfRun(run: Pick<EngineRunRow, "targetMcpServerId" | "targetBuilderSkillId" | "targetSubjectDigest">): AdmissionScanSubject | null {
  if (!run.targetSubjectDigest) return null;
  if (run.targetMcpServerId) return { kind: "mcp_server", id: run.targetMcpServerId, digest: run.targetSubjectDigest };
  if (run.targetBuilderSkillId) return { kind: "builder_skill", id: run.targetBuilderSkillId, digest: run.targetSubjectDigest };
  return null;
}

export type SubjectInput = { ok: true; file: string; bytes: Buffer; sha256: string } | { ok: false; code: "subject_gone" | "subject_superseded" | "subject_input_gone" };

/**
 * The run's one input file, built from the gateway's own records and checked against the run's digest. A subject
 * whose digest is no longer current (nor, for a skill, a pinned copy's) is superseded: scanning it decides nothing.
 */
export async function subjectInputTx(tx: Exec, run: EngineRunRow): Promise<SubjectInput> {
  const subject = subjectOfRun(run);
  if (!subject) return { ok: false, code: "subject_gone" };
  if (subject.kind === "mcp_server") {
    const [s] = await tx.select({ digest: mcpServers.admissionManifestDigest }).from(mcpServers).where(eq(mcpServers.id, subject.id));
    if (!s) return { ok: false, code: "subject_gone" };
    if (s.digest !== subject.digest) return { ok: false, code: "subject_superseded" };
    if (!run.targetSubjectInputCiphertext || !dataKey) return { ok: false, code: "subject_input_gone" };
    let json: string;
    try {
      json = decryptSecret(dataKey, run.targetSubjectInputCiphertext);
    } catch {
      return { ok: false, code: "subject_input_gone" };
    }
    if (sha256Hex(json) !== subject.digest) return { ok: false, code: "subject_input_gone" };
    // the driver's tools.json: the canonical tool list the digest covers, nothing more
    const bytes = Buffer.from(`{"tools":${json}}`, "utf8");
    return { ok: true, file: ADMISSION_SCAN_INPUT_FILE.mcpscanner, bytes, sha256: sha256Hex(bytes) };
  }
  const [s] = await tx
    .select({ name: builderSkills.name, body: builderSkills.body, digest: builderSkills.contentDigest })
    .from(builderSkills)
    .where(eq(builderSkills.id, subject.id));
  if (!s) return { ok: false, code: "subject_gone" };
  let text: { name: string; body: string } | null = s.digest === subject.digest ? { name: s.name, body: s.body } : null;
  if (!text) {
    const [pin] = await tx
      .select({ name: builderAgentSkills.snapshotName, body: builderAgentSkills.bodySnapshot })
      .from(builderAgentSkills)
      .where(and(eq(builderAgentSkills.skillId, subject.id), eq(builderAgentSkills.snapshotDigest, subject.digest)))
      .limit(1);
    // a pinned copy with no name of its own carries the library row's (as the run-time loader reads it)
    text = pin ? { name: pin.name || s.name, body: pin.body } : null;
  }
  if (!text) return { ok: false, code: "subject_superseded" };
  // exactly what the digest covers (the prompt section), so a pass is about the text a prompt receives
  if (sha256Hex(skillPromptSection(text.name, text.body)) !== subject.digest) return { ok: false, code: "subject_superseded" };
  const bytes = Buffer.from(skillMarkdown(text.name, text.body), "utf8");
  return { ok: true, file: ADMISSION_SCAN_INPUT_FILE.skillscanner, bytes, sha256: sha256Hex(bytes) };
}

/** the SKILL.md the skill scanner reads: the stored name (JSON-quoted, so no YAML injection) and the body */
export function skillMarkdown(name: string, body: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: "A RegulAIt builder skill, scanned at admission"\n---\n\n${body.trim()}\n`;
}

/**
 * At a `subject` run's end, in its transaction: record the engine's verdict on the subject. Only a run an engine
 * actually ran (it was leased and its task placed) and that ended completed, failed or timed out is recorded; a
 * report that is missing or unusable is `unknown`, which holds. A cancelled, refused or expired run records
 * nothing: the subject is still pending, which holds too, and an earlier verdict is not buried.
 */
export async function recordSubjectRunEndTx(
  tx: Tx,
  run: EngineRunRow,
  args: { status: EngineTerminalRunStatus; placed: boolean; report: unknown },
): Promise<{ scanId: string; verdict: string; state: string | null; current: boolean } | null> {
  if (run.targetKind !== "subject" || run.status !== "leased" || !args.placed) return null;
  if (!["completed", "failed", "timeout"].includes(args.status)) return null;
  const subject = subjectOfRun(run);
  if (!subject) return null;
  const out = await recordAdmissionEngineScanTx(tx, { subject, report: args.status === "completed" ? args.report : null, engineRunId: run.id });
  return { scanId: out.id, verdict: out.verdict, state: out.state, current: out.current };
}

/** decode a raw report (base64 JSON) for the recorder; anything unreadable is null (`unknown`) */
export function admissionReportOf(contentBase64: string | undefined): unknown {
  if (contentBase64 === undefined) return null;
  try {
    return JSON.parse(Buffer.from(contentBase64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
