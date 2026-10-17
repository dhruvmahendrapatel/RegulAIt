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
import { buildApp } from "./app.js";
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

async function endpointSource(kind: "endpoint_osquery" | "endpoint_inventory", enabled = true) {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `sd3-${kind}-${enabled}-${RUN}`, kind, target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
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
    // the device has an SD0 pseudonym row; the username was never pseudonymised or stored
    const psn = await db.select().from(discoveryPseudonyms).where(eq(discoveryPseudonyms.pseudonym, findings[0]!.subject));
    expect(psn).toHaveLength(1);
    const all = JSON.stringify(await db.select().from(discoveryPseudonyms));
    expect(all.includes(USERNAME)).toBe(false);
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

  it("imports an MDM/EDR inventory export into an inventory source", async () => {
    const id = await endpointSource("endpoint_inventory");
    const csv = `Computer Name,Software,Bundle ID,User\n${HOST}-inv,ChatGPT.app,com.openai.chat,${USERNAME}`;
    const r = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: csv, format: "csv", mode: "apply" });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().findingsCreated).toBeGreaterThanOrEqual(1);
    const wrong = await inject("POST", `/v1/discovery/sources/${id}/endpoint-imports`, AUTH, { content: "hostname,device,software\nh,d,x", format: "csv" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("unreadable_endpoint_file");
  });
});
