/**
 * ADR-0241 (backlog P21) — the configurable usage extractor, gateway side.
 *
 * An admin saves a usage mapping for an agent (RFC 6901 pointers from the provider's response body to token counts,
 * validated and evaluated by `@regulait/model-provider`'s usage-extractor), tests it against a sample response with
 * the counts they expect, and activates the tested version. At dispatch, `resolveDispatchUsage` runs at the one
 * pricing point of `performDispatch`, just before ADR-0212's `priceDispatchUsage`, so the mapped counts feed pillar-5
 * attribution and modality pricing unchanged.
 *
 *   - Off by default (ADR-0180): nothing is read until `org_settings.usage_extractor_enabled` is on, and turning it
 *     on is a settings_relax step-up. Activating a version changes what spend is attributed, so it needs the
 *     step-up too. Turning the switch off and deactivating a version return to the built-in extraction, the
 *     default, so they are audited without a step-up.
 *   - Versioned: every save is a new immutable row (the next version number, under a lock on the agent row). Every
 *     write (save, test, activate, deactivate, switch) writes its audit row in the same transaction.
 *   - Test before activation: a version activates only when the latest test OF THAT VERSION passed, i.e. the mapping
 *     produced exactly the counts the admin said the sample carries. Only the sample's SHA-256 is stored.
 *   - Fail closed: a mapping that cannot read a dispatch's response (no body, a bound crossed, a required count
 *     absent, a value that is not a token count, a split larger than its total) leaves the adapter's built-in counts
 *     in place, stamps the outcome on the usage row's detail and writes an audit row. A mapping never runs code and
 *     never makes a call unpriceable that the built-in counts would price. The budget rules are unchanged: they run
 *     before dispatch and an unpriced agent is still refused under a budget (ADR-0188 decision 16).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  auditLog,
  orgSettings,
  ORG_SETTINGS_ID,
  usageExtractorActive,
  usageExtractorTests,
  usageExtractorVersions,
  and,
  desc,
  eq,
  inArray,
  sql,
  type Db,
} from "@regulait/db";
import {
  USAGE_FIELDS,
  extractUsage,
  validateUsageMapping,
  type ModelDispatchResult,
  type UsageField,
  type UsageMapping,
} from "@regulait/model-provider";
import { requireStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
/** a sample response is at most this many bytes of JSON; the extractor's own node/depth/text bounds apply after */
export const SAMPLE_MAX_BYTES = 1_048_576;

type Usage = ModelDispatchResult["usage"];

export interface DispatchUsage {
  usage: Usage;
  /** the mapping version that produced `usage`; null = the adapter's built-in extraction */
  versionId: string | null;
  /** present only when a mapping was active: what happened, for the usage row's detail */
  outcome?: { versionId: string; version: number; result: "mapped" | "fallback"; failure?: string };
}

async function switchOn(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ on: orgSettings.usageExtractorEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return row?.on === true;
}

/**
 * The dispatch-time read. Returns the built-in counts unchanged when the switch is off or the agent has no active
 * version; otherwise the mapped counts, or the built-in counts with a recorded fallback.
 */
export async function resolveDispatchUsage(
  db: Db,
  args: { agentId: string; userId: string; projectId?: string | null; result: Pick<ModelDispatchResult, "usage" | "usageSource"> },
): Promise<DispatchUsage> {
  const builtIn: DispatchUsage = { usage: args.result.usage, versionId: null };
  if (!(await switchOn(db))) return builtIn;
  const [active] = await db
    .select({ versionId: usageExtractorVersions.id, version: usageExtractorVersions.version, mapping: usageExtractorVersions.mapping })
    .from(usageExtractorActive)
    .innerJoin(usageExtractorVersions, eq(usageExtractorVersions.id, usageExtractorActive.versionId))
    .where(eq(usageExtractorActive.agentId, args.agentId));
  if (!active) return builtIn;
  // re-validated on every read: a row written around the API is never evaluated unchecked
  const checked = validateUsageMapping(active.mapping);
  const extracted = checked.ok
    ? extractUsage(checked.mapping, args.result.usageSource)
    : ({ ok: false, reason: "the stored mapping no longer validates" } as const);
  if (extracted.ok) {
    const reasoning = args.result.usage.reasoningTokens;
    return {
      usage: { ...extracted.usage, ...(reasoning ? { reasoningTokens: reasoning } : {}) },
      versionId: active.versionId,
      outcome: { versionId: active.versionId, version: active.version, result: "mapped" },
    };
  }
  await db.insert(auditLog).values({
    userId: args.userId,
    objectType: "agent",
    objectId: args.agentId,
    detail: {
      phase: "usage-extractor-fallback",
      usageExtractorVersionId: active.versionId,
      version: active.version,
      failure: extracted.reason,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      receiptClass: "decision",
    },
    effect: "allow",
    ruleId: "usage-extractor-fallback",
    ruleChain: [],
    reason: `usage mapping v${active.version} could not read this response (${extracted.reason}); the adapter's built-in counts were used`,
  });
  return {
    ...builtIn,
    outcome: { versionId: active.versionId, version: active.version, result: "fallback", failure: extracted.reason },
  };
}

// --- admin routes ------------------------------------------------------------------------------------------------

const agentParam = z.object({ agentId: z.string().uuid() });
const versionParam = z.object({ agentId: z.string().uuid(), versionId: z.string().uuid() });
const switchBody = z.object({ enabled: z.boolean() }).strict();
const saveBody = z.object({ mapping: z.unknown() }).strict();
const count = z.number().int().min(0).max(1_000_000_000_000);
const expectedSchema = z
  .object(Object.fromEntries(USAGE_FIELDS.map((f) => [f, f === "inputTokens" || f === "outputTokens" ? count : count.optional()])) as Record<UsageField, typeof count>)
  .strict();
const testBody = z.object({ sample: z.unknown(), expected: expectedSchema }).strict();

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** the counts a usage result stands for, one number per field (absent = 0), for an exact comparison */
function flatten(u: Usage): Record<UsageField, number> {
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
    imageInputTokens: u.modality?.image?.inputTokens ?? 0,
    imageOutputTokens: u.modality?.image?.outputTokens ?? 0,
    audioInputTokens: u.modality?.audio?.inputTokens ?? 0,
    audioOutputTokens: u.modality?.audio?.outputTokens ?? 0,
  };
}

async function loadAgent(db: Db, agentId: string) {
  const [a] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId));
  return a ?? null;
}

/** Admin-only through the global gate (none of these routes is in NON_ADMIN_ROUTES). */
export function registerUsageExtractorRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/usage-extractors", async () => {
    const [enabled, active] = await Promise.all([
      switchOn(db),
      db
        .select({
          agentId: usageExtractorActive.agentId,
          versionId: usageExtractorActive.versionId,
          version: usageExtractorVersions.version,
          testId: usageExtractorActive.testId,
          activatedBy: usageExtractorActive.activatedBy,
          activatedAt: usageExtractorActive.activatedAt,
        })
        .from(usageExtractorActive)
        .innerJoin(usageExtractorVersions, eq(usageExtractorVersions.id, usageExtractorActive.versionId))
        .orderBy(usageExtractorActive.activatedAt)
        .limit(500),
    ]);
    return { enabled, active };
  });

  // The org switch. Turning it on lets an admin mapping decide attributed spend: settings_relax step-up. Turning it
  // off returns every agent to its adapter's built-in counts (the default), so it is audited without one.
  app.put("/v1/usage-extractors/enabled", async (req, reply) => {
    const { enabled } = switchBody.parse(req.body);
    const before = await switchOn(db);
    if (before === enabled) return reply.send({ enabled, changed: false });
    let stepUp: string | undefined;
    if (enabled) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { values: { usageExtractorEnabled: true } } });
      if (!su.ok) return reply;
      stepUp = su.method;
    }
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ on: orgSettings.usageExtractorEnabled })
        .from(orgSettings)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .for("update");
      await tx
        .update(orgSettings)
        .set({ usageExtractorEnabled: enabled, updatedBy: req.authCtx.userId ?? null, updatedAt: new Date() })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "org_settings",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          changed: { usageExtractorEnabled: enabled },
          transitions: { usageExtractorEnabled: { from: locked?.on ?? false, to: enabled } },
          ...(enabled ? { relaxed: ["usageExtractorEnabled"] } : {}),
          ...(stepUp ? { stepUp } : {}),
        },
        effect: "allow",
        ruleId: "org-settings-updated",
        ruleChain: [],
        reason: enabled
          ? "usage extractor turned on — an agent's active usage mapping now decides its measured token counts"
          : "usage extractor turned off — every agent's counts are its adapter's built-in extraction",
      });
    });
    return reply.send({ enabled, changed: true });
  });

  app.get("/v1/agents/:agentId/usage-extractor/versions", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    if (!(await loadAgent(db, agentId))) return reply.status(404).send({ error: "unknown_agent" });
    const versions = await db
      .select()
      .from(usageExtractorVersions)
      .where(eq(usageExtractorVersions.agentId, agentId))
      .orderBy(desc(usageExtractorVersions.version))
      .limit(100);
    const ids = versions.map((v) => v.id);
    const tests = ids.length
      ? await db
          .selectDistinctOn([usageExtractorTests.versionId], {
            versionId: usageExtractorTests.versionId,
            id: usageExtractorTests.id,
            passed: usageExtractorTests.passed,
            failure: usageExtractorTests.failure,
            testedAt: usageExtractorTests.testedAt,
          })
          .from(usageExtractorTests)
          .where(inArray(usageExtractorTests.versionId, ids))
          .orderBy(usageExtractorTests.versionId, desc(usageExtractorTests.testedAt), desc(usageExtractorTests.id))
      : [];
    const latest = new Map(tests.map((t) => [t.versionId, t]));
    const [active] = await db.select().from(usageExtractorActive).where(eq(usageExtractorActive.agentId, agentId));
    return {
      enabled: await switchOn(db),
      activeVersionId: active?.versionId ?? null,
      versions: versions.map((v) => ({ ...v, latestTest: latest.get(v.id) ?? null })),
    };
  });

  // Saving a version only records a candidate: it reads nothing until it is tested and activated, so no step-up.
  app.post("/v1/agents/:agentId/usage-extractor/versions", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const { mapping } = saveBody.parse(req.body ?? {});
    const checked = validateUsageMapping(mapping);
    if (!checked.ok) return reply.status(422).send({ error: "invalid_usage_mapping", errors: checked.errors });
    const text = JSON.stringify(checked.mapping);
    const created = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId)).for("update");
      if (!agent) return null;
      const [top] = await tx
        .select({ v: sql<number>`coalesce(max(${usageExtractorVersions.version}), 0)::int` })
        .from(usageExtractorVersions)
        .where(eq(usageExtractorVersions.agentId, agentId));
      const [row] = await tx
        .insert(usageExtractorVersions)
        .values({
          agentId,
          version: (top?.v ?? 0) + 1,
          mapping: checked.mapping,
          mappingSha256: sha256(text),
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "agent",
        objectId: agentId,
        detail: {
          phase: "usage-extractor-version-saved",
          via: req.authCtx.via,
          usageExtractorVersionId: row!.id,
          version: row!.version,
          mappingSha256: row!.mappingSha256,
          mapping: checked.mapping,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "usage-extractor-version-saved",
        ruleChain: [],
        reason: `usage mapping v${row!.version} saved for '${agent.name}' (not active until tested and activated)`,
      });
      return row!;
    });
    if (!created) return reply.status(404).send({ error: "unknown_agent" });
    return reply.status(201).send(created);
  });

  // The sample-response test. Passing means the mapping produced EXACTLY the counts the admin says the sample
  // carries. Only the sample's hash is kept.
  app.post(
    "/v1/agents/:agentId/usage-extractor/versions/:versionId/test",
    { bodyLimit: SAMPLE_MAX_BYTES + 16_384 },
    async (req, reply) => {
      const { agentId, versionId } = versionParam.parse(req.params);
      const body = testBody.parse(req.body ?? {});
      const sampleText = JSON.stringify(body.sample ?? null);
      if (Buffer.byteLength(sampleText, "utf8") > SAMPLE_MAX_BYTES) {
        return reply.status(413).send({ error: "sample_too_large", detail: `a sample is at most ${SAMPLE_MAX_BYTES} bytes of JSON` });
      }
      const [version] = await db
        .select()
        .from(usageExtractorVersions)
        .where(and(eq(usageExtractorVersions.id, versionId), eq(usageExtractorVersions.agentId, agentId)));
      if (!version) return reply.status(404).send({ error: "unknown_usage_extractor_version" });
      const checked = validateUsageMapping(version.mapping);
      const result = checked.ok
        ? extractUsage(checked.mapping as UsageMapping, body.sample)
        : ({ ok: false, reason: "the stored mapping no longer validates" } as const);
      const expected = body.expected as Record<UsageField, number | undefined>;
      let failure: string | null = null;
      let extracted: Record<UsageField, number> | null = null;
      if (!result.ok) failure = result.reason;
      else {
        extracted = flatten(result.usage);
        const diff = USAGE_FIELDS.filter((f) => (expected[f] ?? 0) !== extracted![f]);
        if (diff.length) failure = `the mapping's counts differ from the expected counts for: ${diff.join(", ")}`;
      }
      const passed = failure === null;
      const test = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(usageExtractorTests)
          .values({
            versionId,
            sampleSha256: sha256(sampleText),
            passed,
            expected: Object.fromEntries(USAGE_FIELDS.map((f) => [f, expected[f] ?? 0])),
            extracted,
            failure: failure?.slice(0, 500) ?? null,
            testedBy: req.authCtx.userId ?? null,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: req.authCtx.userId ?? NIL_USER,
          objectType: "agent",
          objectId: agentId,
          detail: {
            phase: "usage-extractor-tested",
            via: req.authCtx.via,
            usageExtractorVersionId: versionId,
            version: version.version,
            testId: row!.id,
            sampleSha256: row!.sampleSha256,
            passed,
            receiptClass: "configuration",
          },
          effect: passed ? "allow" : "deny",
          ruleId: "usage-extractor-tested",
          ruleChain: [],
          reason: passed
            ? `usage mapping v${version.version} passed its sample test`
            : `usage mapping v${version.version} failed its sample test: ${failure!.slice(0, 300)}`,
        });
        return row!;
      });
      return reply.send({ testId: test.id, passed, extracted, failure });
    },
  );

  // Activation decides what spend is attributed for this agent from now on: settings_relax step-up, and only on a
  // passing latest test of this exact version, checked under the agent's row lock in the same transaction.
  app.post("/v1/agents/:agentId/usage-extractor/versions/:versionId/activate", async (req, reply) => {
    const { agentId, versionId } = versionParam.parse(req.params);
    const [version] = await db
      .select({ id: usageExtractorVersions.id, version: usageExtractorVersions.version })
      .from(usageExtractorVersions)
      .where(and(eq(usageExtractorVersions.id, versionId), eq(usageExtractorVersions.agentId, agentId)));
    if (!version) return reply.status(404).send({ error: "unknown_usage_extractor_version" });
    // checked before the step-up too, so a refusal never spends the admin's grant; re-checked under the lock below
    const [unlocked] = await db
      .select({ passed: usageExtractorTests.passed })
      .from(usageExtractorTests)
      .where(eq(usageExtractorTests.versionId, versionId))
      .orderBy(desc(usageExtractorTests.testedAt), desc(usageExtractorTests.id))
      .limit(1);
    if (!unlocked?.passed) {
      return reply.status(409).send({ error: "sample_test_required", detail: "a version activates only when its latest sample test passed" });
    }
    const su = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { values: { usageExtractorActivated: { agentId, versionId } } },
    });
    if (!su.ok) return reply;
    const out = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId)).for("update");
      if (!agent) return { error: "unknown_agent" as const };
      const [latest] = await tx
        .select({ id: usageExtractorTests.id, passed: usageExtractorTests.passed })
        .from(usageExtractorTests)
        .where(eq(usageExtractorTests.versionId, versionId))
        .orderBy(desc(usageExtractorTests.testedAt), desc(usageExtractorTests.id))
        .limit(1);
      if (!latest?.passed) return { error: "sample_test_required" as const };
      const [prior] = await tx.select().from(usageExtractorActive).where(eq(usageExtractorActive.agentId, agentId));
      await tx
        .insert(usageExtractorActive)
        .values({ agentId, versionId, testId: latest.id, activatedBy: req.authCtx.userId ?? null })
        .onConflictDoUpdate({
          target: usageExtractorActive.agentId,
          set: { versionId, testId: latest.id, activatedBy: req.authCtx.userId ?? null, activatedAt: sql`now()` },
        });
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "agent",
        objectId: agentId,
        detail: {
          phase: "usage-extractor-activated",
          via: req.authCtx.via,
          transitions: { usageExtractorVersionId: { from: prior?.versionId ?? null, to: versionId } },
          version: version.version,
          testId: latest.id,
          relaxation: true,
          stepUp: su.method,
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "usage-extractor-activated",
        ruleChain: [],
        reason: `usage mapping v${version.version} activated for '${agent.name}' — its counts are priced while the usage extractor is on`,
      });
      return { ok: true as const, testId: latest.id };
    });
    if ("error" in out) {
      if (out.error === "unknown_agent") return reply.status(404).send({ error: "unknown_agent" });
      return reply.status(409).send({
        error: "sample_test_required",
        detail: "a version activates only when its latest sample test passed",
      });
    }
    return reply.send({ agentId, versionId, version: version.version, testId: out.testId, activated: true });
  });

  // Deactivation returns the agent to its adapter's built-in counts (the default): audited, no step-up.
  app.post("/v1/agents/:agentId/usage-extractor/deactivate", async (req, reply) => {
    const { agentId } = agentParam.parse(req.params);
    const out = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, agentId)).for("update");
      if (!agent) return null;
      const removed = await tx.delete(usageExtractorActive).where(eq(usageExtractorActive.agentId, agentId)).returning();
      if (removed.length === 0) return { changed: false };
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NIL_USER,
        objectType: "agent",
        objectId: agentId,
        detail: {
          phase: "usage-extractor-deactivated",
          via: req.authCtx.via,
          transitions: { usageExtractorVersionId: { from: removed[0]!.versionId, to: null } },
          receiptClass: "configuration",
        },
        effect: "allow",
        ruleId: "usage-extractor-deactivated",
        ruleChain: [],
        reason: `usage mapping deactivated for '${agent.name}' — its adapter's built-in counts are used`,
      });
      return { changed: true };
    });
    if (!out) return reply.status(404).send({ error: "unknown_agent" });
    return reply.send({ agentId, deactivated: out.changed });
  });
}
