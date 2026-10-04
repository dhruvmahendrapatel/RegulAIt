/**
 * ADR-0175 A6 — ADMISSION SCANNING AND INTEGRITY FOR BUILDER SKILLS: the
 * stored half. (The pure scan is `scanSkill` in @regulait/shared, which runs
 * the ADR-0097 rule set through the same entry point MCP manifests use.)
 *
 * What this module owns:
 *
 *   1. `admitSkillText` — scan + digest for a save. The builder routes call it
 *      on create, SKILL.md import, update, template seeding and agent-bundle
 *      import. `refused` never reaches the table (422
 *      `skill_admission_refused`, counts-only findings); `held` is stored but
 *      cannot be attached or run until an admin admits it.
 *   2. `skillAttachRefusal` — what attach and re-attach consult: the skill's
 *      verdict and (ADR-0175 A5) its release-age cooldown. A row that predates
 *      the scanner (`unscanned`) is scanned there first (`ensureSkillScanned`),
 *      and a pinned copy is scanned when a turn first loads it
 *      (`ensureSnapshotScanned`) — cheap, local and idempotent.
 *   3. `runSkillAdmissionRescan` — the skills part of the ADR-0100 re-scan
 *      sweep. Re-scans every library body AND every pinned attachment body
 *      (the pinned body is what runs), least-recently-scanned first so a capped
 *      pass rotates. A verdict that becomes held or refused detaches that body
 *      from prompts at run time. Like the MCP sweep it never re-examines a held
 *      row (nothing auto-clears) and never re-holds an admitted body whose
 *      digest has not moved — an admission is tied to its digest, so a pinned
 *      copy admitted at an older digest keeps its admission.
 *   4. The admin review routes: the queue (held, refused, waiting for a
 *      visibility decision), admit-with-reason, and the visibility decision.
 *
 * THE DIGEST is sha256 of `skillPromptSection(name, body)` — the exact text
 * the skill contributes to a prompt — so a rename is a content change (new
 * digest, new version, re-scanned) and a turn's trace records the digest of the
 * bytes the model was actually sent.
 *
 * WIDENING VISIBILITY. A non-admin who asks for `workspace` gets a PENDING
 * request (`requested_visibility`) and the skill stays private until an admin
 * approves it on the admission review page. Chosen over admin-only widening
 * because the author keeps the ability to ask, the request is visible in one
 * queue next to the scan verdicts an admin is already reviewing, and nothing is
 * shared before a human looks. Narrowing back to private is never gated.
 *
 * Unlike MCP admission, this gate has no `off` switch: a skill is authored
 * inside the product and reaches other people's prompts, the scan is local and
 * cheap, and the hold line (`medium`) is a human review, not a refusal.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  builderAgentSkills,
  builderSkills,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  users,
  type BuilderSkillRow,
  type Db,
} from "@regulait/db";
import {
  admissionFindingSummary,
  admitSkillSchema,
  mcpAdmissionRuleIds,
  nextSkillState,
  scanSkill,
  skillAdmissionRuleIds,
  skillPromptSection,
  skillFindingCounts,
  skillStateUsable,
  skillVisibilityDecisionSchema,
  SKILL_ADMISSION_HOLD_AT,
  SKILL_ADMISSION_REFUSE_AT,
  SKILL_ADMISSION_SCANNER_VERSION,
  type McpAdmissionFinding,
  type SkillAdmissionScan,
  type SkillAdmissionState,
} from "@regulait/shared";
import { minReleaseAgeDays, quarantineDetail, recordSighting, skillReleaseStatus } from "./release-age.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** sha256 of the text the skill puts in a prompt (heading + trimmed body) */
export function skillDigest(name: string, body: string): string {
  return createHash("sha256").update(skillPromptSection(name, body), "utf8").digest("hex");
}

export interface SkillAdmission {
  scan: SkillAdmissionScan;
  digest: string;
  state: SkillAdmissionState;
}

/** scan + digest for one save; `admittedDigest` keeps an admin's admission of
 * an unchanged held body */
export function admitSkillText(
  input: { name: string; description: string; body: string },
  admittedDigest: string | null | ReadonlyArray<string | null> = null,
): SkillAdmission {
  const scan = scanSkill(input);
  const digest = skillDigest(input.name, input.body);
  return { scan, digest, state: nextSkillState({ scan, digest, admittedDigest }) };
}

/** the columns a scanned save writes */
export function admissionColumns(a: SkillAdmission) {
  return {
    contentDigest: a.digest,
    admissionState: a.state,
    admissionFindings: skillFindingCounts(a.scan.findings),
    admissionSeverity: a.scan.severity,
    admissionScannedAt: new Date(),
    admissionScannerVersion: a.scan.scannerVersion,
  };
}

/** the 422 body for a refused save: counts and locations only */
export function skillRefusalBody(name: string, scan: SkillAdmissionScan) {
  return {
    error: "skill_admission_refused",
    detail:
      `skill '${name}' was refused by admission scanning (severity ${scan.severity}, refusal line ` +
      `${SKILL_ADMISSION_REFUSE_AT}): ${admissionFindingSummary(scan.findings)}. It reads like instructions ` +
      `that try to override the agent, hide text, or send data out. Nothing was saved.`,
    severity: scan.severity,
    findings: skillFindingCounts(scan.findings),
  };
}

export async function auditSkillAdmission(
  db: Db,
  args: {
    userId: string | null;
    skillId: string | null;
    name: string;
    admission: SkillAdmission;
    trigger: "create" | "import" | "update" | "template" | "bundle" | "rescan";
    previousState?: string | null;
  },
): Promise<void> {
  const { admission: a } = args;
  if (a.state !== "held" && a.state !== "refused") return;
  const refused = a.state === "refused";
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: "builder_skill",
    objectId: args.skillId,
    detail: {
      phase: "skill-admission",
      trigger: args.trigger,
      previousState: args.previousState ?? null,
      admissionState: a.state,
      severity: a.scan.severity,
      digest: a.digest,
      scannerVersion: a.scan.scannerVersion,
      findings: skillFindingCounts(a.scan.findings),
    },
    effect: "deny",
    ruleId: refused ? "builder-skill-admission-refused" : "builder-skill-admission-held",
    ruleChain: [],
    reason:
      `skill '${args.name}' ${refused ? "refused" : "held"} by admission scanning (${args.trigger}) — ` +
      `${admissionFindingSummary(a.scan.findings)}` +
      (refused ? "." : `. It cannot be attached or run until an admin admits it with a reason.`),
  });
}

/** a new version is a new release: record our first sighting of THIS skill
 * at this digest (the clock is per skill, never shared across skills) */
export async function sightSkill(db: Db, skillId: string, digest: string): Promise<void> {
  await recordSighting(db, "skill", digest, new Date(), skillId);
}

/**
 * ADR-0175 review fix — the lazy scan. A library row that predates the scanner
 * (`unscanned`), or whose stored digest is not the digest of its own text (a
 * row written straight into the table), is scanned now and the verdict stored.
 * Conditional on the row being unchanged since it was read, so two callers
 * racing write one verdict for one text. Returns the row as it now stands.
 */
export async function ensureSkillScanned(db: Db, s: BuilderSkillRow): Promise<BuilderSkillRow> {
  const digest = skillDigest(s.name, s.body);
  if (s.admissionState !== "unscanned" && s.contentDigest === digest) return s;
  const a = admitSkillText(s, s.admittedDigest);
  const [row] = await db
    .update(builderSkills)
    .set(admissionColumns(a))
    .where(and(eq(builderSkills.id, s.id), eq(builderSkills.contentDigest, s.contentDigest), eq(builderSkills.admissionState, s.admissionState)))
    .returning();
  if (row) {
    await auditSkillAdmission(db, { userId: null, skillId: s.id, name: s.name, admission: a, trigger: "rescan", previousState: s.admissionState });
    return row;
  }
  const [now] = await db.select().from(builderSkills).where(eq(builderSkills.id, s.id));
  return now ?? s;
}

/**
 * ADR-0175 review fix — the pinned copy's lazy scan, for the turn that loads
 * it. The digest is recomputed from the pinned name and body (the bytes that
 * will be sent); a copy that is `unscanned`, or whose stored digest is not
 * that, is scanned and stored. An admission carries over only for the digest
 * it was given (the library row's admitted digest, or the copy's own when it
 * was admitted at exactly this digest).
 */
export async function ensureSnapshotScanned(
  db: Db,
  att: {
    agentId: string;
    skillId: string;
    snapshotName: string;
    bodySnapshot: string;
    snapshotDigest: string;
    snapshotAdmissionState: string;
  },
  skill: { description: string; admittedDigest: string | null },
): Promise<{ digest: string; state: SkillAdmissionState }> {
  const digest = skillDigest(att.snapshotName, att.bodySnapshot);
  if (att.snapshotAdmissionState !== "unscanned" && att.snapshotDigest === digest) {
    return { digest, state: att.snapshotAdmissionState as SkillAdmissionState };
  }
  const a = admitSkillText(
    { name: att.snapshotName, description: skill.description, body: att.bodySnapshot },
    [skill.admittedDigest, att.snapshotAdmissionState === "admitted" ? att.snapshotDigest : null],
  );
  await db
    .update(builderAgentSkills)
    .set({ snapshotAdmissionState: a.state, snapshotDigest: a.digest, snapshotScannedAt: new Date() })
    .where(
      and(
        eq(builderAgentSkills.agentId, att.agentId),
        eq(builderAgentSkills.skillId, att.skillId),
        eq(builderAgentSkills.snapshotDigest, att.snapshotDigest),
      ),
    );
  if (a.state === "held" || a.state === "refused") {
    await db.insert(auditLog).values({
      userId: NIL_USER,
      objectType: "builder_agent",
      objectId: att.agentId,
      detail: { phase: "skill-admission", trigger: "load", skillId: att.skillId, admissionState: a.state, digest: a.digest, findings: skillFindingCounts(a.scan.findings) },
      effect: "deny",
      ruleId: "builder-agent-skill-withheld",
      ruleChain: [],
      reason:
        `the pinned copy of skill '${att.snapshotName}' on this agent had not been scanned; it scans ${a.state} ` +
        `(${admissionFindingSummary(a.scan.findings)}) and is kept out of the agent's prompt until admitted or replaced.`,
    });
  }
  return { digest: a.digest, state: a.state };
}

/**
 * May this skill be attached (or re-attached) right now? null = yes, else the
 * 409 body. Consulted by `PUT …/skills` for newly attached skills and by
 * `…/reattach`. A held or refused verdict blocks; so does the release-age
 * cooldown on the body that would be pinned.
 */
export async function skillAttachRefusal(db: Db, row: BuilderSkillRow): Promise<Record<string, unknown> | null> {
  // a row that predates the scanner is scanned now, before it is pinned
  const s = await ensureSkillScanned(db, row);
  if (!skillStateUsable(s.admissionState)) {
    return {
      error: s.admissionState === "refused" ? "skill_refused" : "skill_held",
      skillId: s.id,
      detail:
        `skill '${s.name}' is ${s.admissionState} by admission scanning ` +
        `[${admissionFindingSummary((s.admissionFindings as McpAdmissionFinding[] | null) ?? [])}]` +
        (s.admissionState === "held" ? " — an admin must admit it before it can be attached." : " — edit the skill to fix it."),
    };
  }
  const minDays = await minReleaseAgeDays(db);
  if (minDays > 0) {
    const status = await skillReleaseStatus(db, s.id, s.contentDigest, minDays);
    if (status.quarantined) {
      return {
        error: "skill_release_quarantined",
        skillId: s.id,
        readyAt: status.readyAt,
        detail: quarantineDetail(`skill '${s.name}' v${s.version}`, minDays, status),
      };
    }
  }
  return null;
}

/** an attachment row's pinned fields, taken from the skill as it is now: its
 * NAME and body (the prompt section), that text's digest, version and verdict */
export function pinnedFrom(agentId: string, s: BuilderSkillRow) {
  const digest = skillDigest(s.name, s.body);
  return {
    agentId,
    skillId: s.id,
    snapshotName: s.name,
    bodySnapshot: s.body,
    skillUpdatedAt: s.updatedAt,
    snapshotDigest: digest,
    snapshotVersion: s.version,
    // a stored verdict for other text never travels: the copy is scanned on load
    snapshotAdmissionState: s.contentDigest === digest ? s.admissionState : ("unscanned" as const),
    snapshotScannedAt: s.contentDigest === digest ? s.admissionScannedAt : null,
  };
}

/**
 * Why a pinned body is kept out of the prompt right now, or null when it runs.
 * The snapshot's own verdict decides (it is the body that runs), then the
 * release-age cooldown on that exact body.
 */
export async function pinnedBodyWithheld(
  db: Db,
  att: { skillId: string; snapshotDigest: string; snapshotAdmissionState: string },
  minDays: number,
): Promise<"held" | "refused" | "quarantined" | null> {
  if (att.snapshotAdmissionState === "held" || att.snapshotAdmissionState === "refused") return att.snapshotAdmissionState;
  if (minDays > 0 && att.snapshotDigest) {
    const status = await skillReleaseStatus(db, att.skillId, att.snapshotDigest, minDays);
    if (status.quarantined) return "quarantined";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The re-scan (driven by the ADR-0100 sweep)
// ---------------------------------------------------------------------------

/** bounded work per pass; least-recently-scanned first, so a capped pass rotates */
export const SKILL_RESCAN_MAX_PER_PASS = 500;
const RESCAN_ELIGIBLE: SkillAdmissionState[] = ["unscanned", "clean", "admitted"];

export interface SkillRescanResult {
  examined: number;
  held: number;
  refused: number;
  clean: number;
  snapshotsExamined: number;
  snapshotsWithheld: number;
  heldSkillIds: string[];
}

export async function runSkillAdmissionRescan(db: Db, opts: { limit?: number } = {}): Promise<SkillRescanResult> {
  const limit = Math.max(1, opts.limit ?? SKILL_RESCAN_MAX_PER_PASS);
  const out: SkillRescanResult = { examined: 0, held: 0, refused: 0, clean: 0, snapshotsExamined: 0, snapshotsWithheld: 0, heldSkillIds: [] };

  const rows = await db
    .select()
    .from(builderSkills)
    .where(and(isNull(builderSkills.archivedAt), inArray(builderSkills.admissionState, RESCAN_ELIGIBLE)))
    .orderBy(sql`${builderSkills.admissionScannedAt} asc nulls first`, asc(builderSkills.id))
    .limit(limit);
  for (const s of rows) {
    out.examined++;
    const a = admitSkillText(s, s.admittedDigest);
    // conditional on the text this verdict is for (a concurrent edit wins)
    await db
      .update(builderSkills)
      .set(admissionColumns(a))
      .where(and(eq(builderSkills.id, s.id), eq(builderSkills.name, s.name), eq(builderSkills.body, s.body)));
    if (a.state === "held" || a.state === "refused") {
      if (a.state === "held") out.held++;
      else out.refused++;
      out.heldSkillIds.push(s.id);
      await auditSkillAdmission(db, { userId: null, skillId: s.id, name: s.name, admission: a, trigger: "rescan", previousState: s.admissionState });
    } else {
      out.clean++;
    }
  }

  // the PINNED copies: what agents actually run. Least-recently-scanned
  // first, and every examined copy is stamped, so a pass capped at
  // `limit * 4` rotates through the whole table instead of re-reading the
  // same rows every time.
  const atts = await db
    .select({
      agentId: builderAgentSkills.agentId,
      skillId: builderAgentSkills.skillId,
      body: builderAgentSkills.bodySnapshot,
      snapshotName: builderAgentSkills.snapshotName,
      snapshotDigest: builderAgentSkills.snapshotDigest,
      state: builderAgentSkills.snapshotAdmissionState,
      name: builderSkills.name,
      description: builderSkills.description,
      admittedDigest: builderSkills.admittedDigest,
    })
    .from(builderAgentSkills)
    .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
    .where(inArray(builderAgentSkills.snapshotAdmissionState, RESCAN_ELIGIBLE))
    .orderBy(
      sql`${builderAgentSkills.snapshotScannedAt} asc nulls first`,
      asc(builderAgentSkills.agentId),
      asc(builderAgentSkills.skillId),
    )
    .limit(limit * 4);
  for (const att of atts) {
    out.snapshotsExamined++;
    const pinnedName = att.snapshotName || att.name;
    // an admission is tied to its digest: the library row's admitted digest,
    // or this copy's own when it was admitted at exactly the digest it holds
    const a = admitSkillText(
      { name: pinnedName, description: att.description, body: att.body },
      [att.admittedDigest, att.state === "admitted" ? att.snapshotDigest : null],
    );
    await db
      .update(builderAgentSkills)
      .set({ snapshotAdmissionState: a.state, snapshotDigest: a.digest, snapshotScannedAt: new Date() })
      .where(
        and(
          eq(builderAgentSkills.agentId, att.agentId),
          eq(builderAgentSkills.skillId, att.skillId),
          eq(builderAgentSkills.bodySnapshot, att.body),
        ),
      );
    if (a.state === "held" || a.state === "refused") {
      out.snapshotsWithheld++;
      await db.insert(auditLog).values({
        userId: NIL_USER,
        objectType: "builder_agent",
        objectId: att.agentId,
        detail: {
          phase: "skill-admission",
          trigger: "rescan",
          skillId: att.skillId,
          admissionState: a.state,
          digest: a.digest,
          findings: skillFindingCounts(a.scan.findings),
        },
        effect: "deny",
        ruleId: "builder-agent-skill-withheld",
        ruleChain: [],
        reason:
          `the pinned copy of skill '${pinnedName}' on this agent now scans ${a.state} ` +
          `(${admissionFindingSummary(a.scan.findings)}); it is detached from the agent's prompt until admitted or replaced.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The admin review surface (admin-only via the default gate)
// ---------------------------------------------------------------------------

export function registerSkillAdmissionRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/admission/skills", async () => {
    const rows = await db
      .select({ skill: builderSkills, ownerName: users.displayName })
      .from(builderSkills)
      .innerJoin(users, eq(builderSkills.ownerUserId, users.id))
      .where(
        and(
          isNull(builderSkills.archivedAt),
          or(inArray(builderSkills.admissionState, ["held", "refused", "admitted"]), isNotNull(builderSkills.requestedVisibility)),
        ),
      )
      .orderBy(asc(builderSkills.name));
    return {
      scannerVersion: SKILL_ADMISSION_SCANNER_VERSION,
      holdAt: SKILL_ADMISSION_HOLD_AT,
      refuseAt: SKILL_ADMISSION_REFUSE_AT,
      rules: [...mcpAdmissionRuleIds().filter((r) => r !== "mcp.tool_order.model_directive"), ...skillAdmissionRuleIds()],
      skills: rows.map(({ skill: s, ownerName }) => ({
        id: s.id,
        name: s.name,
        ownerName,
        visibility: s.visibility,
        requestedVisibility: s.requestedVisibility,
        visibilityRequestedAt: s.visibilityRequestedAt?.toISOString() ?? null,
        version: s.version,
        contentDigest: s.contentDigest,
        admissionState: s.admissionState,
        admissionSeverity: s.admissionSeverity,
        admissionFindings: s.admissionFindings ?? [],
        admissionScannedAt: s.admissionScannedAt?.toISOString() ?? null,
        admittedAt: s.admittedAt?.toISOString() ?? null,
        admitReason: s.admitReason,
      })),
    };
  });

  /** ADMIT a held skill: reason required, audited, pinned to the digest the
   * admin was SHOWN (sent back in the body; a skill that changed since is 409) */
  app.post("/v1/admission/skills/:id/admit", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = admitSkillSchema.parse(req.body ?? {});
    const [s] = await db.select().from(builderSkills).where(eq(builderSkills.id, id));
    if (!s || s.archivedAt) return reply.status(404).send({ error: "unknown_skill" });
    const changed = {
      error: "skill_changed",
      detail:
        `skill '${s.name}' is no longer the content you reviewed (digest ${body.digest.slice(0, 16)}; it is now ` +
        `${s.contentDigest.slice(0, 16)}, v${s.version}). Reload the queue and review the current content.`,
    };
    if (s.contentDigest !== body.digest) return reply.status(409).send(changed);
    if (s.admissionState !== "held") {
      return reply.status(409).send({
        error: "not_held",
        detail:
          `skill '${s.name}' is '${s.admissionState}', not 'held'. Only a held skill can be admitted; a refused one ` +
          `must be edited by its owner.`,
      });
    }
    const [row] = await db
      .update(builderSkills)
      .set({
        admissionState: "admitted",
        admittedBy: req.authCtx.userId ?? null,
        admittedAt: new Date(),
        admitReason: body.reason,
        admittedDigest: body.digest,
      })
      .where(and(eq(builderSkills.id, id), eq(builderSkills.admissionState, "held"), eq(builderSkills.contentDigest, body.digest)))
      .returning();
    if (!row) {
      const [now] = await db.select({ d: builderSkills.contentDigest }).from(builderSkills).where(eq(builderSkills.id, id));
      return reply.status(409).send(now && now.d !== body.digest ? changed : { error: "not_held" });
    }
    // attachments pinned to this exact body are admitted with it
    await db
      .update(builderAgentSkills)
      .set({ snapshotAdmissionState: "admitted" })
      .where(
        and(
          eq(builderAgentSkills.skillId, id),
          eq(builderAgentSkills.snapshotDigest, s.contentDigest),
          eq(builderAgentSkills.snapshotAdmissionState, "held"),
        ),
      );
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "builder_skill",
      objectId: id,
      detail: {
        phase: "skill-admit",
        digest: s.contentDigest,
        version: s.version,
        severity: s.admissionSeverity,
        findings: s.admissionFindings ?? [],
        reason: body.reason,
      },
      effect: "allow",
      ruleId: "builder-skill-admitted",
      ruleChain: [],
      reason:
        `skill '${s.name}' v${s.version} admitted despite admission findings — reason: ${body.reason}. The admission ` +
        `is pinned to digest ${s.contentDigest.slice(0, 16)}; a changed body is scanned from scratch.`,
    });
    return reply.send({ skill: { id: row.id, admissionState: row.admissionState, admittedDigest: row.admittedDigest } });
  });

  /** the decision on a pending widening of visibility */
  app.post("/v1/admission/skills/:id/visibility", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = skillVisibilityDecisionSchema.parse(req.body ?? {});
    const [s] = await db.select().from(builderSkills).where(eq(builderSkills.id, id));
    if (!s || s.archivedAt) return reply.status(404).send({ error: "unknown_skill" });
    if (!s.requestedVisibility) return reply.status(409).send({ error: "no_pending_request" });
    const approve = body.decision === "approve";
    await db
      .update(builderSkills)
      .set({
        ...(approve ? { visibility: s.requestedVisibility } : {}),
        requestedVisibility: null,
        visibilityRequestedAt: null,
      })
      .where(eq(builderSkills.id, id));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NIL_USER,
      objectType: "builder_skill",
      objectId: id,
      detail: { phase: "skill-visibility", decision: body.decision, from: s.visibility, requested: s.requestedVisibility, reason: body.reason ?? null },
      effect: approve ? "allow" : "deny",
      ruleId: approve ? "builder-skill-visibility-approved" : "builder-skill-visibility-denied",
      ruleChain: [],
      reason: `widening skill '${s.name}' to ${s.requestedVisibility} ${approve ? "approved" : "denied"} by an admin` + (body.reason ? ` — ${body.reason}` : ""),
    });
    return reply.send({ skill: { id, visibility: approve ? s.requestedVisibility : s.visibility, requestedVisibility: null } });
  });
}
