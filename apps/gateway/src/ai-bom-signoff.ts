/**
 * ADR-0189 R25 (OWNER DECISIONS 8 and 12; "Amendments settling R25", 2026-10-11):
 * the automatic AI BOM snapshot a SIGN-OFF takes.
 *
 * Two halves, so a hook never has to know how a snapshot is taken:
 *
 *  - `prepareAiBomSignoff(tx, …)` runs INSIDE the triggering transaction, on the
 *    approved branch only (a rejection calls nothing here and takes no snapshot):
 *     - `ai_bom_snapshot_triggers = on_demand_only` (an audited relaxation): nothing;
 *     - no usable receipt signing key and `ai_bom_snapshot_without_key = refuse`
 *       (the strict default): throws 409 `bom_signing_unavailable` (503
 *       `receipt_signing_key_invalid` for a key that is configured but unusable), so
 *       the triggering transaction rolls back and NOTHING commits (item 6);
 *     - no usable key, relaxed to `skip_and_record`: one `ai-bom-snapshot-skipped-no-key`
 *       audit row per subject, in the same transaction; no snapshot is taken later;
 *     - otherwise: the first `AI_BOM_SIGNOFF_FANOUT_CAP` subjects are OWED a snapshot.
 *       The caller spreads `auditDetail` (`aiBomSnapshotsDue`, `aiBomSignoffId`) into
 *       its own triggering audit row, so a crash between commit and snapshot leaves
 *       a visible debt (item 9). Each subject past the cap gets an
 *       `ai-bom-snapshot-failed` row with code `fanout_exceeded`, here (item 10).
 *  - `runAiBomSignoffs(db, …)` runs AFTER the outermost commit. Each owed subject
 *    is snapshotted one after another through `takeAiBomSnapshot` (the per-subject
 *    session lock, one REPEATABLE READ capture, the `ai-bom-snapshot-taken` row;
 *    R50, item 5). A failure never undoes the sign-off: it writes an
 *    `ai-bom-snapshot-failed` row and comes back as a response warning (item 7).
 *
 * Gap rows are `audit_log` rows (item 4). Each carries
 * `{subjectKind, subjectId, trigger, triggeringObjectId, code, aiBomSignoffId}`.
 */
import { randomUUID } from "node:crypto";
import { agents, aiUseCases, auditLog, builderAgents, eq, inArray, orgSettings, ORG_SETTINGS_ID, sql, type Db } from "@regulait/db";
import { AI_BOM_INSTALL_SUBJECT_ID, BOM_STRICT_DEFAULTS, type AiBomSnapshotTrigger, type AiBomSubjectKind } from "@regulait/shared";
import { AI_BOM_GAP_RULE_IDS, AI_BOM_SNAPSHOT_RULE_IDS, AI_BOM_SNAPSHOTS_RELEASED, AiBomError, aiBomInstallId, takeAiBomSnapshot, type AiBomSubject } from "./ai-bom.js";

export { AI_BOM_GAP_RULE_IDS, AI_BOM_SNAPSHOT_RULE_IDS };
import { loadReceiptSigningKey, ReceiptKeyError } from "./decision-receipts.js";

/** item 10: one sign-off snapshots at most this many subjects. A constant, not a setting. */
export const AI_BOM_SIGNOFF_FANOUT_CAP = 100;

export type AiBomSignoffTrigger = Exclude<AiBomSnapshotTrigger, "on_demand">;

/** what one sign-off still owes after its transaction commits */
export interface AiBomSignoff {
  id: string;
  trigger: AiBomSignoffTrigger;
  triggeringObjectId: string;
  actorUserId: string | null;
  subjects: AiBomSubject[];
}

/** spread into the triggering audit row's detail (item 9) */
export type AiBomSignoffDueDetail = {
  aiBomSignoffId: string;
  aiBomSnapshotsDue: Array<{ subjectKind: AiBomSubjectKind; subjectId: string }>;
};

export interface PreparedAiBomSignoff {
  /** null: nothing to take after commit (off, skipped, or no subject) */
  signoff: AiBomSignoff | null;
  /** `{}` when nothing is owed */
  auditDetail: AiBomSignoffDueDetail | Record<string, never>;
}

const NONE: PreparedAiBomSignoff = Object.freeze({ signoff: null, auditDetail: {} }) as PreparedAiBomSignoff;
const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** subjects in a stable order, each once (agents, use cases, builder agents, install; ids ascending) */
function normaliseSubjects(subjects: readonly AiBomSubject[]): AiBomSubject[] {
  const rank: Record<AiBomSubjectKind, number> = { agent: 0, use_case: 1, builder_agent: 2, install: 3 };
  const seen = new Map<string, AiBomSubject>();
  for (const s of subjects) seen.set(`${s.kind}:${s.id}`, { kind: s.kind, id: s.id });
  return [...seen.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function writeGapRow(
  tx: Pick<Db, "insert">,
  ruleId: (typeof AI_BOM_GAP_RULE_IDS)[number],
  s: { signoffId: string; trigger: AiBomSignoffTrigger; triggeringObjectId: string; actorUserId: string | null },
  subject: AiBomSubject,
  code: string,
  reason: string,
): Promise<void> {
  await tx.insert(auditLog).values({
    userId: s.actorUserId ?? NIL_USER,
    objectType: "audit_export",
    objectId: subject.id,
    // the sign-off stood; this row records that its snapshot does not exist
    effect: "allow",
    ruleId,
    ruleChain: [],
    reason,
    detail: {
      subjectKind: subject.kind,
      subjectId: subject.id,
      trigger: s.trigger,
      triggeringObjectId: s.triggeringObjectId,
      code,
      aiBomSignoffId: s.signoffId,
    },
  });
}

/** the two settings a sign-off reads; a missing row is the strict default (ADR-0180) */
async function signoffSettings(tx: Pick<Db, "select">) {
  const [row] = await tx
    .select({ triggers: orgSettings.aiBomSnapshotTriggers, withoutKey: orgSettings.aiBomSnapshotWithoutKey })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return {
    triggers: row?.triggers ?? BOM_STRICT_DEFAULTS.aiBomSnapshotTriggers,
    withoutKey: row?.withoutKey ?? BOM_STRICT_DEFAULTS.aiBomSnapshotWithoutKey,
  };
}

/** is there a receipt key a snapshot can be signed with? */
function keyState(): "ok" | "missing" | "invalid" {
  try {
    return loadReceiptSigningKey() ? "ok" : "missing";
  } catch (e) {
    if (e instanceof ReceiptKeyError) return "invalid";
    throw e;
  }
}

/** the item-6 refusal: no usable key while `ai_bom_snapshot_without_key = refuse` */
function refusalFor(key: "missing" | "invalid"): AiBomError {
  if (key === "invalid") {
    return new AiBomError(503, "receipt_signing_key_invalid", "The receipt signing key is configured but unusable, so this sign-off cannot take its AI BOM snapshot and is refused. Nothing was changed.");
  }
  return new AiBomError(
    409,
    "bom_signing_unavailable",
    "No receipt signing key is configured (REGULAIT_RECEIPT_SIGNING_KEY), so this sign-off cannot take its signed AI BOM " +
      "snapshot and is refused (ai_bom_snapshot_without_key = refuse). Nothing was changed.",
  );
}

/**
 * THE EARLY CHECK, for a caller that must refuse a sign-off BEFORE work it
 * cannot roll back (a workflow transition whose git effects run after commit):
 * throws exactly what `prepareAiBomSignoff` would throw for a sign-off now
 * (409 `bom_signing_unavailable`, or 503 for an unusable key), and returns
 * when the sign-off would go through (a key, triggers relaxed to on demand
 * only, or `skip_and_record`). Call it inside the triggering transaction.
 */
export async function assertAiBomSignoffPossible(tx: Pick<Db, "select">): Promise<void> {
  if (!AI_BOM_SNAPSHOTS_RELEASED) return;
  const settings = await signoffSettings(tx);
  if (settings.triggers !== "sign_off_events" || settings.withoutKey !== "refuse") return;
  const key = keyState();
  if (key !== "ok") throw refusalFor(key);
}

/**
 * THE IN-TRANSACTION HALF. Call it on the approved branch, inside the
 * triggering transaction and BEFORE the triggering audit row is written, then
 * spread `auditDetail` into that row and hand `signoff` to the caller's
 * post-commit step.
 */
export async function prepareAiBomSignoff(
  tx: Db,
  input: { trigger: AiBomSignoffTrigger; triggeringObjectId: string; actorUserId: string | null; subjects: readonly AiBomSubject[] },
): Promise<PreparedAiBomSignoff> {
  if (!AI_BOM_SNAPSHOTS_RELEASED) return NONE; // R2: triggers do nothing before the release switch
  const subjects = normaliseSubjects(input.subjects);
  if (subjects.length === 0) return NONE;
  const settings = await signoffSettings(tx);
  if (settings.triggers !== "sign_off_events") return NONE; // relaxed to on demand only (audited)
  const signoffId = randomUUID();
  const ctx = { signoffId, trigger: input.trigger, triggeringObjectId: input.triggeringObjectId, actorUserId: input.actorUserId };
  const key = keyState();
  if (key !== "ok") {
    if (settings.withoutKey === "refuse") {
      // item 6 / OWNER DECISION 12: the sign-off is refused and its transaction rolls back
      throw refusalFor(key);
    }
    const code = key === "invalid" ? "receipt_signing_key_invalid" : "bom_signing_unavailable";
    for (const subject of subjects) {
      await writeGapRow(tx, AI_BOM_SNAPSHOT_RULE_IDS.skippedNoKey, ctx, subject, code,
        `AI BOM snapshot skipped for ${subject.kind} ${subject.id} on ${input.trigger}: no usable receipt signing key, and ` +
          "ai_bom_snapshot_without_key is relaxed to skip_and_record. No snapshot will be taken on this sign-off's behalf.");
    }
    return NONE;
  }
  const owed = subjects.slice(0, AI_BOM_SIGNOFF_FANOUT_CAP);
  for (const subject of subjects.slice(AI_BOM_SIGNOFF_FANOUT_CAP)) {
    await writeGapRow(tx, AI_BOM_SNAPSHOT_RULE_IDS.failed, ctx, subject, "fanout_exceeded",
      `AI BOM snapshot not taken for ${subject.kind} ${subject.id} on ${input.trigger}: this sign-off reaches more than ` +
        `${AI_BOM_SIGNOFF_FANOUT_CAP} subjects. The sign-off stands; take this subject's snapshot on demand.`);
  }
  return {
    signoff: { id: signoffId, trigger: input.trigger, triggeringObjectId: input.triggeringObjectId, actorUserId: input.actorUserId, subjects: owed },
    auditDetail: { aiBomSignoffId: signoffId, aiBomSnapshotsDue: owed.map((s) => ({ subjectKind: s.kind, subjectId: s.id })) },
  };
}

/** the response warning naming each subject whose snapshot failed (item 7) */
export interface AiBomSnapshotWarning {
  code: "ai_bom_snapshot_failed";
  detail: string;
  subjects: Array<{ subjectKind: AiBomSubjectKind; subjectId: string; trigger: AiBomSignoffTrigger; code: string }>;
}

/**
 * THE POST-COMMIT HALF. Call it once the triggering transaction has
 * committed, with the root handle (never a transaction). It never throws: a
 * failed snapshot is recorded and returned as a warning.
 */
export async function runAiBomSignoffs(
  db: Db,
  signoffs: ReadonlyArray<AiBomSignoff | null | undefined>,
  log?: { error: (obj: unknown, msg?: string) => void },
): Promise<AiBomSnapshotWarning | null> {
  const failed: AiBomSnapshotWarning["subjects"] = [];
  for (const s of signoffs) {
    if (!s) continue;
    for (const subject of s.subjects) {
      try {
        await takeAiBomSnapshot(db, { subject, trigger: s.trigger, actorUserId: s.actorUserId, installId: aiBomInstallId(), signoff: { id: s.id, triggeringObjectId: s.triggeringObjectId } });
      } catch (e) {
        const code = e instanceof AiBomError ? e.code : "snapshot_error";
        failed.push({ subjectKind: subject.kind, subjectId: subject.id, trigger: s.trigger, code });
        try {
          await db.transaction((tx) =>
            writeGapRow(tx as unknown as Db, AI_BOM_SNAPSHOT_RULE_IDS.failed, { signoffId: s.id, trigger: s.trigger, triggeringObjectId: s.triggeringObjectId, actorUserId: s.actorUserId }, subject, code,
              `AI BOM snapshot failed for ${subject.kind} ${subject.id} on ${s.trigger} (${code}). The sign-off stands; take this subject's snapshot on demand.`),
          );
        } catch (writeErr) {
          // the owed entry stays on the triggering row, so posture still shows it as owed but missing
          log?.error({ err: writeErr, subject, signoffId: s.id }, "ai-bom: could not record a failed sign-off snapshot");
        }
      }
    }
  }
  if (failed.length === 0) return null;
  return {
    code: "ai_bom_snapshot_failed",
    detail:
      "The sign-off was recorded, but the automatic AI BOM snapshot failed for the subjects listed. Each failure is audited " +
      "(ai-bom-snapshot-failed); an admin can take the snapshot on demand.",
    subjects: failed,
  };
}

// ---------------------------------------------------------------------------
// the subjects of each sign-off event (item 1)
// ---------------------------------------------------------------------------

const textArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

/**
 * The agents themselves, the use cases whose `intendedAgentIds` list any of
 * them, and (when asked) the builder agents whose `modelAgentId` is one of them.
 */
export async function agentSignoffSubjects(tx: Pick<Db, "select">, agentIds: readonly string[], opts: { builderAgents: boolean }): Promise<AiBomSubject[]> {
  const ids = [...new Set(agentIds)];
  if (ids.length === 0) return [];
  const live = await tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, ids));
  if (live.length === 0) return [];
  const liveIds = live.map((a) => a.id);
  const useCases = await tx.select({ id: aiUseCases.id }).from(aiUseCases).where(sql`${aiUseCases.intendedAgentIds} ?| ${textArray(liveIds)}::text[]`);
  const builders = opts.builderAgents ? await tx.select({ id: builderAgents.id }).from(builderAgents).where(inArray(builderAgents.modelAgentId, liveIds)) : [];
  return [
    ...liveIds.map((id) => ({ kind: "agent" as const, id })),
    ...useCases.map((u) => ({ kind: "use_case" as const, id: u.id })),
    ...builders.map((b) => ({ kind: "builder_agent" as const, id: b.id })),
  ];
}

/** model-card approval and evidence attached: an agent card covers its agent; a custom-provider card covers every agent on that provider */
export async function modelCardSignoffSubjects(tx: Pick<Db, "select">, card: { agentId: string | null; customProviderId: string | null }): Promise<AiBomSubject[]> {
  if (card.agentId) return agentSignoffSubjects(tx, [card.agentId], { builderAgents: true });
  if (!card.customProviderId) return [];
  const onProvider = await tx.select({ id: agents.id }).from(agents).where(eq(agents.customProviderId, card.customProviderId));
  return agentSignoffSubjects(tx, onProvider.map((a) => a.id), { builderAgents: true });
}

/** server admission: the install snapshot */
export const INSTALL_SIGNOFF_SUBJECTS: readonly AiBomSubject[] = Object.freeze([{ kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }]);
