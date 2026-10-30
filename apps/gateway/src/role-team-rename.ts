/**
 * ADR-0206 G10 — RENAME ROLES AND TEAMS.
 *
 *   PATCH /v1/roles/:roleId  {name, description?, reason?, acknowledgeReferences?}
 *   PATCH /v1/teams/:teamId  {name, reason?, acknowledgeReferences?}
 *
 * Admin-only (neither is in NON_ADMIN_ROUTES). Grants, assignments, memberships and approval routing all hold the role
 * or team by id, so a rename changes none of them. Two things match by NAME instead, and a rename silently changes
 * which requests they apply to:
 *
 *  - access policies: the Cedar source of a policy's live version (or its latest, when none is live yet) can test
 *    `principal.roles` / `principal.teams`, which carry names (abac.ts). A policy whose source holds the old name as a
 *    string literal is listed.
 *  - routing rules: a workflow assignment rule's `initiator_role` is matched against the initiator's role NAMES
 *    (ADR-0018). Teams have no name-matched rule.
 *
 * An unreferenced rename just saves (audited). A referenced one is refused 409 `role_name_referenced` /
 * `team_name_referenced` with the policies and rules listed; the admin then sends `acknowledgeReferences: true` with
 * a reason (422 `rename_reason_required` without one) and a `settings_relax` step-up bound to {op, id, from, to}:
 * the rename can move a forbid policy off the people it was written for. The write re-reads the row and the
 * references under the row lock; if either moved, nothing is written (409 `changed_concurrently`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  abacPolicies,
  abacPolicyVersions,
  and,
  auditLog,
  desc,
  eq,
  ne,
  roles,
  sql,
  teams,
  workflowAssignmentRules,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import {
  RENAME_REFERENCE_LIST_MAX,
  renameRoleSchema,
  renameTeamSchema,
  type NameReference,
  type NameReferencedRefusal,
} from "@regulait/shared";
import { CHANGED_CONCURRENTLY, requireStepUp, type StepUpCheckArgs } from "./step-up.js";

type Noun = "role" | "team";
type DbOrTx = Pick<Db, "select">;

const NIL_USER = "00000000-0000-0000-0000-000000000000";
export const ROLE_RENAMED_RULE_ID = "role-renamed";
export const TEAM_RENAMED_RULE_ID = "team-renamed";

export interface NameReferences {
  policies: NameReference[];
  rules: NameReference[];
}

/** the old name as Cedar writes it in a string literal (Cedar escapes `"` and `\` as JSON does) */
function cedarLiteral(name: string): string {
  return JSON.stringify(name);
}

/**
 * The access policies and routing rules that match `name` by name. A policy counts on its live version, or on its
 * latest version while none is live (activating it later would otherwise pick up a name nobody was warned about).
 */
export async function findNameReferences(db: DbOrTx, noun: Noun, name: string): Promise<NameReferences> {
  const literal = cedarLiteral(name);
  const policyRows = await db
    .select({ id: abacPolicies.id, name: abacPolicies.name })
    .from(abacPolicies)
    .innerJoin(abacPolicyVersions, eq(abacPolicyVersions.policyId, abacPolicies.id))
    .where(
      and(
        sql`(${abacPolicies.activeVersionId} = ${abacPolicyVersions.id}
             OR (${abacPolicies.activeVersionId} IS NULL AND ${abacPolicyVersions.version} =
                 (SELECT max(v2."version") FROM "abac_policy_versions" v2 WHERE v2."policy_id" = ${abacPolicies.id})))`,
        sql`strpos(${abacPolicyVersions.source}, ${literal}) > 0`,
      ),
    )
    .orderBy(abacPolicies.name);
  const ruleRows =
    noun === "role"
      ? await db
          .select({ id: workflowAssignmentRules.id, templateName: workflowTemplates.name })
          .from(workflowAssignmentRules)
          .innerJoin(workflowTemplates, eq(workflowTemplates.id, workflowAssignmentRules.templateId))
          .where(eq(workflowAssignmentRules.initiatorRole, name))
          .orderBy(desc(workflowAssignmentRules.createdAt))
      : [];
  const policies = [...new Map(policyRows.map((p) => [p.id, p])).values()];
  return {
    policies,
    rules: ruleRows.map((r) => ({ id: r.id, name: `Assign workflow '${r.templateName}'` })),
  };
}

const referenceCount = (r: NameReferences) => r.policies.length + r.rules.length;

function referencedRefusal(noun: Noun, from: string, refs: NameReferences): NameReferencedRefusal {
  return {
    error: noun === "role" ? "role_name_referenced" : "team_name_referenced",
    policies: refs.policies.slice(0, RENAME_REFERENCE_LIST_MAX),
    rules: refs.rules.slice(0, RENAME_REFERENCE_LIST_MAX),
    policyCount: refs.policies.length,
    ruleCount: refs.rules.length,
    detail:
      `${noun} '${from}' is matched by name in ${refs.policies.length} access policy(ies) and ${refs.rules.length} ` +
      "routing rule(s); renaming changes which requests they apply to. Send acknowledgeReferences with a reason " +
      "(and confirm it's you) to rename anyway",
  };
}

/** the step-up a referenced rename needs, bound to exactly this rename */
export function renameStepUp(noun: Noun, id: string, from: string, to: string): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { op: `${noun}_rename_referenced`, id, from, to } };
}

const sameRefs = (a: NameReferences, b: NameReferences) =>
  JSON.stringify([a.policies.map((p) => p.id).sort(), a.rules.map((r) => r.id).sort()]) ===
  JSON.stringify([b.policies.map((p) => p.id).sort(), b.rules.map((r) => r.id).sort()]);

interface RenameArgs {
  noun: Noun;
  id: string;
  name: string;
  description?: string | null | undefined;
  reason?: string | undefined;
  acknowledgeReferences?: boolean | undefined;
}

async function rename(db: Db, req: FastifyRequest, reply: FastifyReply, args: RenameArgs) {
  const { noun, id } = args;
  const table = noun === "role" ? roles : teams;
  const [row] = await db.select().from(table).where(eq(table.id, id));
  if (!row) return reply.status(404).send({ error: noun === "role" ? "unknown_role" : "unknown_team" });
  const from = row.name;
  const to = args.name;
  const nameChanges = to !== from;
  if (nameChanges) {
    const [clash] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.name, to), ne(table.id, id)));
    if (clash) return reply.status(409).send({ error: "name_taken", detail: `a ${noun} called '${to}' already exists` });
  }
  const refs = nameChanges ? await findNameReferences(db, noun, from) : { policies: [], rules: [] };
  let stepUpMethod: string | null = null;
  if (referenceCount(refs) > 0) {
    if (!args.acknowledgeReferences) return reply.status(409).send(referencedRefusal(noun, from, refs));
    if (!args.reason) {
      return reply.status(422).send({
        error: "rename_reason_required",
        detail: "a rename the access policies or routing rules match on needs a recorded reason (10-500 characters)",
      });
    }
    const su = await requireStepUp(db, req, reply, renameStepUp(noun, id, from, to));
    if (!su.ok) return reply;
    stepUpMethod = su.method;
  }
  const actor = req.authCtx.userId ?? null;
  const out = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(table).where(eq(table.id, id)).for("update");
    if (!locked || locked.name !== from) return null;
    if (nameChanges && !sameRefs(refs, await findNameReferences(tx, noun, from))) return null;
    const patch: Record<string, unknown> = { name: to };
    if (noun === "role" && args.description !== undefined) patch.description = args.description;
    const [updated] = await tx.update(table).set(patch).where(eq(table.id, id)).returning();
    await tx.insert(auditLog).values({
      userId: actor ?? NIL_USER,
      objectType: noun,
      objectId: id,
      detail: {
        phase: `${noun}-renamed`,
        via: req.authCtx.via,
        from,
        to,
        ...(noun === "role" && args.description !== undefined ? { description: args.description } : {}),
        ...(referenceCount(refs) > 0
          ? {
              referencedPolicies: refs.policies.map((p) => p.id),
              referencedRules: refs.rules.map((r) => r.id),
              reason: args.reason,
              stepUp: stepUpMethod,
            }
          : {}),
      },
      effect: "allow",
      ruleId: noun === "role" ? ROLE_RENAMED_RULE_ID : TEAM_RENAMED_RULE_ID,
      ruleChain: [],
      reason:
        referenceCount(refs) > 0
          ? `${noun} '${from}' renamed to '${to}' while referenced by name in ${referenceCount(refs)} policy(ies)/rule(s): ${args.reason}`
          : nameChanges
            ? `${noun} '${from}' renamed to '${to}'`
            : `${noun} '${from}' description updated`,
    });
    return updated;
  }).catch((e: unknown) => {
    // a concurrent rename to the same name lands on the unique index
    if ((e as { code?: string }).code === "23505") return "taken" as const;
    throw e;
  });
  if (out === "taken") return reply.status(409).send({ error: "name_taken", detail: `a ${noun} called '${to}' already exists` });
  if (!out) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
  return reply.send(out);
}

const idParam = (key: "roleId" | "teamId") => z.object({ [key]: z.string().uuid() });

export function registerRoleTeamRenameRoutes(app: FastifyInstance, db: Db): void {
  app.patch("/v1/roles/:roleId", async (req, reply) => {
    const { roleId } = idParam("roleId").parse(req.params) as { roleId: string };
    const parsed = renameRoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    const b = parsed.data;
    return rename(db, req, reply, {
      noun: "role",
      id: roleId,
      name: b.name,
      ...(b.description !== undefined ? { description: b.description || null } : {}),
      reason: b.reason,
      acknowledgeReferences: b.acknowledgeReferences,
    });
  });

  app.patch("/v1/teams/:teamId", async (req, reply) => {
    const { teamId } = idParam("teamId").parse(req.params) as { teamId: string };
    const parsed = renameTeamSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    const b = parsed.data;
    return rename(db, req, reply, { noun: "team", id: teamId, name: b.name, reason: b.reason, acknowledgeReferences: b.acknowledgeReferences });
  });
}
