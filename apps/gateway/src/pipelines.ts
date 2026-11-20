/**
 * ADR-0232 §2–§5, lane E49 slice 1 — the pipeline step catalogue and governed pipeline runs, on top of ADR-0341.
 *
 * ADR-0341 made the published workflow-template version the pipeline document. A pipeline run is one run of one such
 * version, and it executes THROUGH the workflow engine, never around it: the run is started by the engine's one
 * instance-creation path (`startWorkflowInstanceWithTemplates`, ADR-0080), with the same server-side change attributes
 * (initiator roles, project data sensitivity) and the same §8.3 compliance cascade `POST /v1/workflows/instances`
 * applies to an explicit template. Every stage is then run, gated and audited by the engine as for any instance.
 *
 * - Version binding: the run names a template version and starts only while that version is live (its content hash
 *   equals the live definition's), under the template's row lock, so a publish cannot slip in between the check and
 *   the start. A template never opened in the builder gets its baseline version first (ADR-0341 §3).
 * - Lifecycle: PIPELINE_RUN_MACHINE (ADR-0348). `requested` and the start/refuse move commit with the instance; the
 *   settling states are observed from the instance's terminal status on read and written once, guarded by `whereFrom`.
 * - Steps: the plan the run started with, one append-only row per stage with its catalogue class (ADR-0232 §2).
 * - Admin only, like an explicit-template start (`explicit_template_is_admin_only`): every route here is outside
 *   NON_ADMIN_ROUTES. Triggers other than manual are a later slice (ADR-0232 §12 slice 6).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  inArray,
  pipelineRuns,
  pipelineRunSteps,
  sql,
  workflowInstances,
  workflowTemplates,
  workflowTemplateVersions,
  type Db,
  type PipelineRunRow,
} from "@regulait/db";
import {
  changeDescriptorSchema,
  isIntakeTemplateName,
  PIPELINE_RUN_MACHINE,
  PIPELINE_STEP_CATALOGUE,
  PIPELINE_STEP_GROUPS,
  pipelineStepForStageType,
  type PipelineRunState,
} from "@regulait/shared";
import { isTerminalStatus, type InstanceState, type TerminalStatus, type WorkflowDefinition } from "@regulait/workflow-kernel";
import { SHADOW_AI_REMEDIATION_CHANGE_TYPE } from "./shadow-ai-remediation.js";
import { whereFrom } from "./state-transition.js";
import { definitionContentHash, ensureBaseline } from "./workflow-builder.js";
import { resolveServerChange, startWorkflowInstanceWithTemplates, withCascadeTemplates } from "./workflows.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";
import type { ListSpec } from "./list-contract.js";

export const PIPELINE_RULE_IDS = {
  started: "pipeline-run-started",
  refused: "pipeline-run-refused",
  finished: "pipeline-run-finished",
} as const;

/** the workflow instance's terminal status → the run event that settles it (a new terminal status is a compile error) */
const SETTLE_EVENT: Readonly<Record<TerminalStatus, "succeed" | "fail" | "cancel">> = {
  completed: "succeed",
  aborted: "cancel",
  denied: "fail",
  rolled_back: "fail",
};

const startRunSchema = z
  .object({
    templateId: z.string().uuid(),
    /** the published version to run; it must be the live one. Omitted: the live version. */
    version: z.number().int().min(1).optional(),
    change: changeDescriptorSchema,
    projectId: z.string().uuid().optional(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
  })
  .strict();
const runParam = z.object({ runId: z.string().uuid() }).strict();
const listFilters = z
  .object({
    runStatus: z.enum(PIPELINE_RUN_MACHINE.def.states as unknown as [PipelineRunState, ...PipelineRunState[]]).optional(),
    requestedBy: z.string().uuid().optional(),
  })
  .strict();

type Refusal = { status: number; body: Record<string, unknown> };
const refusalCodeOf = (body: Record<string, unknown>): string => {
  const e = typeof body.error === "string" ? body.error : "";
  return /^[a-z_]{1,64}$/.test(e) ? e : "start_refused";
};

async function audit(db: Db, userId: string, runId: string, ruleId: string, reason: string, detail: Record<string, unknown>, effect: "allow" | "deny" = "allow") {
  await db.insert(auditLog).values({ userId, objectType: "pipeline_run", objectId: runId, detail, effect, ruleId, ruleChain: [], reason });
}

/**
 * Settle the running runs whose workflow instance has ended: one guarded write per run (`whereFrom`), so a second
 * reader that settles the same run first leaves this one writing and auditing nothing. Returns the runs as they stand.
 */
async function settleRuns(db: Db, runs: PipelineRunRow[]): Promise<PipelineRunRow[]> {
  const running = runs.filter((r) => r.status === "running" && r.workflowInstanceId);
  if (running.length === 0) return runs;
  const instances = await db
    .select({ id: workflowInstances.id, status: workflowInstances.status })
    .from(workflowInstances)
    .where(inArray(workflowInstances.id, running.map((r) => r.workflowInstanceId!)));
  const statusOf = new Map(instances.map((i) => [i.id, i.status]));
  const settled = new Map<string, PipelineRunRow>();
  for (const r of running) {
    const instanceStatus = statusOf.get(r.workflowInstanceId!);
    const event = instanceStatus && isTerminalStatus(instanceStatus) ? SETTLE_EVENT[instanceStatus] : undefined;
    if (!event) continue;
    const to = PIPELINE_RUN_MACHINE.def.transitions[event].to;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .update(pipelineRuns)
        .set({ status: to, finishedAt: sql`now()` })
        .where(and(eq(pipelineRuns.id, r.id), whereFrom(pipelineRuns.status, PIPELINE_RUN_MACHINE, event)))
        .returning();
      if (!row) return null;
      await audit(tx, r.requestedBy, r.id, PIPELINE_RULE_IDS.finished, `pipeline run ${r.id} ${to}: its workflow instance ended ${instanceStatus}`, {
        status: to,
        instanceId: r.workflowInstanceId,
        instanceStatus,
      }, to === "succeeded" ? "allow" : "deny");
      return row;
    });
    if (out) settled.set(r.id, out);
  }
  if (settled.size === 0) return runs;
  // a run another reader settled first is re-read, so the answer is the state that stands
  const missed = running.filter((r) => !settled.has(r.id) && isTerminalStatus(statusOf.get(r.workflowInstanceId!) ?? ""));
  if (missed.length) {
    for (const row of await db.select().from(pipelineRuns).where(inArray(pipelineRuns.id, missed.map((r) => r.id)))) settled.set(row.id, row);
  }
  return runs.map((r) => settled.get(r.id) ?? r);
}

/** a run as the API answers it: the template it came from, the version and its hash, and its lifecycle */
async function decorateRuns(db: Db, runs: PipelineRunRow[]) {
  const versionIds = [...new Set(runs.map((r) => r.templateVersionId))];
  const versions = versionIds.length
    ? await db
        .select({ id: workflowTemplateVersions.id, version: workflowTemplateVersions.version, contentHash: workflowTemplateVersions.contentHash, templateId: workflowTemplates.id, templateName: workflowTemplates.name })
        .from(workflowTemplateVersions)
        .innerJoin(workflowTemplates, eq(workflowTemplates.id, workflowTemplateVersions.templateId))
        .where(inArray(workflowTemplateVersions.id, versionIds))
    : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  return runs.map((r) => {
    const v = byId.get(r.templateVersionId);
    return {
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      template: v ? { id: v.templateId, name: v.templateName, version: v.version, contentHash: v.contentHash } : null,
      workflowInstanceId: r.workflowInstanceId,
      requestedBy: r.requestedBy,
      projectId: r.projectId,
      idempotencyKey: r.idempotencyKey,
      refusalCode: r.refusalCode,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      lifecycle: PIPELINE_RUN_MACHINE.describe(r.status),
    };
  });
}
type RunView = Awaited<ReturnType<typeof decorateRuns>>[number];

export const PIPELINE_RUNS_LIST: ListSpec<RunView> = {
  id: "pipeline-runs",
  sorts: {
    created: { expr: pipelineRuns.createdAt, keysetAt: pipelineRuns.createdAt },
    status: { expr: pipelineRuns.status },
  },
  columns: {
    template: { label: "Template", value: (r) => r.template?.name ?? "" },
    version: { label: "Version", value: (r) => r.template?.version ?? null },
    status: { label: "Status", value: (r) => r.status },
    trigger: { label: "Trigger", value: (r) => r.trigger },
    created: { label: "Created", value: (r) => r.createdAt },
    finished: { label: "Finished", value: (r) => r.finishedAt },
  },
  filters: ["runStatus", "requestedBy"],
  defaultSort: { col: "created", dir: "desc" },
  idCol: pipelineRuns.id,
};

export function registerPipelineRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}) {
  app.get("/v1/pipelines/catalogue", async () => ({ groups: PIPELINE_STEP_GROUPS, steps: PIPELINE_STEP_CATALOGUE }));

  app.post("/v1/pipeline-runs", async (req, reply) => {
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_initiate", detail: "a pipeline run is started by a person; a token with no user identity cannot start one" });
    const parsed = startRunSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.slice(0, 20) });
    const body = parsed.data;
    if (body.change.changeType === SHADOW_AI_REMEDIATION_CHANGE_TYPE) {
      return reply.status(422).send({ error: "change_type_not_runnable", detail: "a shadow-AI remediation starts from its plan through the workflow start, not as a pipeline run" });
    }
    if (body.idempotencyKey) {
      const [prior] = await db.select().from(pipelineRuns).where(and(eq(pipelineRuns.requestedBy, userId), eq(pipelineRuns.idempotencyKey, body.idempotencyKey)));
      if (prior) {
        const [view] = await decorateRuns(db, await settleRuns(db, [prior]));
        return reply.status(200).send({ run: view, replayed: true });
      }
    }
    // the server-side change attributes and the §8.3 cascade, from the one helper the workflow start route uses
    const { change, cascadeTemplateIds } = await resolveServerChange(db, userId, body.change, body.projectId ?? null);

    const out = await db.transaction(async (rawTx): Promise<{ refusal: Refusal } | { run: PipelineRunRow; startRefusal: Refusal | null }> => {
      const tx = rawTx as unknown as Db;
      // the template's row lock: a publish (which takes the same lock) cannot replace the live definition between the
      // version check and the start, and two first runs cannot both record the baseline version
      const [t] = await tx.select().from(workflowTemplates).where(eq(workflowTemplates.id, body.templateId)).for("update");
      if (!t) return { refusal: { status: 404, body: { error: "unknown_template" } } };
      if (isIntakeTemplateName(t.name)) {
        return { refusal: { status: 409, body: { error: "intake_template_not_runnable", detail: "an intake template runs from the AI use-case registry, never as a pipeline run" } } };
      }
      const live = await ensureBaseline(tx, t, userId);
      const liveHash = definitionContentHash(t.definition);
      if (live.contentHash !== liveHash) {
        return { refusal: { status: 409, body: { error: "live_version_unrecorded", detail: "the live definition differs from its latest recorded version; publish it from the builder first" } } };
      }
      let version = live;
      if (body.version !== undefined && body.version !== live.version) {
        const [named] = await tx.select().from(workflowTemplateVersions).where(and(eq(workflowTemplateVersions.templateId, t.id), eq(workflowTemplateVersions.version, body.version)));
        if (!named) return { refusal: { status: 404, body: { error: "unknown_version" } } };
        version = named;
        if (named.contentHash !== liveHash) {
          return { refusal: { status: 409, body: { error: "version_not_live", liveVersion: live.version, detail: "only the live version runs: publish this version from the builder to run it" } } };
        }
      }
      const [run] = await tx
        .insert(pipelineRuns)
        .values({ templateVersionId: version.id, requestedBy: userId, projectId: body.projectId ?? null, idempotencyKey: body.idempotencyKey ?? null })
        .onConflictDoNothing({ target: [pipelineRuns.requestedBy, pipelineRuns.idempotencyKey] })
        .returning();
      if (!run) return { refusal: { status: 409, body: { error: "idempotency_key_in_use", detail: "a run with this idempotency key is being started; read it again" } } };

      // §8.3 cascade: a classified project's required templates join, as for an explicit-template start
      const templateIds = withCascadeTemplates([t.id], cascadeTemplateIds);
      const started = await startWorkflowInstanceWithTemplates(tx, opts.dataKey, {
        templateIds,
        initiatorUserId: userId,
        change,
        projectId: body.projectId ?? null,
        isAdmin: req.authCtx.isAdmin,
      });
      if (!started.ok) {
        const code = refusalCodeOf(started.body);
        const [refused] = await tx
          .update(pipelineRuns)
          .set({ status: "refused", refusalCode: code, finishedAt: sql`now()` })
          .where(and(eq(pipelineRuns.id, run.id), whereFrom(pipelineRuns.status, PIPELINE_RUN_MACHINE, "refuse")))
          .returning();
        await audit(tx, userId, run.id, PIPELINE_RULE_IDS.refused, `pipeline run of '${t.name}' v${version.version} refused by the workflow start: ${code}`, {
          templateId: t.id, version: version.version, contentHash: version.contentHash, refusal: code, httpStatus: started.status,
        }, "deny");
        return { run: refused!, startRefusal: { status: started.status, body: started.body } };
      }
      const [running] = await tx
        .update(pipelineRuns)
        .set({ status: "running", workflowInstanceId: started.instance.id, startedAt: sql`now()` })
        .where(and(eq(pipelineRuns.id, run.id), whereFrom(pipelineRuns.status, PIPELINE_RUN_MACHINE, "start")))
        .returning();
      const [instance] = await tx.select({ definition: workflowInstances.definition }).from(workflowInstances).where(eq(workflowInstances.id, started.instance.id));
      const stages = ((instance!.definition as WorkflowDefinition).stages ?? []) as Array<{ id: string; type: string }>;
      if (stages.length) {
        await tx.insert(pipelineRunSteps).values(
          stages.map((s, ordinal) => {
            const step = pipelineStepForStageType(s.type);
            // a stage type the catalogue does not know is recorded as a write that is never retried (fail closed)
            return { runId: run.id, ordinal, stageId: s.id, stepType: step?.id ?? s.type, writes: step?.writes ?? true, autoRetry: step?.autoRetry ?? false };
          }),
        );
      }
      await audit(tx, userId, run.id, PIPELINE_RULE_IDS.started, `pipeline run of '${t.name}' v${version.version} started as workflow instance ${started.instance.id}`, {
        templateId: t.id, version: version.version, contentHash: version.contentHash, instanceId: started.instance.id, templateIds,
      });
      return { run: running!, startRefusal: null };
    });
    if ("refusal" in out) return reply.status(out.refusal.status).send(out.refusal.body);
    const [view] = await decorateRuns(db, await settleRuns(db, [out.run]));
    // the engine's own refusal is answered as it gave it, with the refused run beside it
    if (out.startRefusal) return reply.status(out.startRefusal.status).send({ ...out.startRefusal.body, run: view });
    return reply.status(201).send({ run: view });
  });

  const runsList: ContractList<RunView, z.infer<typeof listFilters>> = {
    spec: PIPELINE_RUNS_LIST,
    filters: listFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db.select({ run: pipelineRuns, _cursorAt: q.cursorAt }).from(pipelineRuns).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset);
        const views = await decorateRuns(db, await settleRuns(db, rows.map((r) => r.run)));
        return views.map((v, i) => ({ ...v, _cursorAt: rows[i]!._cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(pipelineRuns).where(where),
      idOf: (r) => r.id,
    },
    where: (req: FastifyRequest, f) => {
      if (!req.authCtx.userId && !req.authCtx.isAdmin) return null;
      const conds = [
        ...(req.authCtx.isAdmin ? [] : [eq(pipelineRuns.requestedBy, req.authCtx.userId!)]),
        ...(f.runStatus ? [eq(pipelineRuns.status, f.runStatus)] : []),
        ...(f.requestedBy ? [eq(pipelineRuns.requestedBy, f.requestedBy)] : []),
      ];
      return conds.length ? and(...conds) : undefined;
    },
  };
  app.get("/v1/pipeline-runs", async (req, reply) => answerListPage(db, req, reply, runsList));

  app.get("/v1/pipeline-runs/:runId", async (req, reply) => {
    const p = runParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "unknown_pipeline_run" });
    const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, p.data.runId));
    // object-level authorisation: the requester or an admin; anyone else is told nothing exists
    if (!row || (!req.authCtx.isAdmin && row.requestedBy !== req.authCtx.userId)) return reply.status(404).send({ error: "unknown_pipeline_run" });
    const [view] = await decorateRuns(db, await settleRuns(db, [row]));
    const steps = await db.select().from(pipelineRunSteps).where(eq(pipelineRunSteps.runId, row.id)).orderBy(pipelineRunSteps.ordinal, desc(pipelineRunSteps.attempt));
    let state: InstanceState | null = null;
    let instanceStatus: string | null = null;
    if (row.workflowInstanceId) {
      const [i] = await db.select({ state: workflowInstances.state, status: workflowInstances.status }).from(workflowInstances).where(eq(workflowInstances.id, row.workflowInstanceId));
      state = (i?.state as InstanceState | undefined) ?? null;
      instanceStatus = i?.status ?? null;
    }
    return {
      run: view,
      instanceStatus,
      // each step's live status is read from the instance (the source of truth), never copied onto the step row
      steps: steps.map((s) => ({
        ordinal: s.ordinal,
        attempt: s.attempt,
        stageId: s.stageId,
        stepType: s.stepType,
        writes: s.writes,
        autoRetry: s.autoRetry,
        status: state?.stageStatuses?.[s.ordinal] ?? null,
        current: state ? state.currentStageIndex === s.ordinal : false,
      })),
    };
  });
}
