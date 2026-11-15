/**
 * P7R-02 (post-merge review of PR #634, ADR-0220) — a trained PII finding is
 * never weaker than the effective PII floor.
 *
 * `resolveGuardrailPolicy` forces the heuristic `modes.pii` to 'off' (PII has
 * its own dedicated path). Before this fix the trained planner reused that
 * map, so a trained PII recogniser ran at only its own row mode: an org whose
 * strict default (or a project whose compliance cascade) requires PII BLOCK
 * got a trained person-name finding back as warn. The trained recogniser is
 * there precisely for the categories the heuristic path misses, so nothing
 * else compensated.
 *
 * What this file pins, against the real database and the real policy
 * resolver (only the network call to the scoring service is stubbed):
 *  1. the org strict default (block) lifts a warn-mode trained PII row to block;
 *  2. a classified project's cascade (block) lifts it with the org relaxed to 'none';
 *  3. with the org relaxed to 'none' and no cascade, the row's own mode governs;
 *  4. MAX composition: a weaker floor never lowers a stricter row;
 *  5. the same result decides stream buffering (blocksInput / blocksOutput).
 *
 * Shared-state discipline: objects are `p7r02-` prefixed and removed in afterAll.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  complianceProfiles,
  createDb,
  eq,
  externalScorers,
  guardrailTrainedDetectors,
  projects,
  runMigrations,
  type Db,
} from "@regulait/db";
import { TRAINED_DETECTOR_SCORER_KIND } from "@regulait/shared";

const SCORER_NAME = `p7r02-scorer-${Math.random().toString(36).slice(2, 8)}`;

// Only the scoring-service hop is stubbed: the stand-in "recognises" a person
// name with 0.99 confidence, as the reviewer's probe did.
vi.mock("./external-scorers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./external-scorers.js")>();
  return {
    ...actual,
    resolveExternalScorersByName: async (_db: unknown, _key: unknown, names: readonly string[]) => {
      const facts = names.map((name) => ({ name, enabled: true, reachable: true }));
      const resolved = new Map(
        names.map((name) => [
          name,
          { row: { name, scorerKinds: [TRAINED_DETECTOR_SCORER_KIND.pii] }, fetchImpl: fetch, apiKey: null },
        ]),
      );
      return { facts, resolved };
    },
    callExternalScorer: async () => ({ score: 0.99, reasons: ["person"] }),
  };
});

const { resolveGuardrailPolicy, runGuardrailsAsync } = await import("./guardrails.js");
const { setOrgSettingsForTest } = await import("./testing/strict-data-posture.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const TAG = `p7r02-tag-${Math.random().toString(36).slice(2, 8)}`;
// fictional personal data the heuristic path has no pattern for
const TEXT = "Please forward the notes to Marguerite Halvorsen-Okafor before Friday.";

let db: Db;
let scorerId: string;
let classifiedProjectId: string;
let plainProjectId: string;
let restoreOrg: () => Promise<void> = async () => {};

async function setTrainedPii(mode: "log" | "warn" | "block") {
  await db
    .insert(guardrailTrainedDetectors)
    .values({ kind: "pii", enabled: true, scorerId, mode, threshold: 0.5, onFailure: "block" })
    .onConflictDoUpdate({ target: guardrailTrainedDetectors.kind, set: { enabled: true, scorerId, mode } });
}

async function setOrgPii(mode: "block" | "warn" | "log" | "none") {
  await restoreOrg();
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: mode });
}

function piiFinding(evalResult: Awaited<ReturnType<typeof runGuardrailsAsync>>) {
  return evalResult.findings.find((f) => f.detector === "pii");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(guardrailTrainedDetectors);
  const [s] = await db
    .insert(externalScorers)
    .values({
      name: SCORER_NAME,
      baseUrl: "https://scorer.regulait.example/score",
      scorerKinds: [TRAINED_DETECTOR_SCORER_KIND.pii],
      enabled: true,
    })
    .returning({ id: externalScorers.id });
  scorerId = s!.id;
  await db.insert(complianceProfiles).values({ tag: TAG, piiMode: "block" });
  const [p1] = await db
    .insert(projects)
    .values({ name: `p7r02-classified-${TAG}`, classifications: [TAG] })
    .returning({ id: projects.id });
  classifiedProjectId = p1!.id;
  const [p2] = await db
    .insert(projects)
    .values({ name: `p7r02-plain-${TAG}`, classifications: [] })
    .returning({ id: projects.id });
  plainProjectId = p2!.id;
});

beforeEach(async () => {
  await db.delete(guardrailTrainedDetectors);
});

afterAll(async () => {
  await restoreOrg();
  await db.delete(guardrailTrainedDetectors);
  await db.delete(projects).where(eq(projects.id, classifiedProjectId));
  await db.delete(projects).where(eq(projects.id, plainProjectId));
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, TAG));
  await db.delete(externalScorers).where(eq(externalScorers.id, scorerId));
});

describe("P7R-02: trained PII inherits the effective PII block floor", () => {
  it("the org strict default (block) lifts a warn-mode trained PII finding to block, unattributed", async () => {
    await setOrgPii("block");
    await setTrainedPii("warn");
    const policy = await resolveGuardrailPolicy(db, {});
    for (const phase of ["input", "output"] as const) {
      const r = await runGuardrailsAsync(policy, phase, TEXT);
      expect(r.action).toBe("block");
      expect(piiFinding(r)?.mode).toBe("block");
      expect(piiFinding(r)?.hits.map((h) => h.category)).toContain("trained_person");
    }
    // the same composed mode decides buffering, so a stream is never delivered
    // live past a trained PII block
    expect(policy.blocksInput).toBe(true);
    expect(policy.blocksOutput).toBe(true);
    // the heuristic exclusion is unchanged: nothing double-enforces PII there
    expect(policy.modes.pii).toBe("off");
  });

  it("a classified project's cascade (block) lifts it even when the org default is relaxed to none", async () => {
    await setOrgPii("none");
    await setTrainedPii("warn");
    const policy = await resolveGuardrailPolicy(db, { projectId: classifiedProjectId });
    const r = await runGuardrailsAsync(policy, "input", TEXT);
    expect(r.action).toBe("block");
    expect(piiFinding(r)?.mode).toBe("block");
    expect(policy.blocksOutput).toBe(true);
  });

  it("with the org relaxed to none and no cascade, the trained row's own mode governs", async () => {
    await setOrgPii("none");
    await setTrainedPii("warn");
    const policy = await resolveGuardrailPolicy(db, { projectId: plainProjectId });
    const r = await runGuardrailsAsync(policy, "input", TEXT);
    expect(r.action).toBe("warn");
    expect(piiFinding(r)?.mode).toBe("warn");
  });

  it("MAX composition: a weaker floor never lowers a stricter trained row", async () => {
    await setOrgPii("log");
    await setTrainedPii("block");
    const policy = await resolveGuardrailPolicy(db, { projectId: plainProjectId });
    const r = await runGuardrailsAsync(policy, "output", TEXT);
    expect(r.action).toBe("block");
    expect(piiFinding(r)?.mode).toBe("block");
  });

  it("a warn floor lifts a log-mode trained row to warn", async () => {
    await setOrgPii("warn");
    await setTrainedPii("log");
    const policy = await resolveGuardrailPolicy(db, {});
    const r = await runGuardrailsAsync(policy, "input", TEXT);
    expect(r.action).toBe("warn");
    expect(piiFinding(r)?.mode).toBe("warn");
  });
});
