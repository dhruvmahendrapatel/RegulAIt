/**
 * ADR-0077 — the cascade-annotated workflow-template gallery.
 *
 * The load-bearing property under test: the gallery's compliance annotations
 * are DERIVED live from the real cascade rules (the compliance profiles'
 * required templates, resolved through the ADR-0073 version funnel — the same
 * source `requiredTemplateIdsFor` enforces), never a hardcoded parallel list.
 * Proof by attack: an invented profile tag appears in the gallery the moment
 * the profile is written (a hardcoded list could not contain it), and FLIPPING
 * the profile's required template moves the annotations on the next read.
 * Controls: the gallery is checked to NOT contain the tag before the profile
 * exists, and to NOT contain the old stage after the flip.
 *
 * Creation goes through the ONE template-creation path: an unresolvable
 * approver is refused with the path's own 422, and the created template is
 * visible through the ordinary templates list.
 *
 * Shares one DB with the other gateway suites (fileParallelism off); every
 * object is prefixed tg-. The profile this suite writes is neutralized in
 * afterAll (M-012: restore every shared knob you flip).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "tg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const TAG = "tg-cascade-flip";

let db: Db;
let app: ReturnType<typeof buildApp>;
let approverId: string;
let nonAdminAuth: { authorization: string };
let tplSecureId: string; // stage tg-sec-gate — the profile's FIRST required template
let tplAltId: string; // stage tg-alt-gate — what the profile is FLIPPED to

interface GalleryEntry {
  galleryId: string;
  source: string;
  profileTag?: string;
  definition: { workflow: string; stages: Array<{ id: string; type: string; approvers?: string[] }> };
  stageAnnotations: Array<{ stageId: string; demandedByTags: string[] }>;
}
interface GalleryBody {
  entries: GalleryEntry[];
  profiles: Array<{
    tag: string;
    piiMode: string;
    auditRetentionDays: number | null;
    mcpDefaultMode: string;
    requiredTemplates: Array<{ id: string; name: string; retired: boolean; stageIds: string[] }>;
    forcedStageIds: string[];
  }>;
}

async function getGallery(): Promise<GalleryBody> {
  const r = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/template-gallery" });
  expect(r.statusCode).toBe(200);
  return r.json() as GalleryBody;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email: "tg-approver@example.com", displayName: "tg-approver" },
  });
  approverId = u.json().id as string;
  const nu = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email: "tg-nonadmin@example.com", displayName: "tg-nonadmin" },
  });
  const key = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${nu.json().id}/keys`, payload: { name: "tg" },
  });
  nonAdminAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  // M-012: this suite wrote a shared compliance profile — neutralize it so no
  // later file inherits a block-mode/retention opinion from this one. (The row
  // itself is scoped to a tag no project carries.)
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: TAG, requiredTemplateIds: [], piiMode: "log", mcpDefaultMode: "read_write", auditRetentionDays: null },
  });
  await app.close();
  await db.$client.end();
});

describe("template gallery — access", () => {
  it("is admin-gated: a non-admin gets 403 on read and create (control: admin reads 200)", async () => {
    const denied = await app.inject({
      method: "GET", headers: nonAdminAuth, url: "/v1/workflows/template-gallery",
    });
    expect(denied.statusCode).toBe(403);
    const deniedCreate = await app.inject({
      method: "POST", headers: nonAdminAuth,
      url: "/v1/workflows/template-gallery/standard-change/create",
      payload: { name: "tg-should-not-exist" },
    });
    expect(deniedCreate.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/template-gallery" });
    expect(ok.statusCode).toBe(200);
  });
});

describe("template gallery — curated shapes", () => {
  it("serves the built-in shapes, every one starting with a trigger", async () => {
    const g = await getGallery();
    const ids = g.entries.map((e) => e.galleryId);
    for (const want of ["standard-change", "design-review", "build-and-check", "hotfix"]) {
      expect(ids, `expected built-in shape '${want}'`).toContain(want);
    }
    expect(g.entries.length).toBeGreaterThanOrEqual(4);
    for (const e of g.entries) {
      expect(e.definition.stages.length).toBeGreaterThan(0);
      expect(e.definition.stages[0]!.type).toBe("trigger");
      // every stage carries an annotation row — even when nothing demands it
      expect(e.stageAnnotations.map((a) => a.stageId)).toEqual(e.definition.stages.map((s) => s.id));
    }
  });
});

describe("template gallery — cascade annotations are DERIVED, proven by flipping a profile", () => {
  it("control: before the profile exists, the gallery knows nothing of the invented tag", async () => {
    const g = await getGallery();
    expect(JSON.stringify(g)).not.toContain(TAG);
  });

  it("writing a profile makes its demands appear, derived from its required template's real stages", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "tg-secure-review",
        definition: { workflow: "tg-secure-review", stages: [
          { id: "tg-intake", type: "trigger" },
          { id: "tg-sec-gate", type: "human_approval", approvers: [approverId] },
        ] },
      },
    });
    expect(tpl.statusCode).toBe(201);
    tplSecureId = tpl.json().id as string;

    const prof = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: {
        tag: TAG,
        requiredTemplateIds: [tplSecureId],
        piiMode: "block",
        mcpDefaultMode: "read_only",
        auditRetentionDays: 1234,
      },
    });
    expect(prof.statusCode).toBe(201);

    const g = await getGallery();
    const ps = g.profiles.find((p) => p.tag === TAG);
    expect(ps).toBeDefined();
    expect(ps!.piiMode).toBe("block");
    expect(ps!.mcpDefaultMode).toBe("read_only");
    expect(ps!.auditRetentionDays).toBe(1234);
    expect(ps!.requiredTemplates.map((t) => t.name)).toEqual(["tg-secure-review"]);
    expect(ps!.forcedStageIds).toContain("tg-sec-gate");

    // a compliance-heavy entry exists for the tag, built by the REAL merge:
    // the standard chain plus the required template's gate (its second trigger
    // deduped away), and the forced stage is annotated with the demanding tag
    const entry = g.entries.find((e) => e.galleryId === `compliance-${TAG}`);
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("compliance_profile");
    const stageIds = entry!.definition.stages.map((s) => s.id);
    expect(stageIds).toContain("tg-sec-gate");
    expect(stageIds).toContain("signoff"); // the standard chain survived the merge
    const gateAnnotation = entry!.stageAnnotations.find((a) => a.stageId === "tg-sec-gate");
    expect(gateAnnotation!.demandedByTags).toContain(TAG);
    // and the annotation is not sprayed everywhere: the standard sign-off is
    // NOT demanded by this profile (its required template has no such stage)
    const signoff = entry!.stageAnnotations.find((a) => a.stageId === "signoff");
    expect(signoff!.demandedByTags).not.toContain(TAG);
  });

  it("FLIPPING the profile's required template moves the annotations on the next read", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "tg-alt-review",
        definition: { workflow: "tg-alt-review", stages: [
          { id: "tg-intake2", type: "trigger" },
          { id: "tg-alt-gate", type: "human_approval", approvers: [approverId] },
        ] },
      },
    });
    expect(tpl.statusCode).toBe(201);
    tplAltId = tpl.json().id as string;

    // the upsert's UPDATE half goes through the ADR-0074 choke point and mints
    // a version — exactly the path an admin edit takes, and exactly what the
    // gallery must follow (it reads through the same version funnel the
    // enforcement cascade reads through)
    const flip = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
      payload: {
        tag: TAG,
        requiredTemplateIds: [tplAltId],
        piiMode: "block",
        mcpDefaultMode: "read_only",
        auditRetentionDays: 1234,
      },
    });
    expect(flip.statusCode).toBe(201);

    const g = await getGallery();
    const ps = g.profiles.find((p) => p.tag === TAG);
    expect(ps!.requiredTemplates.map((t) => t.name)).toEqual(["tg-alt-review"]);
    expect(ps!.forcedStageIds).toContain("tg-alt-gate");
    expect(ps!.forcedStageIds).not.toContain("tg-sec-gate"); // the OLD demand is gone

    const entry = g.entries.find((e) => e.galleryId === `compliance-${TAG}`);
    expect(entry).toBeDefined();
    const stageIds = entry!.definition.stages.map((s) => s.id);
    expect(stageIds).toContain("tg-alt-gate");
    expect(stageIds).not.toContain("tg-sec-gate"); // a stored/hardcoded shape would still carry it
    const gate = entry!.stageAnnotations.find((a) => a.stageId === "tg-alt-gate");
    expect(gate!.demandedByTags).toContain(TAG);
  });
});

describe("create from gallery — the ONE template-creation path", () => {
  it("instantiates a shape as a real template, substituting the named approver, with an audit row", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH,
      url: "/v1/workflows/template-gallery/standard-change/create",
      payload: { name: "tg-from-gallery-std", approverUserId: approverId },
    });
    expect(r.statusCode).toBe(201);
    const created = r.json();
    expect(created.galleryId).toBe("standard-change");

    // visible through the ordinary templates list — a real row, not a shadow
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/templates" });
    const row = (list.json().templates as Array<{ id: string; name: string; definition: { stages: Array<{ id: string; approvers?: string[] }> } }>)
      .find((t) => t.id === created.id);
    expect(row).toBeDefined();
    expect(row!.name).toBe("tg-from-gallery-std");
    const signoff = row!.definition.stages.find((s) => s.id === "signoff");
    expect(signoff!.approvers).toEqual([approverId]); // placeholder substituted

    // the mutation is audited with the gallery provenance
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, "workflow-template-gallery-created"),
          eq(auditLog.objectId, created.id as string),
        ),
      );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.detail as { galleryId?: string }).galleryId).toBe("standard-change");
  });

  it("attack: an unresolvable approver is refused by the SAME validation the plain route applies (422)", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH,
      url: "/v1/workflows/template-gallery/standard-change/create",
      // valid uuid, no such user — the one-path approver resolution must refuse
      payload: { name: "tg-bad-approver", approverUserId: "00000000-0000-4000-8000-00000000dead" },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("invalid_approver");
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/templates" });
    expect((list.json().templates as Array<{ name: string }>).some((t) => t.name === "tg-bad-approver")).toBe(false);
  });

  it("an unknown gallery shape is a 404, not a silent default", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH,
      url: "/v1/workflows/template-gallery/tg-no-such-shape/create",
      payload: { name: "tg-nope" },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("unknown_gallery_entry");
  });

  it("a compliance-derived shape instantiates too — carrying the cascade-forced gate", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH,
      url: `/v1/workflows/template-gallery/compliance-${TAG}/create`,
      payload: { name: "tg-from-gallery-compliance", approverUserId: approverId },
    });
    expect(r.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/workflows/templates" });
    const row = (list.json().templates as Array<{ id: string; name: string; definition: { stages: Array<{ id: string }> } }>)
      .find((t) => t.name === "tg-from-gallery-compliance");
    expect(row).toBeDefined();
    // the flipped profile's gate, not the original one — created THROUGH the derivation
    expect(row!.definition.stages.map((s) => s.id)).toContain("tg-alt-gate");
  });
});
