import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  compliancePacks,
  complianceProfiles,
  createDb,
  eq,
  inArray,
  projects,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

/**
 * Batch B1 — ADR-0058's §8.3 PRESET HALF: activating a pack seeds the
 * compliance profile its cascade tag keys on, and the cascade genuinely
 * enforces it.
 *
 * ADR-0058 disclosed "packs do not drive the §8.3 cascade yet — no automatic
 * creation of a compliance_profiles row from a pack". This file proves the
 * closure END TO END through the existing machinery: the profile a pack
 * activation creates is read back through `GET /v1/projects/:id/compliance`
 * (i.e. `profilesForTags` → `effectiveCompliancePolicy`, the same funnel every
 * §8.3 consumer uses), never by inspecting the inserted row alone.
 *
 * The behaviour matrix pinned here:
 *   created            no profile for the tag -> created from the preset
 *   exists_preserved   profile exists -> NEVER overwritten, note says so
 *   no_preset          tag but no preset -> nothing created, admin authors
 *   none               null cascadeTag -> nothing to seed, says why
 *   pack delete        the profile SURVIVES — enforcement is never removed as
 *                      a side effect of withdrawing a reporting artifact
 *
 * SHARED-STATE DISCIPLINE: this suite uses ONLY its own custom packs
 * (`b1-cascade-*` frameworks/tags) — never the seven launch packs, whose tags
 * (hipaa, …) other suites legitimately create profiles for. Deltas around
 * this suite's own tags only; afterAll removes its packs, profiles, project
 * and pack-audit rows by id.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "b1c-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

const FW = "b1-cascade-fw";
const TAG = "b1-cascade-tag";
const FW2 = "b1-cascade-fw2";
const TAG2 = "b1-cascade-tag2";
const FW3 = "b1-cascade-fw3";
const FW4 = "b1-cascade-fw4";
const TAG4 = "b1-cascade-tag4";

let db: Db;
let app: ReturnType<typeof buildApp>;
let packV1Id: string;
let packV2Id: string;
let projectId: string;
const packIds: string[] = [];

function packPayload(overrides: Record<string, unknown>) {
  return {
    version: 1,
    title: "B1 cascade test pack",
    provenance: { source: "b1 suite", reviewedBy: null },
    controls: [
      {
        controlRef: "b1:one",
        title: "governed decisions are audited",
        coverage: "evidenced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
      },
    ],
    ...overrides,
  };
}

async function createPack(overrides: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/compliance/packs",
    payload: packPayload(overrides),
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().pack.id as string;
  packIds.push(id);
  return id;
}

async function activate(id: string) {
  return app.inject({ method: "POST", headers: AUTH, url: `/v1/compliance/packs/${id}/activate` });
}

async function profilesForTag(tag: string) {
  return db.select().from(complianceProfiles).where(eq(complianceProfiles.tag, tag));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  // ADR-0052 §4: pack ACTIVATION is now tier-gated on `compliance_packs` —
  // run under a real signed license granting it (removed in afterAll; the
  // deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["compliance_packs"], auth: AUTH });
});

afterAll(async () => {
  if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
  await db.delete(complianceProfiles).where(inArray(complianceProfiles.tag, [TAG, TAG2, TAG4]));
  if (packIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.objectId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await removeLicenseFixture(db);
});

// ---------------------------------------------------------------------------

describe("B1 — pack activation creates its cascade profile, and the cascade enforces it", () => {
  it("activation CREATES the profile from the pack's preset and says so", async () => {
    packV1Id = await createPack({
      framework: FW,
      cascadeTag: TAG,
      cascadePreset: { piiMode: "block", mcpDefaultMode: "read_only", auditRetentionDays: 365 },
    });
    expect((await profilesForTag(TAG)).length).toBe(0);

    const res = await activate(packV1Id);
    expect(res.statusCode).toBe(200);
    const cp = res.json().cascadeProfile;
    expect(cp.action).toBe("created");
    expect(cp.tag).toBe(TAG);
    expect(cp.profileId).toBeTruthy();
    expect(cp.note).toMatch(/created from the pack's preset/);

    const rows = await profilesForTag(TAG);
    expect(rows.length).toBe(1);
    expect(rows[0]!.piiMode).toBe("block");
    expect(rows[0]!.mcpDefaultMode).toBe("read_only");
    expect(rows[0]!.auditRetentionDays).toBe(365);

    // the creation is AUDITED, attributable to the pack that caused it
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "compliance-pack-cascade-profile-created"));
    const mine = audits.filter((a) => a.objectId === cp.profileId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.reason).toMatch(new RegExp(`created compliance profile '${TAG}'`));
  });

  it("...and the §8.3 cascade GENUINELY enforces it, through the same funnel every consumer uses", async () => {
    const proj = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: "b1-cascade-project", classifications: [TAG] },
    });
    expect(proj.statusCode).toBe(201);
    projectId = proj.json().id;

    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${projectId}/compliance`,
    });
    expect(res.statusCode).toBe(200);
    // effectiveCompliancePolicy over profilesForTags — the pack's preset is
    // now live policy for anything classified with the tag
    expect(res.json().effective.piiMode).toBe("block");
    expect(res.json().effective.auditRetentionDays).toBe(365);
    expect(res.json().profiles.some((p: { tag: string }) => p.tag === TAG)).toBe(true);
  });

  it("re-activation is IDEMPOTENT: the profile is found, never duplicated, never overwritten", async () => {
    // tune the profile first, so "not overwritten" is observable
    const [profile] = await profilesForTag(TAG);
    await db
      .update(complianceProfiles)
      .set({ auditRetentionDays: 999 })
      .where(eq(complianceProfiles.id, profile!.id));

    const res = await activate(packV1Id);
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBe("already active");
    expect(res.json().cascadeProfile.action).toBe("exists_preserved");
    expect(res.json().cascadeProfile.note).toMatch(/NOT applied/);

    const rows = await profilesForTag(TAG);
    expect(rows.length).toBe(1);
    expect(rows[0]!.auditRetentionDays).toBe(999); // the admin's tuning stands
  });

  it("a NEW pack version over the same tag retires the old pack and still preserves the profile", async () => {
    packV2Id = await createPack({
      framework: FW,
      version: 2,
      cascadeTag: TAG,
      cascadePreset: { piiMode: "block", mcpDefaultMode: "read_only", auditRetentionDays: 365 },
    });
    const res = await activate(packV2Id);
    expect(res.statusCode).toBe(200);
    expect(res.json().retired?.id).toBe(packV1Id);
    expect(res.json().cascadeProfile.action).toBe("exists_preserved");
    const rows = await profilesForTag(TAG);
    expect(rows.length).toBe(1);
    expect(rows[0]!.auditRetentionDays).toBe(999);
  });

  it("an EXISTING profile the admin authored first is preserved — presets never overwrite", async () => {
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/profiles",
      payload: { tag: TAG2, piiMode: "warn", mcpDefaultMode: "read_write" },
    });
    expect(created.statusCode).toBe(201);

    const packId = await createPack({
      framework: FW2,
      cascadeTag: TAG2,
      cascadePreset: { piiMode: "block" },
    });
    const res = await activate(packId);
    expect(res.statusCode).toBe(200);
    expect(res.json().cascadeProfile.action).toBe("exists_preserved");

    const rows = await profilesForTag(TAG2);
    expect(rows.length).toBe(1);
    expect(rows[0]!.piiMode).toBe("warn"); // NOT tightened behind the admin's back
  });

  it("a pack with a NULL cascadeTag creates nothing and says why", async () => {
    const packId = await createPack({ framework: FW3 });
    const res = await activate(packId);
    expect(res.statusCode).toBe(200);
    expect(res.json().cascadeProfile.action).toBe("none");
    expect(res.json().cascadeProfile.tag).toBeNull();
    expect(res.json().cascadeProfile.note).toMatch(/forces no §8.3 cascade/);
  });

  it("a tagged pack with NO preset creates nothing and tells the admin to author the profile", async () => {
    const packId = await createPack({ framework: FW4, cascadeTag: TAG4 });
    const res = await activate(packId);
    expect(res.statusCode).toBe(200);
    expect(res.json().cascadeProfile.action).toBe("no_preset");
    expect(res.json().cascadeProfile.note).toMatch(/author one via POST \/v1\/compliance\/profiles/);
    expect((await profilesForTag(TAG4)).length).toBe(0);
  });

  it("DELETING a pack never deletes the profile — enforcement survives the mapping's withdrawal", async () => {
    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/compliance/packs/${packV2Id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toMatch(/deliberately KEPT/);

    expect((await profilesForTag(TAG)).length).toBe(1);
    // ...and it still ENFORCES, proved through the cascade rather than the row
    const compliance = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/projects/${projectId}/compliance`,
    });
    expect(compliance.json().effective.piiMode).toBe("block");
  });

  it("the schema refuses a preset with no tag to hang it on, and an ill-typed preset", async () => {
    const orphan = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/packs",
      payload: packPayload({ framework: "b1-cascade-refused", cascadePreset: { piiMode: "block" } }),
    });
    expect(orphan.statusCode).toBe(400);
    const badType = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/packs",
      payload: packPayload({
        framework: "b1-cascade-refused",
        cascadeTag: "b1-cascade-refused-tag",
        cascadePreset: { auditRetentionDays: "six years" },
      }),
    });
    expect(badType.statusCode).toBe(400);
    const smuggledTag = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/compliance/packs",
      payload: packPayload({
        framework: "b1-cascade-refused",
        cascadeTag: "b1-cascade-refused-tag",
        cascadePreset: { tag: "smuggled" },
      }),
    });
    expect(smuggledTag.statusCode).toBe(400);
  });
});
