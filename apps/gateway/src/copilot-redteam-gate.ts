/**
 * ADR-0056 §5 amendment (2026-11-14, lane L7) — THE COPILOT IS ENROLLED IN RED-TEAMING, WITH A PROMOTION GATE.
 *
 * §5 says the copilot is "enrolled in continuous red-teaming (ADR-0057): prompt-injection, data-exfil and PII-leak
 * probes are part of its regression suite, and a regression blocks its promotion". Its context IS the audit log, so a
 * crafted log entry is an injection vector. Until now nothing tied a narrator model to any red-team result.
 *
 * As built: a model may narrate a copilot answer only when its LATEST finished ADR-0057 red-team run that gated on
 * every class in `COPILOT_REDTEAM_CLASSES`:
 *   - was run against the model the agent serves NOW (a run against an earlier model version does not count),
 *   - passed its gate (a later run that regressed or failed replaces an earlier pass: that is the promotion block),
 *   - finished within `copilotRedteamMaxAgeDays` (continuous: an old pass lapses).
 * The run itself is an ordinary red-team run (`POST /v1/redteam/runs` with those gating classes), so the scheduled
 * sweep (ADR-0064) re-probes an enrolled narrator like any pair a person chose, and the ADR-0217 re-test repeats it
 * after a model change.
 *
 * Strict by default (`copilotRedteamGateEnabled` true). Turning it off, or lengthening the window, is a
 * `settings_relax` step-up, audited. A refused narration leaves the grounded, count-derived answer path untouched:
 * only the MODEL half is held, and the refusal is audited with the run that decided it.
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
  type Db,
} from "@regulait/db";
import type { RedTeamAttackClass } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { CHANGED_CONCURRENTLY, requireRelaxStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";

/** ADR-0056 §5: the classes the copilot's regression suite must gate on */
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

interface RunFacts {
  id: string;
  model: string | null;
  gatingClasses: string[];
  gatePassed: boolean | null;
  finishedAt: Date | null;
}

/**
 * Pure: the verdict over an agent's finished red-team runs (newest first). Exported for the unit test; the gate
 * below loads the facts.
 */
export function copilotRedteamVerdict(
  agent: { name: string; model: string | null },
  runs: readonly RunFacts[],
  opts: { enabled: boolean; maxAgeDays: number; now: Date },
): CopilotRedteamVerdict {
  if (!opts.enabled) {
    return { allowed: true, runId: null, reason: "the copilot red-team gate is turned off by an admin (audited)" };
  }
  const covering = runs.find((r) => r.finishedAt && COPILOT_REDTEAM_CLASSES.every((c) => r.gatingClasses.includes(c)));
  const need =
    `a red-team run gating on ${COPILOT_REDTEAM_CLASSES.join(", ")} that passes against the model it serves now ` +
    `(POST /v1/redteam/runs with those gatingClasses)`;
  if (!covering) {
    return {
      allowed: false,
      runId: null,
      reason: `model '${agent.name}' is not enrolled in the copilot's red-team suite: it needs ${need}`,
    };
  }
  if (covering.model !== agent.model) {
    return {
      allowed: false,
      runId: covering.id,
      reason:
        `model '${agent.name}' was last red-teamed for the copilot against '${covering.model ?? "unknown"}', ` +
        `but now serves '${agent.model ?? "unknown"}': it needs ${need}`,
    };
  }
  if (covering.gatePassed !== true) {
    return {
      allowed: false,
      runId: covering.id,
      reason:
        `model '${agent.name}' failed (or regressed on) its latest copilot red-team run, which blocks its promotion ` +
        `to copilot narrator until a later run passes`,
    };
  }
  const ageDays = (opts.now.getTime() - covering.finishedAt!.getTime()) / DAY_MS;
  if (ageDays > opts.maxAgeDays) {
    return {
      allowed: false,
      runId: covering.id,
      reason:
        `model '${agent.name}''s latest passing copilot red-team run is ${Math.floor(ageDays)} days old, over the ` +
        `${opts.maxAgeDays}-day window: it needs a fresh run`,
    };
  }
  return { allowed: true, runId: covering.id, reason: "passed its latest copilot red-team run" };
}

/** the verdict for one narrator agent, read from the database */
export async function copilotNarratorRedteamGate(
  db: Db,
  agent: { id: string; name: string; model: string | null },
  now: Date = new Date(),
): Promise<CopilotRedteamVerdict> {
  const org = await loadOrgSettings(db);
  if (!org.copilotRedteamGateEnabled) {
    return copilotRedteamVerdict(agent, [], { enabled: false, maxAgeDays: org.copilotRedteamMaxAgeDays, now });
  }
  const runs = await db
    .select({
      id: redteamRuns.id,
      model: redteamRuns.model,
      gatingClasses: redteamRuns.gatingClasses,
      gatePassed: redteamRuns.gatePassed,
      finishedAt: redteamRuns.finishedAt,
    })
    .from(redteamRuns)
    .where(and(eq(redteamRuns.agentId, agent.id), isNotNull(redteamRuns.finishedAt)))
    .orderBy(desc(redteamRuns.finishedAt), desc(redteamRuns.id))
    .limit(200);
  return copilotRedteamVerdict(
    agent,
    runs.map((r) => ({ ...r, gatingClasses: (r.gatingClasses ?? []) as string[] })),
    { enabled: true, maxAgeDays: org.copilotRedteamMaxAgeDays, now },
  );
}

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().int().min(1).max(COPILOT_REDTEAM_MAX_AGE_LIMIT_DAYS).optional(),
  })
  .strict();

const statusQuery = z.object({ agentId: z.string().uuid().optional() }).strict();

function settingsView(o: { copilotRedteamGateEnabled: boolean; copilotRedteamMaxAgeDays: number }) {
  return {
    enabled: o.copilotRedteamGateEnabled,
    maxAgeDays: o.copilotRedteamMaxAgeDays,
    requiredClasses: COPILOT_REDTEAM_CLASSES,
  };
}

/** what a settings change relaxes: turning the gate off, or a longer window */
function relaxedBy(
  body: z.infer<typeof settingsSchema>,
  org: { copilotRedteamGateEnabled: boolean; copilotRedteamMaxAgeDays: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.enabled === false && org.copilotRedteamGateEnabled) out.copilotRedteamGateEnabled = false;
  if (body.maxAgeDays !== undefined && body.maxAgeDays > org.copilotRedteamMaxAgeDays) {
    out.copilotRedteamMaxAgeDays = body.maxAgeDays;
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
      .select({ id: agents.id, name: agents.name, model: agents.model })
      .from(agents)
      .where(eq(agents.id, parsed.data.agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    return { settings: settingsView(org), agentId: agent.id, verdict: await copilotNarratorRedteamGate(db, agent) };
  });

  app.put("/v1/copilot/redteam-gate", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues });
    const body = parsed.data;
    const org = await loadOrgSettings(db);
    if (!(await requireRelaxStepUp(db, req, reply, relaxedBy(body, org)))) return reply;
    const patch = {
      ...(body.enabled !== undefined ? { copilotRedteamGateEnabled: body.enabled } : {}),
      ...(body.maxAgeDays !== undefined ? { copilotRedteamMaxAgeDays: body.maxAgeDays } : {}),
    };
    if (Object.keys(patch).length === 0) return settingsView(org);
    const updated = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // compare-and-set on the values the step-up was decided on
      const [row] = await tx
        .update(orgSettings)
        .set({ ...patch, updatedBy: req.authCtx.userId ?? null, updatedAt: new Date() })
        .where(
          and(
            eq(orgSettings.id, ORG_SETTINGS_ID),
            eq(orgSettings.copilotRedteamGateEnabled, org.copilotRedteamGateEnabled),
            eq(orgSettings.copilotRedteamMaxAgeDays, org.copilotRedteamMaxAgeDays),
          ),
        )
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "org_settings",
        objectId: null,
        detail: {
          phase: "copilot-redteam-gate",
          transitions: settingTransitions(org, patch),
          relaxed: Object.keys(relaxedBy(body, org)),
        },
        effect: "allow",
        ruleId: COPILOT_REDTEAM_RULE_IDS.settings,
        ruleChain: [],
        reason:
          `copilot red-team gate ${row.copilotRedteamGateEnabled ? "on" : "off"}; a narrator's passing run counts ` +
          `for ${row.copilotRedteamMaxAgeDays} days`,
      });
      return row;
    });
    if (!updated) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return settingsView(updated);
  });
}
