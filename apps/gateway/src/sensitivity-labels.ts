/**
 * ADR-0363 slice 1 — the customer's sensitivity labels at the gateway.
 *
 *   - Definitions arrive read-only through the `idp_entra` discovery scan (`ScanResult.labelDefinitions`), committed
 *     with the run by `upsertLabelDefinitions`. Nothing here talks to Graph: the scan already holds the credential,
 *     the federation, the throttle, the guarded fetch and the write-scope refusal (ADR-0195 decision 7).
 *   - The org's mapping (`sensitivity_label_rules`, `sensitivity_label_settings`) is read by `loadLabelPolicy`.
 *     Trusted tenants are the tenants whose definitions were synced: a label from any other tenant is unmapped.
 *   - `labelDispatchGate` runs in `dispatchAttempt` before the PII rung, on every image or document block of the
 *     request. A call with no file block reads nothing. A `block` refuses 403 before any provider work; a `redact`
 *     replaces the file with a text marker; a label mapped to a compliance profile pulls that profile into this call's
 *     cascade (PII mode and the guardrail floor), so it can only raise them.
 *
 * Audit: one row per gated call that carried a label or an unreadable/protected file, with label ids, actions and
 * sources only, never content.
 */
import {
  and,
  auditLog,
  complianceProfiles,
  eq,
  inArray,
  notInArray,
  sql,
  sensitivityLabelDefinitions,
  sensitivityLabelRules,
  sensitivityLabelSettings,
  type Db,
} from "@regulait/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_LABEL_POLICY,
  LABEL_ACTIONS,
  LABEL_DATA_SENSITIVITIES,
  decideLabels,
  labelPolicyRelaxes,
  readEmbeddedLabels,
  stricterAction,
  type LabelAction,
  type LabelDataSensitivity,
  type LabelDecision,
  type LabelDefinition,
  type LabelPolicy,
} from "@regulait/shared";
import type { ModelChatMessage, ModelContentBlock } from "@regulait/model-provider";
import { requireRelaxStepUp } from "./step-up.js";

export interface LoadedLabelPolicy extends LabelPolicy {
  /** rule label id -> the compliance tag its profile carries */
  complianceTags: ReadonlyMap<string, string>;
}

/** the org's label policy; with no rows it is the strict default (everything labelled or unreadable blocks) */
export async function loadLabelPolicy(db: Db): Promise<LoadedLabelPolicy> {
  const [settings, rules, tenants] = await Promise.all([
    db.select().from(sensitivityLabelSettings).where(eq(sensitivityLabelSettings.id, true)).then((r) => r[0]),
    db
      .select({
        provider: sensitivityLabelDefinitions.provider,
        labelId: sensitivityLabelDefinitions.labelId,
        action: sensitivityLabelRules.action,
        sensitivity: sensitivityLabelRules.sensitivity,
        complianceProfileId: sensitivityLabelRules.complianceProfileId,
        tag: complianceProfiles.tag,
      })
      .from(sensitivityLabelRules)
      .innerJoin(sensitivityLabelDefinitions, eq(sensitivityLabelDefinitions.id, sensitivityLabelRules.definitionId))
      .leftJoin(complianceProfiles, eq(complianceProfiles.id, sensitivityLabelRules.complianceProfileId)),
    db.selectDistinct({ tenantId: sensitivityLabelDefinitions.tenantId }).from(sensitivityLabelDefinitions),
  ]);
  const complianceTags = new Map<string, string>();
  for (const r of rules) if (r.tag) complianceTags.set(`${r.provider}:${r.labelId}`, r.tag);
  return {
    trustedTenantIds: tenants.map((t) => t.tenantId),
    rules: rules.map((r) => ({ provider: r.provider, labelId: r.labelId, action: r.action, sensitivity: r.sensitivity, complianceProfileId: r.complianceProfileId })),
    unmappedAction: settings?.unmappedAction ?? DEFAULT_LABEL_POLICY.unmappedAction,
    protectedAction: settings?.protectedAction ?? DEFAULT_LABEL_POLICY.protectedAction,
    unreadableAction: settings?.unreadableAction ?? DEFAULT_LABEL_POLICY.unreadableAction,
    complianceTags,
  };
}

/**
 * Commit one tenant's complete label list (inside the discovery run's fenced transaction). Labels the provider no
 * longer lists turn inactive; nothing is deleted, so a mapping keeps its target.
 */
export async function upsertLabelDefinitions(
  t: Db,
  args: { tenantId: string; sourceId: string | null; definitions: readonly LabelDefinition[] },
): Promise<{ upserted: number; deactivated: number }> {
  const tenantId = args.tenantId.toLowerCase();
  for (const d of args.definitions) {
    await t
      .insert(sensitivityLabelDefinitions)
      .values({
        provider: d.provider,
        tenantId,
        labelId: d.labelId,
        name: d.name,
        parentLabelId: d.parentLabelId,
        rank: d.rank,
        active: d.active,
        sourceId: args.sourceId,
        syncedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [sensitivityLabelDefinitions.provider, sensitivityLabelDefinitions.tenantId, sensitivityLabelDefinitions.labelId],
        set: {
          name: d.name,
          parentLabelId: d.parentLabelId,
          rank: d.rank,
          active: d.active,
          sourceId: args.sourceId,
          // the database clock stamps the sync (M-075)
          syncedAt: sql`now()`,
        },
      });
  }
  const listed = args.definitions.map((d) => d.labelId);
  const gone = await t
    .update(sensitivityLabelDefinitions)
    .set({ active: false })
    .where(
      and(
        eq(sensitivityLabelDefinitions.tenantId, tenantId),
        eq(sensitivityLabelDefinitions.active, true),
        ...(listed.length ? [notInArray(sensitivityLabelDefinitions.labelId, listed)] : []),
      ),
    )
    .returning({ id: sensitivityLabelDefinitions.id });
  return { upserted: args.definitions.length, deactivated: gone.length };
}

/** what the gate did to one file block, for the audit row */
interface FileVerdict {
  index: number;
  kind: "image" | "document";
  read: "labels" | "none" | "protected" | "unreadable";
  decision: LabelDecision;
}

export type LabelGateResult =
  | { kind: "none" }
  | {
      kind: "proceed";
      /** the messages to dispatch (files a `redact` decided replaced by a marker), or undefined when unchanged */
      messages: ModelChatMessage[] | undefined;
      /** the compliance tags the labels pulled into this call's cascade */
      complianceTags: string[];
      sensitivity: LabelDataSensitivity | null;
      auditLogId: string | null;
    }
  | { kind: "refuse"; status: 403; error: "sensitivity_label_blocked"; detail: string; auditLogId: string | null };

export const LABEL_REDACTED_MARKER = "[attachment withheld: its sensitivity label does not allow it to reach this model]";

const isFileBlock = (b: ModelContentBlock): b is Extract<ModelContentBlock, { type: "image" | "document" }> =>
  b.type === "image" || b.type === "document";

/** decode base64 without throwing; null when it is not base64 */
function decode(b64: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/**
 * The dispatch gate. Reads nothing when the request has no file block, so a text call costs nothing.
 */
export async function labelDispatchGate(
  db: Db,
  args: { userId: string; agentId: string; projectId: string | null; messages: ModelChatMessage[] | undefined },
): Promise<LabelGateResult> {
  const messages = args.messages ?? [];
  const hasFile = messages.some((m) => Array.isArray(m.content) && m.content.some(isFileBlock));
  if (!hasFile) return { kind: "none" };

  const policy = await loadLabelPolicy(db);
  const verdicts: FileVerdict[] = [];
  let index = 0;
  let action = "allow" as LabelAction;
  let sensitivity = null as LabelDataSensitivity | null;
  const tags = new Set<string>();
  const out: ModelChatMessage[] = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((b) => {
      if (!isFileBlock(b)) return b;
      const bytes = decode(b.dataBase64);
      const read = bytes ? readEmbeddedLabels(bytes, b.mediaType) : ({ kind: "unreadable", reason: "corrupt" } as const);
      const decision = decideLabels(read, policy);
      verdicts.push({ index: index++, kind: b.type, read: read.kind, decision });
      action = stricterAction(action, decision.action);
      if (decision.sensitivity && (!sensitivity || rank(decision.sensitivity) > rank(sensitivity))) sensitivity = decision.sensitivity;
      for (const r of decision.reasons) {
        if (r.kind !== "mapped") continue;
        const tag = policy.complianceTags.get(`${r.provider}:${r.labelId}`);
        if (tag) tags.add(tag);
      }
      if (decision.action === "redact") return { type: "text" as const, text: LABEL_REDACTED_MARKER };
      return b;
    });
    return { ...m, content } as ModelChatMessage;
  });

  const notable = verdicts.filter((v) => v.read !== "none");
  if (notable.length === 0) return { kind: "none" };

  const blocked = action === "block";
  const reason = blocked
    ? `input blocked: ${notable.filter((v) => v.decision.action === "block").length} attached file(s) carry a sensitivity label (or cannot be read) that may not reach an external model`
    : `sensitivity labels read on ${notable.length} attached file(s): ${action}`;
  const [row] = await db
    .insert(auditLog)
    .values({
      userId: args.userId,
      objectType: "agent",
      objectId: args.agentId,
      detail: {
        phase: "sensitivity_label",
        sensitivityLabels: {
          action,
          sensitivity,
          complianceTags: [...tags].sort(),
          files: notable.map((v) => ({ index: v.index, kind: v.kind, read: v.read, action: v.decision.action, reasons: v.decision.reasons })),
        },
        ...(args.projectId ? { projectId: args.projectId } : {}),
        receiptClass: "decision",
      },
      effect: blocked ? "deny" : "allow",
      ruleId: blocked ? "sensitivity-label-blocked" : "sensitivity-label-read",
      ruleChain: [],
      reason,
    })
    .returning({ id: auditLog.id });
  const auditLogId = row?.id ?? null;
  if (blocked) return { kind: "refuse", status: 403, error: "sensitivity_label_blocked", detail: reason, auditLogId };
  return {
    kind: "proceed",
    messages: action === "redact" ? out : undefined,
    complianceTags: [...tags].sort(),
    sensitivity,
    auditLogId,
  };
}

const SENS = ["public", "internal", "confidential", "restricted"] as const;
const rank = (s: LabelDataSensitivity) => SENS.indexOf(s);

/** the definitions for the admin list (active first) */
export async function listLabelDefinitions(db: Db, ids?: string[]) {
  const q = db
    .select({
      id: sensitivityLabelDefinitions.id,
      provider: sensitivityLabelDefinitions.provider,
      tenantId: sensitivityLabelDefinitions.tenantId,
      labelId: sensitivityLabelDefinitions.labelId,
      name: sensitivityLabelDefinitions.name,
      parentLabelId: sensitivityLabelDefinitions.parentLabelId,
      rank: sensitivityLabelDefinitions.rank,
      active: sensitivityLabelDefinitions.active,
      syncedAt: sensitivityLabelDefinitions.syncedAt,
      action: sensitivityLabelRules.action,
      sensitivity: sensitivityLabelRules.sensitivity,
      complianceProfileId: sensitivityLabelRules.complianceProfileId,
    })
    .from(sensitivityLabelDefinitions)
    .leftJoin(sensitivityLabelRules, eq(sensitivityLabelRules.definitionId, sensitivityLabelDefinitions.id));
  return ids ? q.where(inArray(sensitivityLabelDefinitions.id, ids)) : q;
}

// ---------------------------------------------------------------------------------------------------------------
// Admin routes (admin-only: none is in NON_ADMIN_ROUTES). The UI is a known gap (#453); these are the API.
// ---------------------------------------------------------------------------------------------------------------

export const SENSITIVITY_LABELS_PATH = "/v1/sensitivity-labels";
export const SENSITIVITY_LABEL_SETTINGS_PATH = "/v1/sensitivity-labels/settings";
export const SENSITIVITY_LABEL_RULE_PATH = "/v1/sensitivity-labels/:definitionId/rule";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const actionSchema = z.enum(LABEL_ACTIONS);
const ruleBody = z
  .object({
    action: actionSchema,
    sensitivity: z.enum(LABEL_DATA_SENSITIVITIES),
    complianceProfileId: z.string().uuid().nullable().optional(),
  })
  .strict();
const settingsBody = z
  .object({ unmappedAction: actionSchema.optional(), protectedAction: actionSchema.optional(), unreadableAction: actionSchema.optional() })
  .strict();
const idParam = z.object({ definitionId: z.string().uuid() });

function settingsView(p: LabelPolicy) {
  return {
    unmappedAction: p.unmappedAction,
    protectedAction: p.protectedAction,
    unreadableAction: p.unreadableAction,
    strictDefault:
      p.unmappedAction === DEFAULT_LABEL_POLICY.unmappedAction &&
      p.protectedAction === DEFAULT_LABEL_POLICY.protectedAction &&
      p.unreadableAction === DEFAULT_LABEL_POLICY.unreadableAction,
  };
}

/** the label-policy facts a relaxation binds to its step-up (ids and actions, never content) */
function relaxFacts(prev: LabelPolicy, next: LabelPolicy): Record<string, unknown> {
  if (!labelPolicyRelaxes(prev, next)) return {};
  return {
    "sensitivityLabels.unmappedAction": next.unmappedAction,
    "sensitivityLabels.protectedAction": next.protectedAction,
    "sensitivityLabels.unreadableAction": next.unreadableAction,
    "sensitivityLabels.rules": next.rules.map((r) => `${r.labelId}:${r.action}:${r.sensitivity}:${r.complianceProfileId ?? "-"}`).sort(),
  };
}

export function registerSensitivityLabelRoutes(app: FastifyInstance, db: Db): void {
  app.get(SENSITIVITY_LABELS_PATH, async () => {
    const [policy, labels] = await Promise.all([loadLabelPolicy(db), listLabelDefinitions(db)]);
    return {
      settings: settingsView(policy),
      trustedTenantIds: policy.trustedTenantIds,
      labels: labels
        .sort((a, b) => Number(b.active) - Number(a.active) || (b.rank ?? -1) - (a.rank ?? -1) || a.name.localeCompare(b.name))
        .map((l) => ({
          ...l,
          syncedAt: l.syncedAt.toISOString(),
          rule: l.action ? { action: l.action, sensitivity: l.sensitivity, complianceProfileId: l.complianceProfileId } : null,
          action: undefined,
          sensitivity: undefined,
          complianceProfileId: undefined,
        })),
    };
  });

  app.put(SENSITIVITY_LABEL_SETTINGS_PATH, async (req, reply) => {
    const body = settingsBody.parse(req.body ?? {});
    const prev = await loadLabelPolicy(db);
    const next: LabelPolicy = { ...prev, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    if (!(await requireRelaxStepUp(db, req, reply, relaxFacts(prev, next)))) return reply;
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    await db.transaction(async (tx) => {
      await tx
        .insert(sensitivityLabelSettings)
        .values({ id: true, unmappedAction: next.unmappedAction, protectedAction: next.protectedAction, unreadableAction: next.unreadableAction, updatedBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({
          target: sensitivityLabelSettings.id,
          set: { unmappedAction: next.unmappedAction, protectedAction: next.protectedAction, unreadableAction: next.unreadableAction, updatedBy: req.authCtx.userId ?? null, updatedAt: sql`now()` },
        });
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "org_settings",
        objectId: null,
        detail: { via: req.authCtx.via, setting: "sensitivityLabels", from: settingsView(prev), to: settingsView(next) },
        effect: "allow",
        ruleId: labelPolicyRelaxes(prev, next) ? "sensitivity-label-settings-relaxed" : "sensitivity-label-settings-set",
        ruleChain: [],
        reason: `sensitivity label fallbacks set: unmapped ${next.unmappedAction}, protected ${next.protectedAction}, unreadable ${next.unreadableAction}`,
      });
    });
    return settingsView(next);
  });

  app.put(SENSITIVITY_LABEL_RULE_PATH, async (req, reply) => {
    const { definitionId } = idParam.parse(req.params);
    const body = ruleBody.parse(req.body ?? {});
    const [def] = await listLabelDefinitions(db, [definitionId]);
    if (!def) return reply.status(404).send({ error: "label_not_found" });
    if (body.complianceProfileId) {
      const [p] = await db.select({ id: complianceProfiles.id }).from(complianceProfiles).where(eq(complianceProfiles.id, body.complianceProfileId));
      if (!p) return reply.status(422).send({ error: "compliance_profile_not_found" });
    }
    const prev = await loadLabelPolicy(db);
    const rule = { provider: def.provider, labelId: def.labelId, action: body.action, sensitivity: body.sensitivity, complianceProfileId: body.complianceProfileId ?? null };
    const next: LabelPolicy = { ...prev, rules: [...prev.rules.filter((r) => !(r.provider === def.provider && r.labelId === def.labelId)), rule] };
    if (!(await requireRelaxStepUp(db, req, reply, relaxFacts(prev, next)))) return reply;
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    const values = { action: body.action, sensitivity: body.sensitivity, complianceProfileId: body.complianceProfileId ?? null, updatedBy: req.authCtx.userId ?? null };
    await db.transaction(async (tx) => {
      await tx
        .insert(sensitivityLabelRules)
        .values({ definitionId, ...values })
        .onConflictDoUpdate({ target: sensitivityLabelRules.definitionId, set: { ...values, updatedAt: sql`now()` } });
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "org_settings",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          setting: "sensitivityLabels.rule",
          definitionId,
          labelId: def.labelId,
          provider: def.provider,
          from: def.action ? { action: def.action, sensitivity: def.sensitivity, complianceProfileId: def.complianceProfileId } : null,
          to: values,
        },
        effect: "allow",
        ruleId: labelPolicyRelaxes(prev, next) ? "sensitivity-label-rule-relaxed" : "sensitivity-label-rule-set",
        ruleChain: [],
        reason: `label '${def.name}' mapped to ${body.action} (${body.sensitivity})`,
      });
    });
    return reply.status(200).send({ definitionId, rule: values });
  });

  app.delete(SENSITIVITY_LABEL_RULE_PATH, async (req, reply) => {
    const { definitionId } = idParam.parse(req.params);
    const [def] = await listLabelDefinitions(db, [definitionId]);
    if (!def) return reply.status(404).send({ error: "label_not_found" });
    if (!def.action) return reply.status(204).send();
    const prev = await loadLabelPolicy(db);
    const next: LabelPolicy = { ...prev, rules: prev.rules.filter((r) => !(r.provider === def.provider && r.labelId === def.labelId)) };
    // the label falls back to `unmappedAction` (and loses any compliance profile): looser than the rule = a relaxation
    const relaxes = labelPolicyRelaxes(prev, next);
    if (!(await requireRelaxStepUp(db, req, reply, relaxFacts(prev, next)))) return reply;
    await db.transaction(async (tx) => {
      await tx.delete(sensitivityLabelRules).where(eq(sensitivityLabelRules.definitionId, definitionId));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { via: req.authCtx.via, setting: "sensitivityLabels.rule", definitionId, labelId: def.labelId, provider: def.provider, from: { action: def.action, sensitivity: def.sensitivity, complianceProfileId: def.complianceProfileId }, to: null },
        effect: "allow",
        ruleId: relaxes ? "sensitivity-label-rule-relaxed" : "sensitivity-label-rule-removed",
        ruleChain: [],
        reason: `label '${def.name}' unmapped: it now falls to the unmapped action (${prev.unmappedAction})`,
      });
    });
    return reply.status(204).send();
  });
}
