/**
 * ADR-0118 — THE HARDENED POSTURE PRESET, AND THE POSTURE READ THAT MATTERS MORE.
 *
 * WHY THIS EXISTS. Every control below ships OFF. Each default is a deliberate,
 * documented, upgrade-safe choice — an existing deployment must behave
 * byte-identically across an upgrade — and that decision stands. But the
 * consequence was that a fresh install enforced nothing, and the first question
 * a buyer asks after installing is "so what is enforcing right now?". Until now
 * there was no way to answer it in one call, and no way to act on the answer in
 * one step.
 *
 * TWO THINGS ARE DELIBERATE AND EASY TO GET WRONG IF THIS FILE IS EDITED LATER.
 *
 * 1. THE READ IS THE PRIMARY DELIVERABLE, not the write. `GET /v1/org/posture`
 *    is useful to an operator who will never apply the preset: it names each
 *    control, what it is set to, what hardened means for it, and — the part
 *    that makes it worth reading — WHAT TURNING IT ON WOULD REFUSE. A posture
 *    page that lists switches without naming their blast radius invites an
 *    admin to harden a live deployment at 4pm on a Friday.
 *
 * 2. TWO CONTROLS ARE NOT SETTINGS COLUMNS AND ARE NEVER CLAIMED. The audit
 *    anchor is resolved from S3 environment variables and the scheduler from
 *    `REGULAIT_SCHEDULER`. AN API CALL CANNOT SET AN ENVIRONMENT VARIABLE.
 *    They are reported with `settable: false` and their OBSERVED state, and
 *    `harden` neither touches them nor counts them as applied. This follows the
 *    precedent ADR-0060 set in `audit-chain.ts`: `tamperResistant` is read from
 *    the bucket's own answer rather than inferred from the fact that somebody
 *    configured a bucket. Reporting a control as hardened because we asked for
 *    it, rather than because it is, would be the exact dishonesty this product
 *    argues against everywhere else.
 */

import type { FastifyInstance } from "fastify";
import {
  auditLog,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";
import { resolveAnchorSink } from "./audit-chain.js";
import { resolveSchedulerConfig } from "./scheduler.js";

/** `enforcement` changes what the product REFUSES. `optimisation` changes what
 * it SPENDS and how it answers. They are reported as separate groups and the
 * summary counts them separately, because calling a cache policy "hardening"
 * conflates a security posture with a cost decision — an admin hardening a
 * regulated deployment is not thereby asking to serve more answers from cache. */
export type PostureGroup = "enforcement" | "optimisation";

export interface PostureControl {
  /** the org_settings column, or a symbolic name for an env-backed control */
  readonly key: string;
  readonly group: PostureGroup;
  /** what it is right now */
  readonly current: unknown;
  /** what `hardened` means for this control */
  readonly hardened: unknown;
  /** is `current` already the hardened value? */
  readonly satisfied: boolean;
  /** can POST /v1/org/posture/harden change it? false = env-backed */
  readonly settable: boolean;
  /** what hardening this control starts refusing — the blast radius, in a
   * sentence an admin can act on */
  readonly refuses: string;
}

/**
 * THE SETTINGS-BACKED CONTROLS. `hardened` is the strictest value the shipped
 * enum offers, except where a weaker one is the honest target — see each note.
 */
const SETTABLE: ReadonlyArray<{
  key: keyof OrgSettingsRow;
  group: PostureGroup;
  hardened: unknown;
  refuses: string;
}> = [
  {
    key: "defaultPiiMode",
    group: "enforcement",
    hardened: "block",
    refuses:
      "any dispatch, connector call or MCP tool call whose input or output carries a detected " +
      "identifier, on a project with no PII mode of its own. Check the international jurisdictions " +
      "(ADR-0117) separately — their false-positive rates differ by two orders of magnitude.",
  },
  {
    key: "mcpAdmissionMode",
    group: "enforcement",
    hardened: "enforce",
    refuses:
      "connecting to, or syncing, an MCP server whose manifest has not passed admission scanning — " +
      "including servers already registered and trusted before this was turned on, at their next sync.",
  },
  {
    key: "useCaseGateMode",
    group: "enforcement",
    hardened: "enforce",
    refuses:
      "any dispatch attributed to a project whose linked AI use case is not registered and approved. " +
      "A dispatch naming no project is unaffected — pair this with dispatchAttributionRequired or the " +
      "gate is trivially side-stepped by omitting the project header.",
  },
  {
    key: "mrmEnforced",
    group: "enforcement",
    hardened: true,
    refuses:
      "dispatch to an agent whose model card is unapproved, lapsed or missing. This one bites on the " +
      "CLOCK as well as on configuration: a card that expires tomorrow starts refusing tomorrow.",
  },
  {
    key: "dispatchAttributionRequired",
    group: "enforcement",
    hardened: true,
    refuses:
      "a NATIVE governed dispatch that names no project — and only that surface. This is what " +
      "closes the project budget gate and the use-case gate, both of which return early on a null " +
      "project by design; without it, spend controls bind only the callers who volunteer a " +
      "project. READ THE SCOPE: there are THREE independent attribution switches, and hardening " +
      "sets one. `interception_settings.require_project_attribution` guards the IDE/compat edge " +
      "and `interception_settings.require_mcp_attribution` guards the MCP proxy; neither is part " +
      "of this preset, so a hardened deployment still accepts an unattributed MCP tool call or " +
      "compat request until you set them too.",
  },
  {
    key: "semanticCachePolicy",
    group: "optimisation",
    hardened: "always",
    refuses:
      "nothing. It CHANGES answers rather than refusing them: a repeat question may be served from a " +
      "previous approved answer instead of the model. Grouped separately for that reason — it is the " +
      "one control here that is a cost decision, not a security one.",
  },
];

/** Controls that live in the process environment. Reported, never claimed. */
function environmentControls(env: NodeJS.ProcessEnv = process.env): PostureControl[] {
  // ADR-0060's precedent: ask the medium, do not infer from configuration.
  const sink = resolveAnchorSink(env);
  const anchorObserved = sink === null ? "off" : sink.destination;
  const tamperResistant = sink?.tamperResistant ?? false;

  const scheduler = resolveSchedulerConfig(env);

  return [
    {
      key: "auditAnchorTamperResistant",
      group: "enforcement",
      // the OBSERVED grade, not the configured intent
      current: { destination: anchorObserved, tamperResistant },
      hardened: { destination: "s3_object_lock", tamperResistant: true },
      satisfied: tamperResistant === true,
      settable: false,
      refuses:
        "nothing, and it cannot be switched on from here: the anchor sink is resolved from S3 " +
        "environment variables at start-up. `tamperResistant` is read from the bucket's own " +
        "Object Lock configuration — a GOVERNANCE-mode bucket grades FALSE, because an " +
        "administrator holding s3:BypassGovernanceRetention defeats it. A local directory is a " +
        "buffer, never WORM.",
    },
    {
      key: "schedulerEnabled",
      group: "enforcement",
      current: scheduler.enabled,
      hardened: true,
      satisfied: scheduler.enabled === true,
      settable: false,
      refuses:
        "nothing directly, and it cannot be switched on from here: it is REGULAIT_SCHEDULER in the " +
        "process environment. While it is off the SLA timers, red-team sweeps, admission re-scans " +
        "and cost reconciliation simply never run — the controls exist and nothing drives them.",
    },
  ];
}

export interface PostureReport {
  /** true only if EVERY control, settable or not, is at its hardened value */
  readonly hardened: boolean;
  readonly summary: {
    readonly enforcementSatisfied: number;
    readonly enforcementTotal: number;
    readonly optimisationSatisfied: number;
    readonly optimisationTotal: number;
    /** controls that are not hardened AND cannot be hardened from the API */
    readonly blockedByEnvironment: readonly string[];
  };
  readonly controls: readonly PostureControl[];
  /**
   * ADR-0124 — WHAT IS STOPPED RIGHT NOW, reported beside what is enforcing.
   *
   * DELIBERATELY NOT A `SETTABLE` CONTROL, and this is the important part: if
   * the execution dial were one of the controls the hardened preset applies,
   * then "harden this deployment" would mean "halt this deployment". That is
   * not a hardened posture, it is an outage. `normal` is the correct steady
   * state of a fully hardened install.
   *
   * So it is reported and never preset. A reviewer tempted to add it to
   * SETTABLE should read this paragraph first.
   */
  readonly execution: {
    readonly mode: string;
    readonly reason: string | null;
    readonly setAt: string | null;
    /** true when this deployment is NOT executing normally */
    readonly restricted: boolean;
    readonly note: string;
  };
}

export function buildPostureReport(
  settings: OrgSettingsRow,
  env: NodeJS.ProcessEnv = process.env,
): PostureReport {
  const settable: PostureControl[] = SETTABLE.map((c) => {
    const current = settings[c.key];
    return {
      key: c.key,
      group: c.group,
      current,
      hardened: c.hardened,
      satisfied: JSON.stringify(current) === JSON.stringify(c.hardened),
      settable: true,
      refuses: c.refuses,
    };
  });
  const controls = [...settable, ...environmentControls(env)];
  const count = (g: PostureGroup) => {
    const inGroup = controls.filter((c) => c.group === g);
    return { satisfied: inGroup.filter((c) => c.satisfied).length, total: inGroup.length };
  };
  const enf = count("enforcement");
  const opt = count("optimisation");
  const mode = settings.executionMode;
  return {
    execution: {
      mode,
      reason: settings.executionModeReason ?? null,
      setAt: settings.executionModeSetAt?.toISOString() ?? null,
      restricted: mode !== "normal",
      note:
        mode === "normal"
          ? "Executing normally. This is the correct steady state of a hardened deployment — the " +
            "hardened preset deliberately never touches this dial, because 'harden' must never " +
            "mean 'halt'."
          : `EXECUTION IS RESTRICTED (${mode}). This is an operator intervention, not a posture ` +
            "setting: see GET /v1/execution for the reason, who set it, and any individually " +
            "halted agents or tools.",
    },
    hardened: controls.every((c) => c.satisfied),
    summary: {
      enforcementSatisfied: enf.satisfied,
      enforcementTotal: enf.total,
      optimisationSatisfied: opt.satisfied,
      optimisationTotal: opt.total,
      blockedByEnvironment: controls.filter((c) => !c.satisfied && !c.settable).map((c) => c.key),
    },
    controls,
  };
}

export interface HardenOutcome {
  /** what this call actually changed, `key: [from, to]` */
  readonly applied: Record<string, [unknown, unknown]>;
  /** already at the hardened value before this call — idempotency, visible */
  readonly alreadySatisfied: readonly string[];
  /** could not be changed from here, with the reason */
  readonly notSettable: ReadonlyArray<{ key: string; reason: string }>;
  /** the posture AFTER the write */
  readonly posture: PostureReport;
}

export function registerPosturePresetRoutes(app: FastifyInstance, db: Db) {
  /** What is enforcing right now — useful to an operator who never applies the
   * preset, which is why it is a plain read with no side effects. */
  app.get("/v1/org/posture", async () => {
    const settings = await loadOrgSettings(db);
    return buildPostureReport(settings);
  });

  /**
   * Apply the hardened preset.
   *
   * `groups` selects which groups to apply and defaults to enforcement ONLY:
   * an admin asking to harden a regulated deployment is not thereby asking to
   * serve more answers from cache. Passing `["enforcement","optimisation"]`
   * takes both.
   *
   * IDEMPOTENT: a second call changes nothing and says so, rather than writing
   * the same values again and minting a second audit row that implies a change.
   */
  app.post("/v1/org/posture/harden", async (req, reply) => {
    const body = (req.body ?? {}) as { groups?: unknown };
    const requested: PostureGroup[] =
      Array.isArray(body.groups) && body.groups.length > 0
        ? (body.groups as PostureGroup[])
        : ["enforcement"];
    const bad = requested.filter((g) => g !== "enforcement" && g !== "optimisation");
    if (bad.length > 0) {
      return reply.status(400).send({
        error: "unknown_posture_group",
        detail: `unknown group(s): ${bad.join(", ")} — valid groups are 'enforcement' and 'optimisation'. Nothing was changed.`,
      });
    }

    const before = await loadOrgSettings(db);
    const targets = SETTABLE.filter((c) => requested.includes(c.group));

    const applied: Record<string, [unknown, unknown]> = {};
    const alreadySatisfied: string[] = [];
    const patch: Record<string, unknown> = {};
    for (const c of targets) {
      const current = before[c.key];
      if (JSON.stringify(current) === JSON.stringify(c.hardened)) {
        alreadySatisfied.push(c.key);
        continue;
      }
      patch[c.key] = c.hardened;
      applied[c.key] = [current, c.hardened];
    }

    let after = before;
    if (Object.keys(patch).length > 0) {
      const [row] = await db
        .update(orgSettings)
        .set({ ...patch, updatedBy: req.authCtx.userId, updatedAt: new Date() })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .returning();
      after = row ?? before;

      // A governance change is audited as one, with what moved and from what.
      // `ruleId` is its own, NOT `org-settings-updated`: an operator reading the
      // trail should be able to tell "an admin edited one dial" from "an admin
      // applied the hardened preset", and a shared rule id would erase that.
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "org_settings",
        objectId: null,
        detail: { via: req.authCtx.via, groups: requested, applied },
        effect: "allow",
        ruleId: "org-posture-hardened",
        ruleChain: [],
        reason:
          `hardened posture applied to ${requested.join(" + ")}: ` +
          Object.entries(applied)
            .map(([k, [from, to]]) => `${k} ${JSON.stringify(from)} -> ${JSON.stringify(to)}`)
            .join(", "),
      });

      // MRM enforcement has its OWN toggle route (`POST /v1/mrm/enforcement`)
      // with its own audit vocabulary — `mrm-enforcement-enabled`, effect
      // `deny`, because turning it on starts REFUSING dispatch to any model
      // whose card is unapproved or lapsed. Writing the column here without
      // that row would mean an operator alerting on that rule id silently
      // misses a preset-driven enablement, which is precisely the kind of
      // half-recorded governance change this product exists to prevent. So the
      // preset emits BOTH: one row saying the preset was applied, one saying
      // MRM enforcement came on. They are two different facts about one write.
      if (applied.mrmEnforced !== undefined) {
        await db.insert(auditLog).values({
          userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
          objectType: "org_settings",
          objectId: null,
          detail: { phase: "mrm", from: applied.mrmEnforced[0], to: applied.mrmEnforced[1], via: "posture_preset" },
          effect: "deny",
          ruleId: "mrm-enforcement-enabled",
          ruleChain: [],
          reason:
            "mrmEnforced ON via the hardened posture preset — dispatch of a model with no " +
            "unexpired approved card is now REFUSED",
        });
      }
    }

    const posture = buildPostureReport(after);
    // Everything that is still not hardened and cannot be hardened from here.
    // Reported on EVERY call, including the fully-idempotent one, so a caller
    // never reads "nothing to do" as "you are fully hardened".
    const notSettable = posture.controls
      .filter((c) => !c.satisfied && !c.settable)
      .map((c) => ({ key: c.key, reason: c.refuses }));

    const outcome: HardenOutcome = { applied, alreadySatisfied, notSettable, posture };
    return reply.send(outcome);
  });
}
