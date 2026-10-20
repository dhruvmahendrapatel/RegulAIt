/**
 * ADR-0195 SD3 phase B — endpoint evidence imported into SD0 (real database).
 *
 *  - the endpoint signature seed installs as `identifier` rows, idempotently;
 *  - an osquery results file: a dry run writes no finding; apply opens a run for
 *    the source and commits device findings through SD0's fenced path, with the
 *    device kept only as an SD0 pseudonym and no username stored anywhere;
 *  - a file with a refused row is refused whole by default, and nothing is written;
 *  - an MDM/EDR inventory export imports through its own source kind;
 *  - the routes are admin-only and need an enabled endpoint source.
 *
 * Everything this suite creates is removed in afterAll (sources and their runs,
 * findings, imports, pseudonyms and the seeded rows it inserted), so other
 * suites keep seeing an empty catalogue and "nothing is scanned".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  auditLog,
  createDb,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySources,
  eq,
  inArray,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  users,
  type Db,
} from "@regulait/db";
import Fastify from "fastify";
import { buildApp } from "./app.js";
import { ObservationRefused } from "./discovery-worker.js";
import { registerEndpointImportRoutes } from "./endpoint-import-routes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `sd3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
// synthetic, derived at runtime (gitleaks): never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`sd3-data-key-${RUN}`).digest("hex");
const HOST = `sd3-host-${RUN}`;
const USERNAME = `sd3user${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];
let signatureIdsBefore = new Set<string>();

type Method = "GET" | "POST";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

async function mkUser(label: string, isAdmin: boolean) {
  const u = await inject("POST", "/v1/users", AUTH, { email: `sd3-${label}-${RUN}@example.com`, displayName: `sd3 ${label}` });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  if (isAdmin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

/** per-run counter: SD0 refuses a duplicate source name (409 name_taken), so every source gets its own */
let sourceSeq = 0;
async function endpointSource(kind: "endpoint_osquery" | "endpoint_inventory", enabled = true) {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `sd3-${kind}-${enabled}-${RUN}-${++sourceSeq}`, kind, target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  sourceIds.push(id);
  // enabling is SD0's step-up route (covered by SD0's suite); here the row is set directly
  if (enabled) await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, id));
  return id;
}

const osqueryFile = [
  JSON.stringify({
    name: "pack/regulait_ai_discovery/ai_apps_macos",
    hostIdentifier: HOST,
    unixTime: 1790000000,
    snapshot: [
      { name: "Claude.app", bundle_identifier: "com.anthropic.claudefordesktop", path: "/Applications/Claude.app", element: "0" },
      { name: `Unknown-${RUN}.app`, bundle_identifier: `org.example.${RUN}`, path: `/Users/${USERNAME}/Applications/Unknown.app`, element: "0" },
    ],
  }),
  JSON.stringify({
    name: "pack/regulait_ai_discovery/ai_ide_extensions_vscode",
    hostIdentifier: HOST,
    unixTime: 1790000100,
    columns: { username: USERNAME, extension_id: "anthropic.claude-code", version: "1.0.0" },
    action: "added",
  }),
].join("\n");

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  adminId = (await mkUser("admin", true)).id;
  memberKey = (await mkUser("member", false)).key;
  signatureIdsBefore = new Set((await db.select({ id: aiEndpointSignatures.id }).from(aiEndpointSignatures)).map((r) => r.id));
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    const runs = (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(inArray(discoveryRuns.sourceId, sourceIds))).map((r) => r.id);
    if (runs.length) {
      const imports = (await db.select({ id: shadowAiImports.id }).from(shadowAiImports).where(inArray(shadowAiImports.discoveryRunId, runs))).map((r) => r.id);
      if (imports.length) {
        await db.delete(shadowAiFindings).where(inArray(shadowAiFindings.lastImportId, imports));
        await db.delete(shadowAiImports).where(inArray(shadowAiImports.id, imports));
      }
    }
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  const added = (await db.select({ id: aiEndpointSignatures.id }).from(aiEndpointSignatures)).map((r) => r.id).filter((id) => !signatureIdsBefore.has(id));
  if (added.length) await db.delete(aiEndpointSignatures).where(inArray(aiEndpointSignatures.id, added));
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0195 SD3 endpoint imports into SD0", () => {
  it("is admin-only", async () => {
    expect((await inject("POST", "/v1/discovery/endpoint-signatures/seed", memberKey, {})).statusCode).toBe(403);
    expect((await inject("POST", `/v1/discovery/sources/00000000-0000-4000-8000-000000000000/endpoint-imports`, memberKey, { content: "x" })).statusCode).toBe(403);
  });

  it("installs the endpoint signature seed as identifier rows, idempotently", async () => {
    const first = await inject("POST", "/v1/discovery/endpoint-signatures/seed", AUTH, {});
    expect(first.statusCode, first.body).toBe(200);
    const again = await inject("POST", "/v1/discovery/endpoint-signatures/seed", AUTH, {});
    expect(again.json().inserted).toBe(0);
    const [row] = await db.select().from(aiEndpointSignatures).where(eq(aiEndpointSignatures.value, "com.anthropic.claudefordesktop"));
    expect(row?.kind).toBe("desktop_app");
    expect(row?.matchType).toBe("identifier");
    expect(row?.os).toBe("macos");
    expect(row?.toolId).toBe("claude");
    expect(row?.confidence).toBe("high");
    const lan = await db.select().from(aiEndpointSignatures).where(eq(aiEndpointSignatures.value, "trait:hidden_path+listen_all_interfaces"));
    expect(lan[0]?.confidence).toBe("low");
    expect(lan[0]?.enabled).toBe(true);
  });

  it("refuses a disabled source", async () => {
    const id = await endpointSource("endpoint_osquery", false);
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: osqueryFile });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("source_disabled");
  });

  it("dry-runs, then applies an osquery file: device findings under a pseudonym, no username stored", async () => {
    const id = await endpointSource("endpoint_osquery");
    const findingsBefore = (await db.select({ id: shadowAiFindings.id }).from(shadowAiFindings)).length;

    const dry = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: osqueryFile });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().summary.rowsParsed).toBe(3);
    expect(dry.json().summary.observationsUnmatched).toBe(1);
    expect((dry.json().matchedArtifacts as Array<{ provider: string }>).some((a) => a.provider === "anthropic")).toBe(true);
    expect((await db.select({ id: shadowAiFindings.id }).from(shadowAiFindings)).length).toBe(findingsBefore);
    expect(dry.body.includes(HOST) || dry.body.includes(USERNAME)).toBe(false);

    const applied = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: osqueryFile, mode: "apply", source: "results.log" });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json().findingsCreated).toBeGreaterThanOrEqual(1);
    const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, applied.json().runId));
    expect(run?.status).toBe("succeeded");
    expect(run?.rawOutputSha256).toBe(createHash("sha256").update(osqueryFile, "utf8").digest("hex"));
    expect((run?.catalogueGaps as Array<{ value: string }>).some((g) => g.value === `Unknown-${RUN}.app`)).toBe(true);

    const imports = await db.select().from(shadowAiImports).where(eq(shadowAiImports.discoveryRunId, run!.id));
    expect(imports.map((i) => i.kind)).toEqual(["endpoint_osquery"]);
    const findings = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.lastImportId, imports[0]!.id));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const f of findings) {
      expect(f.subjectKind).toBe("device");
      expect(f.subject).toMatch(/^psn:[0-9a-f]{24}$/);
      const dump = JSON.stringify(f);
      expect(dump.includes(HOST)).toBe(false);
      expect(dump.includes(USERNAME)).toBe(false);
    }
    // the device has an SD0 pseudonym row; the username is held only as an enveloped display name, never in clear
    const psn = await db.select().from(discoveryPseudonyms).where(eq(discoveryPseudonyms.pseudonym, findings[0]!.subject));
    expect(psn).toHaveLength(1);
    expect(psn[0]!.kind).toBe("device");
    const all = JSON.stringify(await db.select().from(discoveryPseudonyms));
    expect(all.includes(USERNAME)).toBe(false);
  });

  it("an env-variable row is stored as its presence id: the name appears in no run, evidence or audit row (review of #419, F2)", async () => {
    const id = await endpointSource("endpoint_osquery");
    const envName = "OPENAI_API_KEY";
    const file = JSON.stringify({
      name: "pack/regulait_ai_discovery/ai_env_var_names_posix",
      hostIdentifier: `${HOST}-env`,
      unixTime: 1790000200,
      columns: { process_name: `sd3proc${RUN}`, key: envName },
      action: "added",
    });
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: file, mode: "apply" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().findingsCreated).toBeGreaterThanOrEqual(1);
    expect(r.body.includes(envName)).toBe(false);
    const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r.json().runId));
    expect(run?.status).toBe("succeeded");
    expect(JSON.stringify(run).includes(envName)).toBe(false);
    const imports = await db.select().from(shadowAiImports).where(eq(shadowAiImports.discoveryRunId, run!.id));
    const findings = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.lastImportId, imports[0]!.id));
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const evidence = findings.flatMap((f) => f.evidence as Array<{ presence?: string[] }>);
    expect(evidence.some((e) => e.presence?.includes("env.openai.api-key"))).toBe(true);
    expect(JSON.stringify(findings).includes(envName)).toBe(false);
    expect(JSON.stringify(imports).includes(envName)).toBe(false);
    const audits = await db.select().from(auditLog).where(inArray(auditLog.objectId, [id, run!.id]));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits).includes(envName)).toBe(false);
  });

  it("an unmatched-only import records a catalogue gap and creates no pseudonym at all", async () => {
    const id = await endpointSource("endpoint_osquery");
    const lonely = `sd3-lonely-${RUN}`;
    const file = JSON.stringify({ name: "ai_apps_macos", hostIdentifier: lonely, unixTime: 1790000000, columns: { name: `Nothing-${RUN}.app`, bundle_identifier: `org.example.nothing.${RUN}` } });
    const before = (await db.select({ id: discoveryPseudonyms.id }).from(discoveryPseudonyms)).length;
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: file, mode: "apply", source: `${USERNAME}-export.log` });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().findingsCreated).toBe(0);
    expect((await db.select({ id: discoveryPseudonyms.id }).from(discoveryPseudonyms)).length).toBe(before);
    const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r.json().runId));
    expect((run?.catalogueGaps as Array<{ value: string }>).some((g) => g.value === `Nothing-${RUN}.app`)).toBe(true);
    // the uploaded file's name is kept only as a digest
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, run!.id));
    expect(JSON.stringify(audits).includes(USERNAME)).toBe(false);
  });

  it("refuses a file with an unreadable row as a whole by default, and writes nothing", async () => {
    const id = await endpointSource("endpoint_osquery");
    const runsBefore = (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(eq(discoveryRuns.sourceId, id))).length;
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: `${osqueryFile}\nnot json`, mode: "apply" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("rows_refused");
    expect(r.json().refusals[0].line).toBe(3);
    expect((await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(eq(discoveryRuns.sourceId, id))).length).toBe(runsBefore);
  });

  it("audits every refusal with a fixed reason: no cell text from a headerless CSV or malformed JSON reaches the audit log", async () => {
    const inv = await endpointSource("endpoint_inventory");
    const osq = await endpointSource("endpoint_osquery");
    const disabled = await endpointSource("endpoint_osquery", false);
    const secretish = `cellmark${RUN}`;
    const headerless = await inject("POST", `/v1/discovery/sources/${inv}/endpoint-imports`, AUTH, { content: `${HOST}-a,${secretish}@example.test,Cursor\n${HOST}-b,x@example.test,Claude`, format: "csv" });
    expect(headerless.statusCode).toBe(400);
    expect(headerless.body.includes(secretish)).toBe(false);
    const badJson = await inject("POST", `/v1/discovery/sources/${osq}/endpoint-imports`, AUTH, { content: `[{"hostIdentifier": "${secretish}", "name": ` });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.body.includes(secretish)).toBe(false);
    const rows = await inject("POST", `/v1/discovery/sources/${osq}/endpoint-imports`, AUTH, { content: `${osqueryFile}\nnot json ${secretish}` });
    expect(rows.statusCode).toBe(422);
    const off = await inject("POST", `/v1/discovery/sources/${disabled}/endpoint-imports`, AUTH, { content: osqueryFile });
    expect(off.statusCode).toBe(409);
    const audits = await db.select().from(auditLog).where(inArray(auditLog.objectId, [inv, osq, disabled]));
    const refused = audits.filter((a) => a.ruleId === "discovery-endpoint-import-refused");
    expect(refused.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(refused).includes(secretish)).toBe(false);
    expect(JSON.stringify(refused).includes(HOST)).toBe(false);
  });

  it("an ObservationRefused gives an audited 422 and a failed run", async () => {
    const id = await endpointSource("endpoint_osquery");
    const forced = Fastify();
    forced.addHook("onRequest", async (req) => {
      (req as unknown as { authCtx: { userId: string } }).authCtx = { userId: adminId };
    });
    registerEndpointImportRoutes(forced, db, {
      dataKey: DATA_KEY,
      checkObservations: () => {
        throw new ObservationRefused(`observation 0: '${HOST}' forced by the test`);
      },
    });
    await forced.ready();
    const r = await forced.inject({ method: "POST", url: `/v1/discovery/sources/${id}/endpoint-imports`, payload: { content: osqueryFile, mode: "apply" } });
    await forced.close();
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("observation_refused");
    expect(r.body.includes(HOST)).toBe(false);
    const [run] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, r.json().runId));
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("observation_refused");
    expect((run?.errorDetail ?? "").includes(HOST)).toBe(false);
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, id));
    expect(audits.some((a) => a.ruleId === "discovery-endpoint-import-refused" && a.reason.includes("observation_refused"))).toBe(true);
  });

  it("imports an MDM/EDR inventory export into an inventory source", async () => {
    const id = await endpointSource("endpoint_inventory");
    const csv = `Computer Name,Software,Bundle ID,User,OS\n${HOST}-inv,ChatGPT.app,com.openai.chat,${USERNAME},macOS 15`;
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: csv, format: "csv", mode: "apply" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().findingsCreated).toBeGreaterThanOrEqual(1);
    const wrong = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: "hostname,device,software\nh,d,x", format: "csv" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("unreadable_endpoint_file");
  });
});
