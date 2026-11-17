/**
 * ADR-0362 slice 1b-ii — CONTENT INSPECTION ON THE REQUEST PATH: the per-project setting, its compliance floor, the one
 * inspection step the governed dispatch core runs on a dispatch's files, and the admin routes.
 *
 *  - `effectiveContentInspection(db, projectId)` is THE policy: on when the project's row enables it OR the project's
 *    explicit compliance profiles' effective PII mode is `block` (the floor, `projectProfilePiiMode`: the profile
 *    resolution `projectPiiMode` uses, WITHOUT its org-default fallback, so an unclassified project, unmatched tags
 *    and an unattributed dispatch are never forced; lane lead decision 2026-11-17, ADR-0362 owner question 4). Under the floor a file that
 *    cannot be read always refuses: the row's `pass_not_scanned` cannot relax it. No row is off / `refuse`.
 *  - `inspectDispatchFiles` runs in `dispatchAttempt` (agents-connectors.ts) BEFORE the three input checks (cascade PII
 *    mode, the ADR-0224 processing limit, the ADR-0042 guardrails). With inspection off it does nothing (no query beyond
 *    the policy read, no audit row). With it on, it sends the files to the sandboxed extractor
 *    (`extractContentForRequest`, never in this process) and either refuses the dispatch 422 `content_not_inspectable`
 *    (audited deny, before any provider work) or returns the extracted text, labelled per file, for the core to append
 *    to the prompt for those same three checks. One `content-inspection` audit row per inspected dispatch; it names
 *    files by index and kind only, never a file name or any extracted text.
 *  - GET / PUT `/v1/projects/:projectId/content-inspection`. GET: a project viewer or an admin (`projectRoleGate`, the
 *    check every per-project route uses). PUT: admin only (the default route gate, as `PATCH /v1/projects/:projectId`).
 *    Turning inspection off, or choosing `pass_not_scanned`, is a RELAXATION: a `settings_relax` step-up
 *    (`requireStepUp`), audited. Tightening is audited and needs no step-up.
 *
 * The redact case of ADR-0362 decision 5 (withhold the file, send its redacted text) is not built: the dispatch's PII
 * modes are log, warn and block today.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, eq, projectContentInspection, projects, sql, type Db } from "@regulait/db";
import type { ModelChatMessage } from "@regulait/model-provider";
import {
  CONTENT_INSPECTION_COST_NOTE,
  CONTENT_INSPECTION_DEFAULTS,
  CONTENT_INSPECTION_DISPATCH_OUTCOMES,
  contentInspectionFileTransitionAllowed,
  contentInspectionSettingsBodySchema,
  type ContentInspectionDispatchOutcome,
  type ContentInspectionEngineOutcome,
  type ContentInspectionFileStatus,
  type ContentInspectionOnUninspectable,
  type ContentKind,
  type ContentRefusalReason,
} from "@regulait/shared";
import { extractContentForRequest, type ContentExtractBundleFile } from "./content-inspection-runs.js";
import { enforcePII, piiInternationalCategories, projectPiiMode, projectProfilePiiMode, projectRoleGate, type PiiMode } from "./projects.js";
import { refuseIfArchived } from "./project-archive.js";
import { requireStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** how long a dispatch waits for the extractor before every file counts as refused (`timeout`); the extractor stops
 * itself at 20 s (CONTENT_EXTRACT_HARD_LIMITS.deadlineMs), so this leaves room for the sandbox start */
export const CONTENT_INSPECTION_DEADLINE_MS = 30_000;

/** the audit rule ids this module writes */
export const CONTENT_INSPECTION_RULE_IDS = {
  dispatch: "content-inspection",
  settings: "content-inspection-settings",
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------------------------------------------------

export type ContentInspectionSetting = { enabled: boolean; onUninspectable: ContentInspectionOnUninspectable };
export type EffectiveContentInspection = {
  on: boolean;
  /** forced on by the compliance floor (the effective cascade PII mode is `block`) */
  forced: boolean;
  onUninspectable: ContentInspectionOnUninspectable;
};

/** the project's stored row, or the shipped default when it has none (or the dispatch names no project) */
export async function loadContentInspectionSetting(db: Db, projectId: string | null): Promise<ContentInspectionSetting> {
  if (!projectId) return { ...CONTENT_INSPECTION_DEFAULTS };
  const [row] = await db
    .select({ enabled: projectContentInspection.enabled, onUninspectable: projectContentInspection.onUninspectable })
    .from(projectContentInspection)
    .where(eq(projectContentInspection.projectId, projectId));
  if (!row) return { ...CONTENT_INSPECTION_DEFAULTS };
  // the CHECK constraint holds the vocabulary; anything else read back fails closed to `refuse`
  return { enabled: row.enabled, onUninspectable: row.onUninspectable === "pass_not_scanned" ? "pass_not_scanned" : "refuse" };
}

/** compose a stored setting with the floor (the one place the rule lives) */
/** `profilePiiMode` is `projectProfilePiiMode` (explicit profiles only; null without one) */
function compose(setting: ContentInspectionSetting, profilePiiMode: PiiMode | null): EffectiveContentInspection {
  const forced = profilePiiMode === "block";
  return { on: setting.enabled || forced, forced, onUninspectable: forced ? "refuse" : setting.onUninspectable };
}

/** THE effective policy for a dispatch attributed to `projectId` (null: unattributed, never forced, the default applies) */
export async function effectiveContentInspection(db: Db, projectId: string | null): Promise<EffectiveContentInspection> {
  const [setting, profilePiiMode] = await Promise.all([loadContentInspectionSetting(db, projectId), projectProfilePiiMode(db, projectId)]);
  return compose(setting, profilePiiMode);
}

// ---------------------------------------------------------------------------------------------------------------------
// The dispatch step
// ---------------------------------------------------------------------------------------------------------------------

/** one caller file as the dispatch carries it (an image or document block) */
export type InspectableFile = { kind: "image" | "document"; mediaType: string; dataBase64: string; name?: string | undefined };

/** every image and document block of a dispatch's messages, in order (a compat caller re-sends earlier turns' files) */
export function inspectableFilesOf(messages: readonly ModelChatMessage[] | undefined): InspectableFile[] {
  const out: InspectableFile[] = [];
  for (const m of messages ?? []) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "image" || b.type === "document") out.push({ kind: b.type, mediaType: b.mediaType, dataBase64: b.dataBase64, name: b.name });
    }
  }
  return out;
}

/** one file's line in the audit row and the refusal: index and kind, never the name or the text */
export type InspectedFileRecord = {
  index: number;
  kind: InspectableFile["kind"];
  status: ContentInspectionFileStatus;
  /** what the bytes were found to be, when the extractor said */
  type?: ContentKind;
  reason?: ContentRefusalReason;
  /** PII categories found in this file's text (ADR-0362 decision 5: which attachment a hit came from) */
  piiCategories?: string[];
};

export type ContentInspectionVerdict =
  | { kind: "no_files" }
  | { kind: "off" }
  | { kind: "refused"; status: 422; error: "content_not_inspectable"; detail: string; auditLogId: string | null; files: InspectedFileRecord[] }
  | { kind: "proceed"; outcome: ContentInspectionDispatchOutcome; files: InspectedFileRecord[]; inspectedText: string };

/** the neutral label the extracted text of file `i` carries in the text the input checks read */
export const attachmentLabel = (i: number) => `[attachment a${i}]`;

/**
 * Inspect a dispatch's files. `inspectedText` (on `proceed`) is what the core appends to the prompt for its input
 * checks: for each extracted file, a blank line, its label and its text. Never throws for an engine outcome.
 */
export async function inspectDispatchFiles(
  db: Db,
  args: {
    userId: string;
    agentId: string;
    projectId: string | null;
    files: readonly InspectableFile[];
    deadlineMs?: number;
  },
): Promise<ContentInspectionVerdict> {
  if (args.files.length === 0) return { kind: "no_files" };
  const policy = await effectiveContentInspection(db, args.projectId);
  if (!policy.on) return { kind: "off" };
  // the dispatch's own PII mode (org default included), for the per-file categories only
  const piiMode = await projectPiiMode(db, args.projectId);

  const bundle: ContentExtractBundleFile[] = args.files.map((f, i) => ({
    id: `a${i}`,
    name: f.name && f.name.length > 0 ? f.name : `a${i}`,
    mediaType: f.mediaType,
    dataBase64: f.dataBase64,
  }));
  const engine = await extractContentForRequest(db, {
    files: bundle,
    projectId: args.projectId,
    userId: args.userId,
    deadlineMs: args.deadlineMs ?? CONTENT_INSPECTION_DEADLINE_MS,
  });
  const engineOutcome: ContentInspectionEngineOutcome = engine.outcome;
  const results = engine.outcome === "result" ? engine.result.files : null;

  const records: InspectedFileRecord[] = args.files.map((f, i) => {
    const r = results?.[i];
    if (r && r.status === "extracted") return { index: i, kind: f.kind, status: "extracted", type: r.type };
    // no answer is a refusal of every file (ADR-0362 decision 2)
    return r ? { index: i, kind: f.kind, status: "refused", type: r.type, reason: r.reason } : { index: i, kind: f.kind, status: "refused", reason: "timeout" };
  });
  const refused = records.filter((r) => r.status === "refused");

  const auditBase = {
    phase: "content-inspection",
    ...(args.projectId ? { projectId: args.projectId } : {}),
    forced: policy.forced,
    onUninspectable: policy.onUninspectable,
    engine: { runId: engine.runId, outcome: engineOutcome },
    receiptClass: "decision",
  };
  const fileList = (rs: InspectedFileRecord[]) => rs.map((r) => `#${r.index} (${r.kind}, ${r.reason ?? r.status})`).join(", ");

  if (refused.length > 0 && policy.onUninspectable === "refuse") {
    const outcome: ContentInspectionDispatchOutcome = "refused";
    const detail =
      `content inspection could not read ${refused.length} of ${records.length} attached file(s): ${fileList(refused)}` +
      (engineOutcome === "result" ? "" : `; the content-extraction engine answered ${engineOutcome}`) +
      (policy.forced ? "; inspection is required by the project's compliance profile PII mode (block)" : "");
    const [row] = await db
      .insert(auditLog)
      .values({
        userId: args.userId,
        objectType: "agent",
        objectId: args.agentId,
        detail: { ...auditBase, outcome, files: records },
        effect: "deny",
        ruleId: CONTENT_INSPECTION_RULE_IDS.dispatch,
        ruleChain: [],
        reason: detail,
      })
      .returning({ id: auditLog.id });
    return { kind: "refused", status: 422, error: "content_not_inspectable", detail, auditLogId: row?.id ?? null, files: records };
  }

  // the relaxation lets the dispatch go on: every file that could not be read is recorded `not_scanned`, never clean
  for (const r of records) {
    if (r.status === "refused" && contentInspectionFileTransitionAllowed("refused", "not_scanned")) r.status = "not_scanned";
  }
  const outcome: ContentInspectionDispatchOutcome = refused.length > 0 ? "passed_not_scanned" : "inspected";
  if (!CONTENT_INSPECTION_DISPATCH_OUTCOMES[outcome].proceeds) throw new Error(`content inspection outcome ${outcome} does not proceed`);

  let inspectedText = "";
  const intl = piiMode && piiMode !== "redact" ? await piiInternationalCategories(db) : null;
  for (const r of records) {
    const file = results?.[r.index];
    if (r.status !== "extracted" || !file || file.status !== "extracted") continue;
    inspectedText += `\n\n${attachmentLabel(r.index)}\n${file.text}`;
    if (piiMode && piiMode !== "redact" && intl) {
      const hits = enforcePII(piiMode, { input: file.text }, intl).hits;
      if (hits.length > 0) r.piiCategories = hits.map((h) => h.category);
    }
  }
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: "agent",
    objectId: args.agentId,
    detail: { ...auditBase, outcome, files: records },
    effect: "allow",
    ruleId: CONTENT_INSPECTION_RULE_IDS.dispatch,
    ruleChain: [],
    reason:
      outcome === "inspected"
        ? `content inspection read ${records.length} attached file(s); their text goes through the input checks`
        : `content inspection could not read ${refused.length} of ${records.length} attached file(s) (${fileList(refused)}); the project lets them pass marked not scanned`,
  });
  return { kind: "proceed", outcome, files: records, inspectedText };
}

/**
 * The additive `contentInspection` key the native invoke path puts on its dispatch audit row when inspection is OFF
 * and the dispatch carries files: every file `not_scanned` (ADR-0362 decision 7), never "clean". Null when there are
 * no files or inspection is on (the inspected dispatch has its own `content-inspection` row).
 */
export async function notInspectedAuditNote(
  db: Db,
  projectId: string | null,
  files: ReadonlyArray<{ kind: InspectableFile["kind"] }>,
): Promise<{ contentInspection: { outcome: ContentInspectionDispatchOutcome; files: InspectedFileRecord[] } } | null> {
  if (files.length === 0) return null;
  if ((await effectiveContentInspection(db, projectId)).on) return null;
  return {
    contentInspection: {
      outcome: "not_inspected",
      files: files.map((f, i) => ({ index: i, kind: f.kind, status: "not_scanned" as const })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------------

const projectIdParam = z.object({ projectId: z.string().uuid() }).strict();

/** which changes of `from` → `to` loosen inspection (each one a settings_relax step-up) */
export function contentInspectionRelaxations(from: ContentInspectionSetting, to: ContentInspectionSetting): string[] {
  const out: string[] = [];
  if (from.enabled && !to.enabled) out.push("enabled");
  if (from.onUninspectable === "refuse" && to.onUninspectable === "pass_not_scanned") out.push("onUninspectable");
  return out;
}

function view(projectId: string, setting: ContentInspectionSetting, profilePiiMode: PiiMode | null) {
  const effective = compose(setting, profilePiiMode);
  return {
    projectId,
    enabled: setting.enabled,
    onUninspectable: setting.onUninspectable,
    effective,
    costNote: CONTENT_INSPECTION_COST_NOTE,
    ...(effective.forced
      ? {
          forcedBy:
            "the project's compliance profiles set PII mode block, so content inspection is on and a file that cannot be read refuses the dispatch, whatever this setting says",
        }
      : {}),
  };
}

export function registerContentInspectionRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/projects/:projectId/content-inspection", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    const gate = await projectRoleGate(db, req, projectId, "viewer");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const [setting, profilePiiMode] = await Promise.all([loadContentInspectionSetting(db, projectId), projectProfilePiiMode(db, projectId)]);
    return view(projectId, setting, profilePiiMode);
  });

  app.put("/v1/projects/:projectId/content-inspection", async (req, reply) => {
    const { projectId } = projectIdParam.parse(req.params);
    const body = contentInspectionSettingsBodySchema.parse(req.body);
    const [project] = await db
      .select({ id: projects.id, name: projects.name, archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return reply.status(404).send({ error: "unknown_project" });
    // ADR-0206 G1: an archived project's settings are frozen, as PATCH /v1/projects/:projectId and its classifications
    if (await refuseIfArchived(reply, project)) return reply;
    // admin-only by the default route gate; the per-project check is kept so the route stays correct if that changes
    const gate = await projectRoleGate(db, req, projectId, "owner");
    if (!gate.ok) return reply.status(gate.status).send({ error: gate.error });
    const from = await loadContentInspectionSetting(db, projectId);
    const to: ContentInspectionSetting = {
      enabled: body.enabled ?? from.enabled,
      onUninspectable: body.onUninspectable ?? from.onUninspectable,
    };
    const relaxed = contentInspectionRelaxations(from, to);
    if (
      relaxed.length > 0 &&
      !(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { contentInspection: projectId, from, to } })).ok
    ) {
      return reply;
    }
    const userId = req.authCtx.userId ?? null;
    await db.transaction(async (tx) => {
      await tx
        .insert(projectContentInspection)
        .values({ projectId, enabled: to.enabled, onUninspectable: to.onUninspectable, updatedBy: userId })
        .onConflictDoUpdate({
          target: projectContentInspection.projectId,
          set: { enabled: to.enabled, onUninspectable: to.onUninspectable, updatedBy: userId, updatedAt: sql`now()` },
        });
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "project",
        objectId: projectId,
        detail: { phase: "content-inspection-settings", projectId, from, to, relaxed },
        effect: "allow",
        ruleId: CONTENT_INSPECTION_RULE_IDS.settings,
        ruleChain: [],
        reason: `content inspection settings changed${relaxed.length > 0 ? ` (relaxed with a step-up: ${relaxed.join(", ")})` : ""}`,
      });
    });
    return view(projectId, to, await projectProfilePiiMode(db, projectId));
  });
}
