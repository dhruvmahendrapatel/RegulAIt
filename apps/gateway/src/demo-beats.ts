/**
 * ADR-0202 decision 4 — THE PER-BEAT SIMULATED FALLBACK for the hosted demo.
 *
 * Every demo beat runs LIVE against the real third-party accounts by default. When a vendor is down on the day, an
 * admin switches that one beat back to today's simulated or mock path, so an outage cannot sink the demo. This module
 * is the ONE place that answer lives:
 *
 *  - `isBeatSimulated(db, beatId)` is the server-side question every beat asks before it makes a live call. Lane F
 *    calls it for `enforce-it`. A beat with no row is live; an unknown beat id THROWS, so a typo in a caller fails
 *    loudly instead of quietly running live (or quietly running simulated).
 *  - `GET /v1/demo/beats` lists every beat and its mode; `PUT /v1/demo/beats/:beatId` switches one. Both are
 *    admin-only (neither is in NON_ADMIN_ROUTES). The write and its audit row are one transaction, and the audit
 *    row names the beat, the transition and the admin's stated reason.
 *
 * NO STEP-UP, deliberately. The `settings_relax` step-up (ADR-0186 A) guards a write that LOOSENS a security control.
 * Switching a beat to simulated loosens none: a simulated beat makes fewer outbound calls, not more, and every
 * governance decision on it is still taken by the real policy engine and still audited. What the switch changes is
 * the AUTHENTICITY of what the audience sees, so ADR-0180's other half applies instead: it is off by default, only an
 * admin may flip it, every flip is audited, and the UI labels a simulated beat "simulated". Requiring an authenticator
 * code from the presenter in the middle of a third-party outage would buy no security for that cost.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, demoBeatFallbacks, eq, type Db } from "@regulait/db";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** ONE stable ruleId, so a single audit query answers "which beats ran simulated, when, and who said so". */
export const DEMO_BEAT_RULE_ID = "demo-beat-fallback-changed";

/**
 * The demo beats that can run live, in script order (`DEMO_SCRIPT_2026-11-01.md`, ADR-0197 and ADR-0202). Each
 * maps to the live dependency it has, which is what the simulated path removes.
 */
export const DEMO_BEATS = [
  {
    id: "shadow-ai-discovery",
    label: "Shadow AI discovery (S1-S2)",
    live: "real discovery scans of the demo accounts",
    simulated: "the recorded discovery dataset (demo:prepare)",
  },
  {
    id: "enforce-it",
    label: "Enforce it (E)",
    live: "a real governed call: deny, approval request to Slack and email, approval, downstream updates",
    simulated: "the simulated decision on the Simulation / access preview page",
  },
  {
    id: "pm-sync",
    label: "PM sync (Jira Cloud, Azure DevOps)",
    live: "the real Jira Cloud and Azure DevOps work items",
    simulated: "the in-memory mock PM provider",
  },
  {
    id: "git-pr",
    label: "Git branch and pull request (GitHub)",
    live: "a real branch and pull request on the demo GitHub repository",
    simulated: "the in-memory mock git provider",
  },
  {
    id: "chatops-approval",
    label: "ChatOps approval (Slack)",
    live: "the approval request posted to the demo Slack workspace, decided there",
    simulated: "the approval decided in the RegulAIt Inbox only",
  },
  {
    id: "email-notify",
    label: "Approval and alert email (Resend)",
    live: "real email through the product email channel",
    simulated: "no email sent; the in-product notification only",
  },
] as const;

export type DemoBeatId = (typeof DEMO_BEATS)[number]["id"];
export const DEMO_BEAT_IDS: readonly DemoBeatId[] = DEMO_BEATS.map((b) => b.id);

export function isDemoBeatId(value: string): value is DemoBeatId {
  return (DEMO_BEAT_IDS as readonly string[]).includes(value);
}

export class UnknownDemoBeatError extends Error {
  constructor(beatId: string) {
    super(`unknown demo beat '${beatId}'; expected one of ${DEMO_BEAT_IDS.join(", ")}`);
    this.name = "UnknownDemoBeatError";
  }
}

/**
 * THE QUESTION A BEAT ASKS before a live call: should this beat take its simulated path? False (live) unless an admin
 * switched it. Throws `UnknownDemoBeatError` for an id that is not in `DEMO_BEATS`.
 */
export async function isBeatSimulated(db: Pick<Db, "select">, beatId: DemoBeatId | string): Promise<boolean> {
  if (!isDemoBeatId(beatId)) throw new UnknownDemoBeatError(beatId);
  const [row] = await db
    .select({ simulated: demoBeatFallbacks.simulated })
    .from(demoBeatFallbacks)
    .where(eq(demoBeatFallbacks.beatId, beatId));
  return row?.simulated === true;
}

export interface DemoBeatMode {
  beatId: DemoBeatId;
  label: string;
  mode: "live" | "simulated";
  live: string;
  simulated: string;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** every beat, in script order, with its current mode */
export async function loadDemoBeatModes(db: Pick<Db, "select">): Promise<DemoBeatMode[]> {
  const rows = await db.select().from(demoBeatFallbacks);
  const byId = new Map(rows.map((r) => [r.beatId, r]));
  return DEMO_BEATS.map((b) => {
    const row = byId.get(b.id);
    return {
      beatId: b.id,
      label: b.label,
      mode: row?.simulated ? "simulated" : "live",
      live: b.live,
      simulated: b.simulated,
      reason: row?.reason ?? null,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row ? row.updatedAt.toISOString() : null,
    };
  });
}

const putBodySchema = z
  .object({
    simulated: z.boolean(),
    /** why: an audit row that cannot say why a beat ran simulated is no evidence */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export function registerDemoBeatRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/demo/beats", async () => ({ beats: await loadDemoBeatModes(db) }));

  app.put<{ Params: { beatId: string } }>("/v1/demo/beats/:beatId", async (req, reply) => {
    const { beatId } = req.params;
    if (!isDemoBeatId(beatId)) {
      return reply.status(404).send({ error: "unknown_beat", detail: `expected one of ${DEMO_BEAT_IDS.join(", ")}` });
    }
    const parsed = putBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_body",
        detail: "expected { simulated: boolean, reason: string (3-500 characters) }",
      });
    }
    const { simulated, reason } = parsed.data;
    const userId = req.authCtx.userId ?? null;
    const beat = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(demoBeatFallbacks)
        .where(eq(demoBeatFallbacks.beatId, beatId))
        .for("update");
      const from = before?.simulated ? "simulated" : "live";
      const to = simulated ? "simulated" : "live";
      const values = { beatId, simulated, reason, updatedBy: userId, updatedAt: new Date() };
      await tx
        .insert(demoBeatFallbacks)
        .values(values)
        .onConflictDoUpdate({ target: demoBeatFallbacks.beatId, set: values });
      await tx.insert(auditLog).values({
        // bootstrap has no user identity; the nil uuid marks a non-user actor and `via` says which it was
        userId: userId ?? NIL_USER,
        objectType: "demo_beat",
        objectId: null,
        detail: { via: req.authCtx.via, beatId, transition: { from, to }, reason },
        effect: "allow",
        ruleId: DEMO_BEAT_RULE_ID,
        ruleChain: [],
        reason:
          from === to
            ? `demo beat '${beatId}' re-confirmed ${to}: ${reason}`
            : `demo beat '${beatId}' switched ${from} -> ${to}: ${reason}`,
      });
      return (await loadDemoBeatModes(tx)).find((b) => b.beatId === beatId);
    });
    return reply.send({ beat });
  });
}
