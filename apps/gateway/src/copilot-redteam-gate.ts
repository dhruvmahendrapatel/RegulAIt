/**
 * ADR-0056 §5 amendment (2026-11-14, lane L7) — THE COPILOT IS ENROLLED IN RED-TEAMING, WITH A PROMOTION GATE.
 *
 * §5 says the copilot is "enrolled in continuous red-teaming (ADR-0057): prompt-injection, data-exfil and PII-leak
 * probes are part of its regression suite, and a regression blocks its promotion". Its context IS the audit log, so a
 * crafted log entry is an injection vector. Until now nothing tied a narrator model to any red-team result.
 *
 * As built, a model may narrate a copilot answer only on the strength of its DECIDING RUN: the most recent finished
 * ADR-0057 red-team run of the agent that touched any copilot class (gated on one, or measured a probe in one). That
 * run must:
 *   - have measured at least one probe in EACH of `COPILOT_REDTEAM_CLASSES` (a class with no probe, or whose probes
 *     were all `not_run`, is not evidence and refuses: fail closed);
 *   - reach `copilotRedteamMinResistRate` in each of those classes (strict 1: every measured probe resisted),
 *     judged HERE from the run's stored, measured class summary. The run's own `gate_passed` is NOT trusted: its
 *     starter chooses the tolerance, the floors and whether a baseline is required, and a first run passes as a
 *     reference (review of #811);
 *   - have been run against the model and the system prompt the agent serves now;
 *   - have finished within `copilotRedteamMaxAgeDays` (continuous: an old pass lapses).
 * A later run that touches a copilot class replaces an earlier one, so a regression blocks promotion.
 *
 * The run itself is an ordinary red-team run (`POST /v1/redteam/runs`), so the scheduled sweep (ADR-0064) re-probes
 * an enrolled narrator like any pair a person chose, and the ADR-0217 re-test repeats it after a model change.
 *
 * Strict by default. Turning the gate off, lengthening the window or lowering the floor is a `settings_relax`
 * step-up, made by a named person (never the identity-less bootstrap), audited with what it relaxed. A refused
 * narration leaves the grounded, count-derived answer path untouched: only the MODEL half is held.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  auditLog,
  desc,
  eq,
  isNotNull,
  orgSettings,
  redteamRuns,
  sql,
  type Db,
} from "@regulait/db";
import type { RedTeamAttackClass, RedTeamClassAggregate } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";
import { hashPrompt } from "./prompt-hash.js";

/** ADR-0056 §5: the classes the copilot's regression suite must measure */
export const COPILOT_REDTEAM_CLASSES: readonly RedTeamAttackClass[] = [
  "prompt_injection",
  "indirect_prompt_injection",
  "data_exfiltration",
  "pii_leak",
];

export const COPILOT_REDTEAM_RULE_IDS = {
  refused: "copilot-narrator-redteam-required",
  settings: "copilot-redteam-gate-settings",
} as const;

export const COPILOT_REDTEAM_MAX_AGE_LIMIT_DAYS = 365;

const DAY_MS = 86_400_000;
const ORG_SETTINGS_ID = "singleton";

export type CopilotRedteamVerdict =
  | { allowed: true; runId: string | null; reason: string }
  | { allowed: false; runId: string | null; reason: string };

/** what the gate reads from the deciding run (never its own gate verdict) */
export interface DecidingRunFacts {
  id: string;
  model: string | null;
  systemPromptHash: string | null;
  classSummary: readonly Pick<RedTeamClassAggregate, "attackClass" | "probes" | "resistRate">[];
  finishedAt: Date | null;
}

export interface CopilotRedteamOptions {
  enabled: boolean;
  maxAgeDays: number;
  minResistRate: number;
  now: Date;
}

const NEED =
  `a red-team run of the agent measuring ${COPILOT_REDTEAM_CLASSES.join(", ")} against the model and system prompt ` +
  `it serves now (POST /v1/redteam/runs with a library that has probes in each)`;

/**
 * Pure: the verdict over the agent's deciding run (or null when it has none). Exported for the unit test; the gate
 * below loads the facts.
 */
export function copilotRedteamVerdict(
  agent: { name: string; model: string | null; systemPromptHash: string | null },
  run: DecidingRunFacts | null,
  opts: CopilotRedteamOptions,
): CopilotRedteamVerdict {
  if (!opts.enabled) {
    return { allowed: true, runId: null, reason: "the copilot red-team gate is turned off by an admin (audited)" };
  }
  if (!run || !run.finishedAt) {
    return { allowed: false, runId: null, reason: `model '${agent.name}' is not enrolled in the copilot's red-team suite: it needs ${NEED}` };
  }
  const refuse = (reason: string): CopilotRedteamVerdict => ({ allowed: false, runId: run.id, reason });
  for (const cls of COPILOT_REDTEAM_CLASSES) {
    const agg = run.classSummary.find((c) => c.attackClass === cls);
    if (!agg || agg.probes < 1) {
      return refuse(
        `model '${agent.name}''s latest copilot red-team run measured no '${cls}' probe (the class had no probes, or ` +
          `none ran), so it is not evidence: it needs ${NEED}`,
      );
    }
    if (agg.resistRate < opts.minResistRate) {
      return refuse(
        `model '${agent.name}' resisted ${Math.round(agg.resistRate * 100)}% of '${cls}' probes on its latest ` +
          `copilot red-team run, below the ${Math.round(opts.minResistRate * 100)}% the copilot requires; a ` +
          `regression blocks its promotion to copilot narrator until a later run reaches it`,
      );
    }
  }
  if (run.model !== agent.model) {
    return refuse(
      `model '${agent.name}' was last red-teamed for the copilot against '${run.model ?? "unknown"}', but now serves ` +
        `'${agent.model ?? "unknown"}': it needs ${NEED}`,
    );
  }
  if ((run.systemPromptHash ?? null) !== (agent.systemPromptHash ?? null)) {
    return refuse(
      `model '${agent.name}''s system prompt has changed since its latest copilot red-team run, which changes its ` +
        `injection resistance: it needs ${NEED}`,
    );
  }
  const ageDays = (opts.now.getTime() - run.finishedAt.getTime()) / DAY_MS;
  if (ageDays > opts.maxAgeDays) {
    return refuse(
      `model '${agent.name}''s latest copilot red-team run is ${Math.floor(ageDays)} days old, over the ` +
        `${opts.maxAgeDays}-day window: it needs a fresh run`,
    );
  }
  return { allowed: true, runId: run.id, reason: "its latest copilot red-team run measured every copilot class above the floor" };
}

/**
 * The agent's deciding run: the most recent finished red-team run that gated on, or measured a probe in, any copilot
 * class. Filtered and limited in SQL over the (agent_id, started_at) index; runs finish in the order they start, and
 * the gate judges the newest started (a later, still-running run does not count until it finishes).
 */
async function decidingRun(db: Db, agentId: string): Promise<DecidingRunFacts | null> {
  const classes = sql.raw(`ARRAY[${COPILOT_REDTEAM_CLASSES.map((c) => `'${c}'`).join(", ")}]`);
  const [row] = await db
    .select({
      id: redteamRuns.id,
      model: redteamRuns.model,
      systemPromptHash: redteamRuns.systemPromptHash,
      classSummary: redteamRuns.classSummary,
      finishedAt: redteamRuns.finishedAt,
    })
    .from(redteamRuns)
    .where(
      and(
        eq(redteamRuns.agentId, agentId),
        isNotNull(redteamRuns.finishedAt),
        sql`(${redteamRuns.gatingClasses} ?| ${classes} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(${redteamRuns.classSummary}) e WHERE e->>'attackClass' = ANY(${classes})
        ))`,
      ),
    )
    .orderBy(desc(redteamRuns.startedAt), desc(redteamRuns.id))
    .limit(1);
  if (!row) return null;
  return { ...row, classSummary: (row.classSummary ?? []) as DecidingRunFacts["classSummary"] };
}

/** the verdict for one narrator agent, read from the database */
export async function copilotNarratorRedteamGate(
  db: Db,
  agent: { id: string; name: string; model: string | null; systemPrompt: string | null },
  now: Date = new Date(),
): Promise<CopilotRedteamVerdict> {
  const org = await loadOrgSettings(db);
  const opts = {
    enabled: org.copilotRedteamGateEnabled,
    maxAgeDays: org.copilotRedteamMaxAgeDays,
    minResistRate: org.copilotRedteamMinResistRate,
    now,
  };
  const subject = { name: agent.name, model: agent.model, systemPromptHash: hashPrompt(agent.systemPrompt) };
  if (!opts.enabled) return copilotRedteamVerdict(subject, null, opts);
  return copilotRedteamVerdict(subject, await decidingRun(db, agent.id), opts);
}

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().int().min(1).max(COPILOT_REDTEAM_MAX_AGE_LIMIT_DAYS).optional(),
    minResistRate: z.number().min(0).max(1).optional(),
  })
  .strict();

const statusQuery = z.object({ agentId: z.string().uuid().optional() }).strict();

type GateSettings = { copilotRedteamGateEnabled: boolean; copilotRedteamMaxAgeDays: number; copilotRedteamMinResistRate: number };

function settingsView(o: GateSettings) {
  return {
    enabled: o.copilotRedteamGateEnabled,
    maxAgeDays: o.copilotRedteamMaxAgeDays,
    minResistRate: o.copilotRedteamMinResistRate,
    requiredClasses: COPILOT_REDTEAM_CLASSES,
  };
}

/** what a settings change relaxes: turning the gate off, a longer window, or a lower floor */
export function copilotRedteamRelaxed(body: z.infer<typeof settingsSchema>, org: GateSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.enabled === false && org.copilotRedteamGateEnabled) out.copilotRedteamGateEnabled = false;
  if (body.maxAgeDays !== undefined && body.maxAgeDays > org.copilotRedteamMaxAgeDays) {
    out.copilotRedteamMaxAgeDays = body.maxAgeDays;
  }
  if (body.minResistRate !== undefined && body.minResistRate < org.copilotRedteamMinResistRate) {
    out.copilotRedteamMinResistRate = body.minResistRate;
  }
  return out;
}

export function registerCopilotRedteamGateRoutes(app: FastifyInstance, db: Db) {
  // admin (not in the non-admin route list): the settings and, for one agent, its verdict
  app.get("/v1/copilot/redteam-gate", async (req, reply) => {
    const parsed = statusQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query" });
    const org = await loadOrgSettings(db);
    if (!parsed.data.agentId) return { settings: settingsView(org) };
    const [agent] = await db
      .select({ id: agents.id, name: agents.name, model: agents.model, systemPrompt: agents.systemPrompt })
      .from(agents)
      .where(eq(agents.id, parsed.data.agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    return { settings: settingsView(org), agentId: agent.id, verdict: await copilotNarratorRedteamGate(db, agent) };
  });

  app.put("/v1/copilot/redteam-gate", async (req, reply) => {
    // every change is tied to a named person (the identity-less bootstrap token cannot make one)
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_change_copilot_redteam_gate" });
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues });
    const body = parsed.data;
    const org = await loadOrgSettings(db);
    const relaxed = copilotRedteamRelaxed(body, org);
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const patch = {
      ...(body.enabled !== undefined ? { copilotRedteamGateEnabled: body.enabled } : {}),
      ...(body.maxAgeDays !== undefined ? { copilotRedteamMaxAgeDays: body.maxAgeDays } : {}),
      ...(body.minResistRate !== undefined ? { copilotRedteamMinResistRate: body.minResistRate } : {}),
    };
    if (Object.keys(patch).length === 0) return settingsView(org);
    const updated = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // compare-and-set on the values the step-up was decided on
      const [row] = await tx
        .update(orgSettings)
        .set({ ...patch, updatedBy: userId, updatedAt: new Date() })
        .where(
          and(
            eq(orgSettings.id, ORG_SETTINGS_ID),
            eq(orgSettings.copilotRedteamGateEnabled, org.copilotRedteamGateEnabled),
            eq(orgSettings.copilotRedteamMaxAgeDays, org.copilotRedteamMaxAgeDays),
            eq(orgSettings.copilotRedteamMinResistRate, org.copilotRedteamMinResistRate),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId,
        objectType: "org_settings",
        objectId: null,
        detail: {
          phase: "copilot-redteam-gate",
          transitions: settingTransitions(org, patch),
          relaxed: Object.keys(relaxed),
        },
        effect: "allow",
        ruleId: COPILOT_REDTEAM_RULE_IDS.settings,
        ruleChain: [],
        reason:
          `copilot red-team gate ${row.copilotRedteamGateEnabled ? "on" : "off"}; a narrator's deciding run counts ` +
          `for ${row.copilotRedteamMaxAgeDays} days and must resist at least ` +
          `${Math.round(row.copilotRedteamMinResistRate * 100)}% of each copilot class`,
      });
      return row;
    });
    if (!updated) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return settingsView(updated);
  });
}
