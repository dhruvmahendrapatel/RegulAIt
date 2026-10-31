/**
 * ADR-0215 — framework content imports and the imported regulatory feed, through the routes.
 *
 * Pinned: the routes refuse (audited) while the org setting is off; a proposal is
 * deterministic (rejecting and re-proposing gives the same plan and hash);
 * accepting creates a NEW draft pack version and never overwrites a control an
 * admin edited unless the admin names it; a bad resolution or a changed base
 * pack refuses with nothing written; every decision is audited; an accepted
 * feed import joins `GET /v1/regulatory/updates` and leaves it when imports are
 * turned off. The routes read a fixture directory (unique framework and source
 * ids per run), so the shared database's real packs are untouched (M-008, M-040).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  createDb,
  eq,
  frameworkImportProposals,
  orgSettings,
  runMigrations,
  type Db,
} from "@regulait/db";
import { FRAMEWORK_IMPORT_SCHEMA, REGULATORY_FEED_IMPORT_SCHEMA } from "@regulait/shared";
import { buildApp } from "./app.js";
import { FRAMEWORK_IMPORT_RULE_IDS, setFrameworkImportDataDirForTest } from "./framework-imports.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g215-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const FW = `p5t-${RUN}`;
const SRC = `p5t-src-${RUN}`;
const FEED = `p5t-feed-${RUN}`;
const ref = (id: string) => `${FW}:${id}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let dir = "";
let enabledBefore = false;

const source = (version: string) => ({
  sourceId: SRC,
  framework: FW,
  title: "Test framework",
  publisher: "Test publisher",
  licence: "CC0-1.0",
  licenceUrl: "https://example.org/licence",
  upstreamUrl: "https://example.org/catalog.json",
  sourceVersion: version,
  upstreamRevision: version,
  upstreamSha256: "a".repeat(64),
  retrievedOn: "2026-10-30",
});

function writePackSnapshot(version: string, controls: Array<[string, string]>) {
  writeFileSync(
    path.join(dir, `${SRC}.json`),
    JSON.stringify({
      schema: FRAMEWORK_IMPORT_SCHEMA,
      source: source(version),
      controls: controls.map(([id, title]) => ({ controlRef: ref(id), title, description: null })).sort((a, b) => (a.controlRef < b.controlRef ? -1 : 1)),
    }),
  );
  setFrameworkImportDataDirForTest(dir);
}

function writeFeedSnapshot() {
  const { framework: _fw, ...feedSource } = source("2026-10-30");
  writeFileSync(
    path.join(dir, `${FEED}.json`),
    JSON.stringify({
      schema: REGULATORY_FEED_IMPORT_SCHEMA,
      source: { ...feedSource, sourceId: FEED },
      entries: [
        {
          key: `us-fr-${RUN}`,
          jurisdiction: "US",
          instrument: "Federal Register test",
          title: `Imported AI rule ${RUN}`,
          summary: "An imported entry.",
          instrumentKind: "law",
          effectiveDate: "2026-01-01",
          status: "in_force",
          frameworks: [],
          controlRefs: [],
          sourceUrl: "https://www.federalregister.gov/d/test",
          verifiedOn: "2026-10-30",
        },
      ],
    }),
  );
  setFrameworkImportDataDirForTest(dir);
}

const setEnabled = (on: boolean) => db.update(orgSettings).set({ frameworkImportsEnabled: on });
const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: AUTH, payload: payload as Record<string, unknown> });
const get = (url: string) => app.inject({ method: "GET", url, headers: AUTH });

async function packControls(version: number) {
  const [pack] = await db.select().from(compliancePacks).where(and(eq(compliancePacks.framework, FW), eq(compliancePacks.version, version)));
  if (!pack) return null;
  const rows = await db.select().from(compliancePackControls).where(eq(compliancePackControls.packId, pack.id));
  return { pack, byRef: new Map(rows.map((r) => [r.controlRef, r])) };
}

const auditFor = (objectId: string) => db.select().from(auditLog).where(eq(auditLog.objectId, objectId));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await get("/v1/org/settings"); // ensures the singleton row exists
  const [row] = await db.select({ on: orgSettings.frameworkImportsEnabled }).from(orgSettings);
  enabledBefore = row?.on ?? false;
  dir = mkdtempSync(path.join(tmpdir(), "p5-imports-"));
  writePackSnapshot("1", [
    ["A", "A — first text"],
    ["B", "B — first text"],
  ]);
  writeFeedSnapshot();
}, 120_000);

afterAll(async () => {
  try {
    await setEnabled(enabledBefore);
  } finally {
    setFrameworkImportDataDirForTest(null);
    rmSync(dir, { recursive: true, force: true });
    app.server.closeAllConnections();
    await app.close();
  }
});

describe("ADR-0215 framework imports", () => {
  it("refuses every write while imports are off, and audits the refusal", async () => {
    await setEnabled(false);
    const res = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("framework_imports_disabled");
    const denied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, FRAMEWORK_IMPORT_RULE_IDS.refusedDisabled), eq(auditLog.effect, "deny")));
    expect(denied.length).toBeGreaterThan(0);
    const list = await get("/v1/compliance/framework-imports");
    expect(list.statusCode).toBe(200);
    expect(list.json().enabled).toBe(false);
    expect(list.json().sources.map((s: { sourceId: string }) => s.sourceId)).toContain(SRC);
  });

  it("imports a new framework as draft version 1, audited", async () => {
    await setEnabled(true);
    const proposed = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(proposed.statusCode).toBe(201);
    const { proposal, plan } = proposed.json();
    expect(plan.summary).toMatchObject({ added: 2 });
    expect(plan.toVersion).toBe(1);
    // nothing changed yet
    expect(await packControls(1)).toBeNull();
    const accepted = await post(`/v1/compliance/framework-imports/proposals/${proposal.id}/accept`, { takeIncoming: [] });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().pack).toMatchObject({ framework: FW, version: 1, status: "draft" });
    const v1 = await packControls(1);
    expect(v1!.byRef.get(ref("A"))).toMatchObject({ title: "A — first text", coverage: "unaddressed", collector: "none" });
    const rules = (await auditFor(proposal.id)).map((r) => r.ruleId).sort();
    expect(rules).toEqual([FRAMEWORK_IMPORT_RULE_IDS.accepted, FRAMEWORK_IMPORT_RULE_IDS.proposed].sort());
    // a decided proposal cannot be decided again
    expect((await post(`/v1/compliance/framework-imports/proposals/${proposal.id}/reject`)).statusCode).toBe(409);
  });

  it("never overwrites a control an admin edited, unless the admin names it", async () => {
    // the admin maps A and rewrites its text in a new version
    const v1 = await packControls(1);
    const controls = [...v1!.byRef.values()].map((c) => ({
      controlRef: c.controlRef,
      title: c.controlRef === ref("A") ? "A — our own wording" : c.title,
      description: c.description,
      coverage: c.controlRef === ref("A") ? "evidenced" : c.coverage,
      collector: c.controlRef === ref("A") ? "approvals" : c.collector,
      collectorParams: {},
      minEvidenceCount: 2,
      attestationRequired: false,
      ownerNote: null,
    }));
    const authored = await post("/v1/compliance/packs", {
      framework: FW,
      version: 2,
      title: "Test framework (our mapping)",
      provenance: { source: "admin" },
      controls,
    });
    expect(authored.statusCode).toBe(201);

    // upstream revises A and B and adds C
    writePackSnapshot("2", [
      ["A", "A — revised upstream"],
      ["B", "B — revised upstream"],
      ["C", "C — new upstream"],
    ]);
    const first = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(first.statusCode).toBe(201);
    const kinds = Object.fromEntries(first.json().plan.changes.map((c: { controlRef: string; kind: string }) => [c.controlRef, c.kind]));
    expect(kinds).toEqual({ [ref("A")]: "kept_edited", [ref("B")]: "text_updated", [ref("C")]: "added" });

    // a second proposal while one is pending is refused
    expect((await post(`/v1/compliance/framework-imports/${SRC}/proposals`)).statusCode).toBe(409);

    // deterministic: reject and propose again, same plan and hash
    expect((await post(`/v1/compliance/framework-imports/proposals/${first.json().proposal.id}/reject`)).statusCode).toBe(200);
    const second = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(second.statusCode).toBe(201);
    expect(JSON.stringify(second.json().plan)).toBe(JSON.stringify(first.json().plan));
    const id = second.json().proposal.id as string;

    // a resolution that names no kept control refuses and writes nothing
    const bad = await post(`/v1/compliance/framework-imports/proposals/${id}/accept`, { takeIncoming: [ref("C")] });
    expect(bad.statusCode).toBe(400);
    expect(await packControls(3)).toBeNull();
    const [still] = await db.select().from(frameworkImportProposals).where(eq(frameworkImportProposals.id, id));
    expect(still!.status).toBe("pending");
    expect((await auditFor(id)).map((r) => r.ruleId)).toEqual([FRAMEWORK_IMPORT_RULE_IDS.proposed]);

    const ok = await post(`/v1/compliance/framework-imports/proposals/${id}/accept`, { takeIncoming: [] });
    expect(ok.statusCode).toBe(201);
    const v3 = await packControls(3);
    expect(v3!.pack.status).toBe("draft");
    expect(v3!.byRef.get(ref("A"))).toMatchObject({ title: "A — our own wording", coverage: "evidenced", collector: "approvals", minEvidenceCount: 2 });
    expect(v3!.byRef.get(ref("B"))).toMatchObject({ title: "B — revised upstream", minEvidenceCount: 2 });
    expect(v3!.byRef.get(ref("C"))).toMatchObject({ title: "C — new upstream", coverage: "unaddressed" });
    // the earlier versions are untouched
    expect((await packControls(2))!.byRef.get(ref("B"))!.title).toBe("B — first text");
    const acceptedAudit = (await auditFor(id)).find((r) => r.ruleId === FRAMEWORK_IMPORT_RULE_IDS.accepted);
    expect(acceptedAudit!.detail).toMatchObject({ toVersion: 3, takeIncoming: [], summary: { kept_edited: 1, text_updated: 1, added: 1 } });

    // the same content again is no change, and the edit is still kept
    const again = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(again.statusCode).toBe(200);
    expect(again.json().noChange).toBe(true);
  });

  it("overwrites an edited control only when named, and refuses when the base pack moved", async () => {
    writePackSnapshot("3", [
      ["A", "A — third upstream"],
      ["B", "B — revised upstream"],
      ["C", "C — new upstream"],
    ]);
    const stale = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(stale.statusCode).toBe(201);
    // the admin authors v4 while the proposal waits: the proposal's base is gone
    const v3 = await packControls(3);
    const authored = await post("/v1/compliance/packs", {
      framework: FW,
      version: 4,
      title: "Test framework (our mapping)",
      provenance: { source: "admin" },
      controls: [...v3!.byRef.values()].map((c) => ({
        controlRef: c.controlRef,
        title: c.title,
        description: c.description,
        coverage: c.coverage,
        collector: c.collector,
        collectorParams: {},
        minEvidenceCount: c.minEvidenceCount,
        attestationRequired: c.attestationRequired,
        ownerNote: c.ownerNote,
      })),
    });
    expect(authored.statusCode).toBe(201);
    const refused = await post(`/v1/compliance/framework-imports/proposals/${stale.json().proposal.id}/accept`, { takeIncoming: [ref("A")] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("import_base_changed");
    expect(await packControls(5)).toBeNull();
    expect((await post(`/v1/compliance/framework-imports/proposals/${stale.json().proposal.id}/reject`)).statusCode).toBe(200);

    const fresh = await post(`/v1/compliance/framework-imports/${SRC}/proposals`);
    expect(fresh.statusCode).toBe(201);
    const ok = await post(`/v1/compliance/framework-imports/proposals/${fresh.json().proposal.id}/accept`, { takeIncoming: [ref("A")] });
    expect(ok.statusCode).toBe(201);
    const v5 = await packControls(5);
    expect(v5!.byRef.get(ref("A"))).toMatchObject({ title: "A — third upstream", coverage: "evidenced", collector: "approvals" });
    const audit = (await auditFor(fresh.json().proposal.id)).find((r) => r.ruleId === FRAMEWORK_IMPORT_RULE_IDS.accepted);
    expect(audit!.detail).toMatchObject({ takeIncoming: [ref("A")], summary: { edited_replaced: 1 } });
  });
});

describe("ADR-0215 the imported regulatory feed", () => {
  it("joins the feed only once accepted, audited, and leaves it when imports are off", async () => {
    await setEnabled(true);
    const key = `us-fr-${RUN}`;
    const keys = async () => ((await get("/v1/regulatory/updates")).json().updates as Array<{ key: string }>).map((u) => u.key);
    expect(await keys()).not.toContain(key);
    const proposed = await post(`/v1/regulatory/feed-imports/${FEED}/proposals`);
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().diff).toMatchObject({ added: [key], removed: [], changed: [] });
    expect(await keys()).not.toContain(key);
    const id = proposed.json().feedImport.id as string;
    // the review view lists the entries themselves, not only their count
    const review = await get(`/v1/regulatory/feed-imports/${id}`);
    expect(review.statusCode).toBe(200);
    expect(review.json().feedImport).toMatchObject({
      status: "pending",
      added: [
        {
          key,
          title: `Imported AI rule ${RUN}`,
          instrument: "Federal Register test",
          effectiveDate: "2026-01-01",
          status: "in_force",
          sourceUrl: "https://www.federalregister.gov/d/test",
        },
      ],
      changed: [],
      removed: [],
    });
    expect((await get("/v1/regulatory/feed-imports/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    expect((await post(`/v1/regulatory/feed-imports/${id}/accept`)).statusCode).toBe(200);
    expect(await keys()).toContain(key);
    const rules = (await auditFor(id)).map((r) => r.ruleId).sort();
    expect(rules).toEqual([FRAMEWORK_IMPORT_RULE_IDS.feedAccepted, FRAMEWORK_IMPORT_RULE_IDS.feedProposed].sort());
    // the same snapshot again is no change
    const again = await post(`/v1/regulatory/feed-imports/${FEED}/proposals`);
    expect(again.statusCode).toBe(200);
    expect(again.json().noChange).toBe(true);
    await setEnabled(false);
    expect(await keys()).not.toContain(key);
  });
});
