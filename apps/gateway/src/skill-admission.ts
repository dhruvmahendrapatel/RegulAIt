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
 *      verdict and (ADR-0175 A5) its release-age cooldown.
 *   3. `runSkillAdmissionRescan` — the skills part of the ADR-0100 re-scan
 *      sweep. Re-scans every library body AND every pinned attachment body
 *      (the pinned body is what runs). A verdict that becomes held or refused
 *      detaches that body from prompts at run time. Like the MCP sweep it
 *      never re-examines a held row (nothing auto-clears) and never re-holds an
 *      admitted body whose digest has not moved.
 *   4. The admin review routes: the queue (held, refused, waiting for a
 *      visibility decision), admit-with-reason, and the visibility decision.
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

export function skillDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
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
  admittedDigest: string | null = null,
): SkillAdmission {
  const scan = scanSkill(input);
  const digest = skillDigest(input.body);
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

/** a new body is a new release: record our first sighting of its digest */
export async function sightSkill(db: Db, digest: string): Promise<void> {
  await recordSighting(db, "skill", digest);
}

/**
 * May this skill be attached (or re-attached) right now? null = yes, else the
 * 409 body. Consulted by `PUT …/skills` for newly attached skills and by
 * `…/reattach`. A held or refused verdict blocks; so does the release-age
 * cooldown on the body that would be pinned.
 */
export async function skillAttachRefusal(db: Db, s: BuilderSkillRow): Promise<Record<string, unknown> | null> {
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

/** an attachment row's pinned fields, taken from the skill as it is now */
export function pinnedFrom(agentId: string, s: BuilderSkillRow) {
  return {
    agentId,
    skillId: s.id,
    bodySnapshot: s.body,
    skillUpdatedAt: s.updatedAt,
    snapshotDigest: s.contentDigest || skillDigest(s.body),
    snapshotVersion: s.version,
    snapshotAdmissionState: s.admissionState,
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
    await db.update(builderSkills).set(admissionColumns(a)).where(eq(builderSkills.id, s.id));
    if (a.state === "held" || a.state === "refused") {
      if (a.state === "held") out.held++;
      else out.refused++;
      out.heldSkillIds.push(s.id);
      await auditSkillAdmission(db, { userId: null, skillId: s.id, name: s.name, admission: a, trigger: "rescan", previousState: s.admissionState });
    } else {
      out.clean++;
    }
  }

  // the PINNED bodies: what agents actually run
  const atts = await db
    .select({
      agentId: builderAgentSkills.agentId,
      skillId: builderAgentSkills.skillId,
      body: builderAgentSkills.bodySnapshot,
      state: builderAgentSkills.snapshotAdmissionState,
      name: builderSkills.name,
      description: builderSkills.description,
      admittedDigest: builderSkills.admittedDigest,
    })
    .from(builderAgentSkills)
    .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
    .where(inArray(builderAgentSkills.snapshotAdmissionState, RESCAN_ELIGIBLE))
    .limit(limit * 4);
  for (const att of atts) {
    out.snapshotsExamined++;
    const a = admitSkillText({ name: att.name, description: att.description, body: att.body }, att.admittedDigest);
    if (a.state !== att.state || att.state === "unscanned") {
      await db
        .update(builderAgentSkills)
        .set({ snapshotAdmissionState: a.state, snapshotDigest: a.digest })
        .where(and(eq(builderAgentSkills.agentId, att.agentId), eq(builderAgentSkills.skillId, att.skillId)));
    }
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
          `the pinned body of skill '${att.name}' on this agent now scans ${a.state} ` +
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

  /** ADMIT a held skill: reason required, audited, pinned to the digest admitted */
  app.post("/v1/admission/skills/:id/admit", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = admitSkillSchema.parse(req.body ?? {});
    const [s] = await db.select().from(builderSkills).where(eq(builderSkills.id, id));
    if (!s || s.archivedAt) return reply.status(404).send({ error: "unknown_skill" });
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
        admittedDigest: s.contentDigest,
      })
      .where(and(eq(builderSkills.id, id), eq(builderSkills.admissionState, "held")))
      .returning();
    if (!row) return reply.status(409).send({ error: "not_held" });
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
