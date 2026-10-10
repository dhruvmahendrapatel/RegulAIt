/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): supplier-declared SPDX
 * properties, on a real database through the real migrations (0186).
 *
 * The whole file runs on its OWN scratch database (M-040, M-042): declarations
 * are append-only rows, and a fixture must never leave them in the shared one.
 *
 *  - Governed writes: a non-admin is refused (403) and writes nothing; no
 *    credential is 401; every admin write and withdrawal has exactly one audit
 *    row, written in the same transaction; the source is required.
 *  - Strict values: a non-https, path-bearing or credential-bearing download
 *    location, a fractional-second time and a property the parent kind does
 *    not declare are refused (422) and write nothing; the refusal never echoes
 *    the value (synthetic CANARY values).
 *  - Rendering: the loader reads the CURRENT values in the snapshot's
 *    transaction. Partial -> not_producible naming exactly the missing
 *    properties; complete -> SPDX renders, passes B5's cardinality check and
 *    the official schema; a withdrawal puts the name back in the missing list.
 *  - Migration invariants (the 0185-style database guards): UPDATE, DELETE and
 *    TRUNCATE refused; the parent's cascade still deletes; `declared_at` is the
 *    database clock whatever the caller sends; the CHECKs refuse bad shapes
 *    written around the route; every new function pins its search_path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiBomSpdxDeclarations,
  and,
  auditLog,
  createDb,
  eq,
  evalCases,
  evalDatasets,
  evalRuns,
  modelCardEvidence,
  modelCards,
  runMigrations,
  sql,
  trainingArtifacts,
  trainingDatasets,
  trainingJobs,
  type Db,
} from "@regulait/db";
import { buildAiBom, spdxMandatoryMissing, validateSpdx, warmCycloneDxValidators, warmSpdxValidator } from "@regulait/shared";
import { buildApp } from "./app.js";
import { loadAiBomRecords } from "./ai-bom.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `b9_spdx_${RUN}`;
const BOOT = `b9-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;
const ids = {} as Record<"agent" | "card" | "card2" | "training" | "eval", string>;

const inject = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const field = (kind: string, id: string, property?: string) => `/v1/ai-bom/spdx-fields/${kind}/${id}${property ? `/${property}` : ""}`;
const rowsOf = <T>(r: unknown) => (r as { rows: T[] }).rows;
const declCount = async () => Number(rowsOf<{ n: string }>(await db.execute(sql`select count(*)::text as n from ai_bom_spdx_declarations`))[0]!.n);
const auditCount = async (ruleId: string) => (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.ruleId, ruleId))).length;
/** run a statement expected to fail; return the Postgres error message */
async function refused(q: ReturnType<typeof sql>): Promise<string> {
  try {
    await db.execute(q);
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.cause?.message ?? ""} ${err.message ?? ""}`;
  }
  return "ACCEPTED";
}

async function snapshotSpdx() {
  const records = await db.transaction((tx) => loadAiBomRecords(tx as unknown as Db, { kind: "agent", id: ids.agent }, { personIdentifiers: "id_only", installId: null }), { isolationLevel: "repeatable read" });
  const meta = { id: "00000000-0000-4000-8000-0000000b9001", subjectKind: "agent" as const, subjectId: ids.agent, version: 1, supersedes: null, trigger: "on_demand" as const, createdAt: "2026-10-10T12:00:00.000Z" };
  const build = buildAiBom(records, meta, { cyclonedxVersions: ["1.7"] });
  const r = build.renderings.find((x) => x.format === "spdx-3.0.1");
  return { records, build, status: build.body.renderings["spdx-3.0.1"], doc: r ? JSON.parse(r.bytes) : null };
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b9-${k}-${RUN}@example.com`, displayName: `b9 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b9" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  // SYNTHETIC records: one agent, its model card (no pin, no claims), a training dataset reached through a
  // training artifact of the card, and an evaluation dataset reached through eval evidence on the card
  const [a] = await db.insert(agents).values({ name: `b9-agent-${RUN}`, provider: "provider-b9", tier: 1, model: "model-b9", ownerUserId: users.admin.id }).returning({ id: agents.id });
  const [card] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: "B9 synthetic triage", dataClaims: { license: "Apache-2.0" } }).returning({ id: modelCards.id });
  const [card2] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: "B9 cascade probe" }).returning({ id: modelCards.id });
  const [tds] = await db.insert(trainingDatasets).values({ name: `b9-ft-${RUN}`, version: 1, checksum: `sha256:${"d".repeat(64)}:2`, rowCount: 2, piiVerdict: "clean" }).returning({ id: trainingDatasets.id });
  const [job] = await db.insert(trainingJobs).values({ name: "b9-job", datasetId: tds!.id, datasetVersion: 1, backend: "mock", method: "lora_sft", status: "succeeded" } as never).returning({ id: trainingJobs.id });
  await db.insert(trainingArtifacts).values({ jobId: job!.id, name: "b9-inline", method: "lora_sft", kind: "inline", payload: { weights: "synthetic" }, agentId: a!.id, modelCardId: card!.id });
  const [eds] = await db.insert(evalDatasets).values({ name: `b9-golden-${RUN}`, version: 1 }).returning({ id: evalDatasets.id });
  await db.insert(evalCases).values({ datasetId: eds!.id, datasetVersion: 1, input: "synthetic case", expected: { contains: "x" } });
  const [run] = await db.insert(evalRuns).values({ datasetId: eds!.id, datasetVersion: 1, agentId: a!.id, agentName: "b9", trigger: "manual" } as never).returning({ id: evalRuns.id });
  await db.insert(modelCardEvidence).values({ cardId: card!.id, kind: "eval_run", evalRunId: run!.id });
  Object.assign(ids, { agent: a!.id, card: card!.id, card2: card2!.id, training: tds!.id, eval: eds!.id });
  warmCycloneDxValidators();
  warmSpdxValidator();
}, 300_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
  await dropScratchDatabase(admin, SCRATCH);
  await (admin.$client as { end: () => Promise<void> }).end();
}, 120_000);

describe("B9: the write routes are governed (default-deny, audited)", () => {
  it("a non-admin is refused on every route and writes nothing; no credential is 401", async () => {
    const before = await declCount();
    const put = await inject("PUT", field("model_card", ids.card, "releaseTime"), users.member.auth, { value: "2026-01-02T03:04:05Z", source: "supplier_declared" });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe("admin_only");
    expect((await inject("POST", `${field("model_card", ids.card, "releaseTime")}/withdraw`, users.member.auth, {})).statusCode).toBe(403);
    expect((await inject("GET", field("model_card", ids.card), users.member.auth)).statusCode).toBe(403);
    expect((await inject("PUT", field("model_card", ids.card, "releaseTime"), {}, { value: "2026-01-02T03:04:05Z", source: "supplier_declared" })).statusCode).toBe(401);
    expect(await declCount()).toBe(before);
  });

  it("an admin write is stored with database-clock provenance and exactly one audit row", async () => {
    const audits = await auditCount("ai-bom-spdx-field-declared");
    const t0 = rowsOf<{ now: string }>(await db.execute(sql`select now()::text as now`))[0]!.now;
    const r = await inject("PUT", field("model_card", ids.card, "releaseTime"), users.admin.auth, { value: "2026-01-02T05:04:05+02:00", source: "supplier_declared" });
    expect(r.statusCode, r.body).toBe(200);
    const d = r.json().declaration;
    expect(d).toMatchObject({ property: "releaseTime", value: "2026-01-02T03:04:05Z", source: "supplier_declared", withdrawn: false, declaredByUserId: users.admin.id });
    expect(Date.parse(d.declaredAt)).toBeGreaterThanOrEqual(Date.parse(t0));
    expect(await auditCount("ai-bom-spdx-field-declared")).toBe(audits + 1);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "ai-bom-spdx-field-declared"), eq(auditLog.objectId, ids.card)));
    expect(a).toMatchObject({ userId: users.admin.id, objectType: "model_card", effect: "allow" });
    expect(a!.detail).toMatchObject({ property: "releaseTime", source: "supplier_declared", seq: d.seq, value: "2026-01-02T03:04:05Z" });
  });

  it("the source is required and the body is strict", async () => {
    const before = await declCount();
    for (const body of [{ value: "v1" }, { value: "v1", source: "guessed" }, { value: "v1", source: "admin_entered", declaredAt: "2020-01-01T00:00:00Z" }]) {
      const r = await inject("PUT", field("model_card", ids.card, "packageVersion"), users.admin.auth, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await declCount()).toBe(before);
  });
});

describe("B9: strict values, refused and never echoed", () => {
  const cases: Array<[string, string, string, unknown, number, string]> = [
    ["http", "model_card", "downloadLocation", "http://models.supplier-b9.example", 422, "download_location_not_https"],
    ["userinfo", "model_card", "downloadLocation", "https://svc:CANARY_B9_PASS@models.supplier-b9.example", 422, "download_location_credentials"],
    ["path with a token", "model_card", "downloadLocation", "https://models.supplier-b9.example/bot1:sk-live-CANARY0123456789abcdefABCD/w", 422, "download_location_not_origin"],
    ["query", "training_dataset", "downloadLocation", "https://data.supplier-b9.example?token=CANARY_B9_QS", 422, "download_location_not_origin"],
    ["fractional seconds", "training_dataset", "builtTime", "2026-03-15T08:00:00.250Z", 422, "spdx_time_invalid"],
    ["credential-shaped version", "model_card", "packageVersion", "sk-live-CANARY0123456789abcdefABCD", 422, "credential_shaped"],
    ["email-shaped originator", "eval_dataset", "originatedBy", "ops@supplier-b9.example", 422, "originated_by_invalid"],
    ["unknown dataset type", "eval_dataset", "datasetType", ["tabular"], 422, "dataset_type_invalid"],
  ];
  for (const [what, kind, property, value, status, rule] of cases) {
    it(`refuses ${what}`, async () => {
      const before = await declCount();
      const id = kind === "model_card" ? ids.card : kind === "training_dataset" ? ids.training : ids.eval;
      const r = await inject("PUT", field(kind, id, property), users.admin.auth, { value, source: "supplier_declared" });
      expect(r.statusCode, r.body).toBe(status);
      expect(r.json()).toMatchObject({ error: "invalid_spdx_declaration", rule, property });
      expect(r.body).not.toContain("CANARY");
      expect(await declCount()).toBe(before);
    });
  }

  it("a property the parent kind does not declare, an unknown kind and an unknown parent are refused", async () => {
    expect((await inject("PUT", field("model_card", ids.card, "builtTime"), users.admin.auth, { value: "2026-03-15T08:00:00Z", source: "supplier_declared" })).json().error).toBe("spdx_property_not_allowed");
    expect((await inject("PUT", field("agent", ids.agent, "releaseTime"), users.admin.auth, { value: "2026-03-15T08:00:00Z", source: "supplier_declared" })).statusCode).toBe(400);
    const missing = await inject("PUT", field("training_dataset", "00000000-0000-4000-8000-0000000b9999", "builtTime"), users.admin.auth, { value: "2026-03-15T08:00:00Z", source: "supplier_declared" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("B9: the loader and the SPDX renderer (R3, R51)", () => {
  it("partial -> not_producible naming exactly the missing properties, never a placeholder", async () => {
    // so far: the first card has releaseTime only; the second card and the datasets have nothing; no pin, no
    // claim. B5 names missing properties per class, so the second card keeps ai_AIPackage.releaseTime listed.
    const s = await snapshotSpdx();
    expect(s.records.spdxFields).toHaveLength(1);
    expect(s.status).toEqual({
      status: "not_producible",
      missing: [
        "ai_AIPackage.releaseTime", "ai_AIPackage.software_downloadLocation", "ai_AIPackage.software_packageVersion",
        "dataset_DatasetPackage.builtTime", "dataset_DatasetPackage.originatedBy", "dataset_DatasetPackage.releaseTime", "dataset_DatasetPackage.software_downloadLocation",
      ],
    });
    expect(s.doc).toBeNull();
  });

  it("complete -> SPDX renders, passes B5's cardinality check and the official schema", async () => {
    const put = async (kind: string, id: string, property: string, value: unknown, source = "supplier_declared") => {
      const r = await inject("PUT", field(kind, id, property), users.admin.auth, { value, source });
      expect(r.statusCode, `${kind}.${property} ${r.body}`).toBe(200);
    };
    await put("model_card", ids.card, "downloadLocation", "https://models.supplier-b9.example");
    await put("model_card", ids.card, "packageVersion", "b9-2026.01", "admin_entered");
    // the second card is in the same agent's BOM; it needs its values too
    await put("model_card", ids.card2, "releaseTime", "2026-02-01T00:00:00Z");
    await put("model_card", ids.card2, "downloadLocation", "https://models.supplier-b9.example:8443");
    await put("model_card", ids.card2, "packageVersion", "b9-2026.02");
    for (const [kind, id] of [["training_dataset", ids.training], ["eval_dataset", ids.eval]] as const) {
      await put(kind, id, "builtTime", "2026-03-15T08:00:00Z");
      await put(kind, id, "originatedBy", "Synthetic Data Supplier B9");
      await put(kind, id, "releaseTime", "2026-04-01T09:30:00Z");
      await put(kind, id, "downloadLocation", "https://data.supplier-b9.example");
      await put(kind, id, "datasetType", ["text"]);
    }
    const s = await snapshotSpdx();
    expect(s.status).toMatchObject({ status: "rendered" });
    expect(spdxMandatoryMissing(s.doc)).toEqual([]);
    expect(validateSpdx(s.doc).errors).toEqual([]);
    const ds = (s.doc["@graph"] as Array<Record<string, any>>).filter((e) => e.type === "dataset_DatasetPackage");
    expect(ds.map((d) => [d.builtTime, d.releaseTime, d.software_downloadLocation, d.dataset_datasetType])).toEqual([
      ["2026-03-15T08:00:00Z", "2026-04-01T09:30:00Z", "https://data.supplier-b9.example", ["text"]],
      ["2026-03-15T08:00:00Z", "2026-04-01T09:30:00Z", "https://data.supplier-b9.example", ["text"]],
    ]);
    const models = (s.doc["@graph"] as Array<Record<string, any>>).filter((e) => e.type === "ai_AIPackage");
    expect(models.map((m) => m.software_packageVersion).sort()).toEqual(["b9-2026.01", "b9-2026.02"]);
    // the declarations are in the signed native body and its basis
    expect(s.build.basis.filter((b) => b.table === "ai_bom_spdx_declarations")).toHaveLength(4);
  });

  it("a correction supersedes; a withdrawal is audited and puts the name back in the missing list", async () => {
    const corr = await inject("PUT", field("model_card", ids.card, "releaseTime"), users.admin.auth, { value: "2026-01-03T00:00:00Z", source: "admin_entered" });
    expect(corr.statusCode).toBe(200);
    const get = (await inject("GET", field("model_card", ids.card), users.admin.auth)).json();
    expect(get.current.find((c: { property: string }) => c.property === "releaseTime")).toMatchObject({ value: "2026-01-03T00:00:00Z", source: "admin_entered" });
    expect(get.history.filter((h: { property: string }) => h.property === "releaseTime")).toHaveLength(2);
    expect(get.undeclared).toEqual([]);

    const audits = await auditCount("ai-bom-spdx-field-withdrawn");
    const w = await inject("POST", `${field("training_dataset", ids.training, "originatedBy")}/withdraw`, users.admin.auth, {});
    expect(w.statusCode, w.body).toBe(200);
    expect(w.json().declaration).toMatchObject({ property: "originatedBy", withdrawn: true, value: null });
    expect(await auditCount("ai-bom-spdx-field-withdrawn")).toBe(audits + 1);
    expect((await inject("POST", `${field("training_dataset", ids.training, "originatedBy")}/withdraw`, users.admin.auth, {})).statusCode).toBe(409);
    expect((await inject("GET", field("training_dataset", ids.training), users.admin.auth)).json().undeclared).toEqual(["originatedBy"]);
    const s = await snapshotSpdx();
    expect(s.status).toEqual({ status: "not_producible", missing: ["dataset_DatasetPackage.originatedBy"] });
  });
});

describe("B9: migration 0186 invariants", () => {
  it("UPDATE, DELETE and TRUNCATE are refused", async () => {
    expect(await refused(sql`update ai_bom_spdx_declarations set source = 'admin_entered'`)).toMatch(/append-only: UPDATE refused/);
    expect(await refused(sql`delete from ai_bom_spdx_declarations`)).toMatch(/append-only: DELETE refused/);
    expect(await refused(sql`truncate ai_bom_spdx_declarations`)).toMatch(/TRUNCATE refused/);
  });

  it("declared_at is the database clock, whatever the caller sends", async () => {
    const [r] = await db
      .insert(aiBomSpdxDeclarations)
      .values({ modelCardId: ids.card2, property: "packageVersion", valueText: "b9-clock", source: "admin_entered", declaredByUserId: users.admin.id, declaredAt: new Date("2001-01-01T00:00:00Z") })
      .returning();
    expect(r!.declaredAt.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("the CHECKs refuse shapes written around the route", async () => {
    const u = users.admin.id;
    const ins = (cols: string, vals: ReturnType<typeof sql>) => refused(sql`insert into ai_bom_spdx_declarations (${sql.raw(cols)}, source, declared_by_user_id) values (${vals}, 'admin_entered', ${u})`);
    const c = ids.card;
    expect(await ins("model_card_id, property, value_text", sql`${c}, 'downloadLocation', 'https://x.example/path'`)).toMatch(/download_location_check/);
    expect(await ins("model_card_id, property, value_text", sql`${c}, 'downloadLocation', 'http://x.example'`)).toMatch(/download_location_check/);
    expect(await ins("model_card_id, property, value_text", sql`${c}, 'downloadLocation', 'https://u:p@x.example'`)).toMatch(/download_location_check/);
    expect(await ins("model_card_id, property, value_time", sql`${c}, 'releaseTime', '2026-01-01T00:00:00.5Z'`)).toMatch(/time_check/);
    expect(await ins("model_card_id, property, value_time", sql`${c}, 'builtTime', '2026-01-01T00:00:00Z'`)).toMatch(/property_check/);
    expect(await ins("model_card_id, training_dataset_id, property, value_text", sql`${c}, ${ids.training}, 'downloadLocation', 'https://x.example'`)).toMatch(/one_parent_check/);
    expect(await ins("model_card_id, property, value_text", sql`${c}, 'packageVersion', 'a@b'`)).toMatch(/package_version_check/);
    expect(await ins("training_dataset_id, property, value_list", sql`${ids.training}, 'datasetType', ARRAY['tabular']::text[]`)).toMatch(/dataset_type_check/);
    expect(await ins("model_card_id, property, value_text, value_time", sql`${c}, 'packageVersion', 'v1', now()`)).toMatch(/shape_check/);
    // positive control: the same insert in a valid shape is accepted
    expect(await ins("model_card_id, property, value_text", sql`${c}, 'downloadLocation', 'https://x.example:8443'`)).toBe("ACCEPTED");
  });

  it("the parent's own cascade deletes its declarations; nothing else can", async () => {
    const n = async () => Number(rowsOf<{ n: string }>(await db.execute(sql`select count(*)::text as n from ai_bom_spdx_declarations where model_card_id = ${ids.card2}`))[0]!.n);
    expect(await n()).toBeGreaterThan(0);
    await db.delete(modelCards).where(eq(modelCards.id, ids.card2));
    expect(await n()).toBe(0);
  });

  it("every function the migration adds pins its search_path", async () => {
    const fns = rowsOf<{ proname: string; proconfig: string[] | null }>(
      await db.execute(sql`select proname, proconfig from pg_proc where proname in ('regulait_ai_bom_spdx_declaration_guard', 'regulait_ai_bom_spdx_declaration_stamp')`),
    );
    expect(fns).toHaveLength(2);
    for (const f of fns) expect(f.proconfig, f.proname).toContain("search_path=pg_catalog, public, pg_temp");
  });
});
