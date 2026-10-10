/** X21: real PostgreSQL, deployment keys, real authorization and offline CLI.
 * Creates and drops an isolated database from DATABASE_URL. An explicit
 * RECEIPT_TEST_DATABASE_URL scratch fixture is instead owned by its caller. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { auditLog, createDb, decisionReceipts, desc, eq, orgSettings, receiptSigningKeys, runMigrations, sql, schedulerJobs, type Db } from "@regulait/db";
import { verifyReceiptBundle, receiptCanonicalBytes, type ReceiptBundle } from "@regulait/shared";
import { buildApp } from "./app.js";
import { runDecisionReceiptSignSweep } from "./decision-receipts.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const suppliedConnection = process.env.RECEIPT_TEST_DATABASE_URL;
const baseConnection = process.env.DATABASE_URL;
const ownedDatabase = `regulait_x21_${process.pid}_${Date.now()}`;
let connection = suppliedConnection;
async function databaseStatement(statement: string) {
  const control = createDb(baseConnection!);
  try { await control.execute(sql.raw(statement)); } finally { await control.$client.end(); }
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreIdentity: (() => Promise<void>) | undefined;
const directory = mkdtempSync(path.join(tmpdir(), "regulait-receipts-"));
const saved = { file: process.env.REGULAIT_RECEIPT_SIGNING_KEY, id: process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID };
const boot = { authorization: "Bearer x21-synthetic-bootstrap" };
let admin: { authorization: string }, member: { authorization: string };
let decisionUserId: string;
const firstKey = generateKeyPairSync("ed25519"), secondKey = generateKeyPairSync("ed25519");
function useKey(id: string, pair = firstKey) {
  const file = path.join(directory, `${id}.pem`);
  writeFileSync(file, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  process.env.REGULAIT_RECEIPT_SIGNING_KEY = file;
  process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = id;
}
const clearKey = () => { delete process.env.REGULAIT_RECEIPT_SIGNING_KEY; delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID; };
async function decision(objectType: typeof auditLog.$inferInsert.objectType = "mcp_tool") {
  const [row] = await db.insert(auditLog).values({ userId: decisionUserId, objectType, effect: "deny", ruleId: "x21-policy", ruleChain: [], reason: "synthetic private reason", detail: { excluded: "synthetic private detail", receiptClass:"decision" } }).returning();
  return row!;
}
const get = (url: string, headers: Record<string, string> = admin) => app.inject({ method: "GET", url, headers });
async function bundle(): Promise<ReceiptBundle> {
  const res = await get("/v1/receipts/export");
  expect(res.statusCode).toBe(200);
  return res.json();
}
function offline(value: ReceiptBundle, pin = false) {
  const file = path.join(directory, "bundle.json"), keys = path.join(directory, "trusted-keys.json");
  writeFileSync(file, JSON.stringify(value));
  writeFileSync(keys, JSON.stringify({ keys: value.keys }));
  const out = spawnSync(process.execPath, [path.join(ROOT, "scripts/verify-receipts.mjs"), file, ...(pin ? [keys] : [])], { encoding: "utf8" });
  return { status: out.status, output: JSON.parse(out.stdout) };
}

describe.skipIf(!suppliedConnection && !baseConnection)("X21 real receipt pipeline (isolated DB)", () => {
  beforeAll(async () => {
    if (!connection && baseConnection) {
      await databaseStatement(`CREATE DATABASE "${ownedDatabase}"`);
      const url = new URL(baseConnection); url.pathname = `/${ownedDatabase}`; connection = url.toString();
    }
    if (!connection || !new URL(connection).pathname.startsWith("/regulait_x21_")) throw new Error("Use a dedicated regulait_x21_ scratch database.");
    clearKey();
    db = createDb(connection);
    await runMigrations(db, path.join(ROOT, "packages/db/migrations"));
    restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
    app = buildApp(db, { bootstrapToken: "x21-synthetic-bootstrap", dataKey: "a".repeat(64) });
    for (const [role, isAdmin] of [["admin", true], ["member", false]] as const) {
      const user = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `x21-${role}@example.test`, displayName: role, isAdmin } });
      expect(user.statusCode).toBe(201);
      const key = await app.inject({ method: "POST", url: `/v1/users/${user.json().id}/keys`, headers: boot, payload: { name: "x21 fixture" } });
      expect(key.statusCode).toBe(201);
      const auth = { authorization: `Bearer ${key.json().token}` };
      if (isAdmin) { admin = auth; decisionUserId = user.json().id; } else member = auth;
    }
  }, 120_000);
  afterAll(async () => {
    if (db) {
      await db.update(orgSettings).set({ decisionReceiptsMode: "on" });
      await restoreIdentity?.();
    }
    await app?.close();
    await db?.$client.end();
    if (!suppliedConnection && connection) await databaseStatement(`DROP DATABASE "${ownedDatabase}"`);
    if (saved.file === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY; else process.env.REGULAIT_RECEIPT_SIGNING_KEY = saved.file;
    if (saved.id === undefined) delete process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID; else process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = saved.id;
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports no_key and off truthfully without signing or registering a key", async () => {
    await decision();
    expect(await runDecisionReceiptSignSweep(db)).toEqual({ signed: 0, state: "no_key" });
    expect((await get("/v1/receipts/status")).json()).toMatchObject({ state: "no_key", lastSeq: 0, lagRows: 1 });
    await db.update(orgSettings).set({ decisionReceiptsMode: "off" });
    useKey("fixture-1");
    expect(await runDecisionReceiptSignSweep(db)).toEqual({ signed: 0, state: "off" });
    expect((await get("/v1/receipts/status")).json().state).toBe("off");
    expect(await db.select().from(receiptSigningKeys)).toHaveLength(0);
    await db.update(orgSettings).set({ decisionReceiptsMode: "on" });
  });
  it("serializes concurrent sweeps, excludes admin audit rows and is idempotent", async () => {
    await decision("org_settings");
    const row = await decision("approval");
    const out = await Promise.all([runDecisionReceiptSignSweep(db), runDecisionReceiptSignSweep(db)]);
    expect(out.reduce((n, result) => n + result.signed, 0)).toBe(2);
    expect(await runDecisionReceiptSignSweep(db)).toEqual({ signed: 0, state: "signing" });
    const value = await bundle();
    expect(value.receipts.map((r) => r.receiptSeq)).toEqual([1, 2]);
    expect(value.receipts[1]!.payload.audit.id).toBe(row.id);
    expect(verifyReceiptBundle(value).results.map((r) => r.status)).toEqual(["valid", "valid"]);
    expect(JSON.stringify(value)).not.toContain("synthetic private");
    expect(Object.keys(value.keys[0]!.jwk).sort()).toEqual(["crv", "kty", "x"]);
    expect((await get(`/v1/receipts/${row.id}`)).json().receipts).toHaveLength(1);
  });
  it("rejects same-ID key substitution in status and sweep without writing evidence", async () => {
    useKey("fixture-1", secondKey);
    expect((await get("/v1/receipts/status")).statusCode).toBe(503);
    await expect(runDecisionReceiptSignSweep(db)).rejects.toThrow("conflicts");
    expect(await db.select().from(decisionReceipts)).toHaveLength(2);
    useKey("fixture-2", secondKey);
    await decision("agent");
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(1);
    const value = await bundle();
    expect(value.keys).toHaveLength(2);
    expect(value.receipts.map((r) => r.keyId)).toEqual(["fixture-1", "fixture-1", "fixture-2"]);
    expect(verifyReceiptBundle(value).results.every((r) => r.status === "valid")).toBe(true);
  });
  it("audits only export metadata, bounds requests and refuses non-admin/anonymous access", async () => {
    await bundle();
    expect((await get("/v1/receipts/export", boot)).statusCode).toBe(200);
    const [event] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "decision-receipt-exported")).orderBy(desc(auditLog.seq)).limit(1);
    expect(event!.detail).toEqual({ fromSeq: 1, toSeq: 3, rows: 3 });
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(0);
    for (const route of ["/v1/receipts", "/v1/receipts/status", "/v1/receipts/keys", "/v1/receipts/export"]) {
      expect((await get(route, member)).statusCode).toBe(403);
      expect((await get(route, {})).statusCode).toBe(401);
    }
    for (const query of ["fromSeq=0", "fromSeq=2&toSeq=1", "fromSeq=1&toSeq=5001", "fromSeq=1.5", "toSeq=9007199254740992"]) expect((await get(`/v1/receipts/export?${query}`)).statusCode).toBe(400);
    expect((await get("/v1/receipts?limit=501")).statusCode).toBe(400);
  });
  it("exercises online and offline verification for tampering, missing keys and a truncated prefix", async () => {
    const value = await bundle();
    const check = (payload: unknown) => app.inject({ method: "POST", url: "/v1/receipts/verify", headers: admin, payload: payload as object });
    const valid = await check(value);
    expect(valid.statusCode).toBe(200);
    expect(valid.json().results.every((r: { status: string }) => r.status === "valid")).toBe(true);
    expect(offline(value, true).status).toBe(0);
    const tampered = structuredClone(value); tampered.receipts[0]!.payload.decision.effect = "allow";
    expect((await check(tampered)).json().results[0].status).toBe("invalid");
    expect(offline(tampered).status).toBe(1);
    const missing = structuredClone(value); missing.keys = [];
    expect(offline(missing).status).toBe(2);
    const suffix = structuredClone(value); suffix.receipts.shift();
    expect((await check(suffix)).json().results.every((r: { status: string }) => r.status === "unverifiable")).toBe(true);
    expect(offline(suffix).status).toBe(2);
    const privateKey = structuredClone(value) as any; privateKey.keys[0].jwk.d = "not-public";
    expect((await check(privateKey)).statusCode).toBe(400);
  });
  it("R21-01: online verification refuses attacker keys labelled with a registered identity",async()=>{
    const value=await bundle(),forged=structuredClone(value),pair=generateKeyPairSync("ed25519");
    forged.keys=forged.keys.map(key=>({...key,jwk:pair.publicKey.export({format:"jwk"}) as typeof key.jwk}));
    for(const row of forged.receipts)row.signature=sign(null,Buffer.from(receiptCanonicalBytes(row.payload)),pair.privateKey).toString("base64url");
    const result=await app.inject({method:"POST",url:"/v1/receipts/verify",headers:admin,payload:forged});expect(result.statusCode).toBe(200);expect(result.json().results.every((row:{status:string})=>row.status!=="valid")).toBe(true);
    const suppliedWrongKeys={...value,keys:forged.keys};
    const pinned=await app.inject({method:"POST",url:"/v1/receipts/verify",headers:admin,payload:suppliedWrongKeys});
    expect(pinned.json().results.every((row:{status:string})=>row.status==="valid")).toBe(true);
    const read=await get(`/v1/receipts/${value.receipts[0]!.payload.audit.id}`);expect(read.statusCode).toBe(200);
    expect((await db.select().from(auditLog).where(eq(auditLog.ruleId,"decision-receipt-read"))).length).toBeGreaterThan(0);
    expect(offline(value).status).toBe(2);
  });
  it("R21-04/05: same-object admin changes remain unsigned and listing envelopes is audited",async()=>{
    for(const [objectType,ruleId] of [["agent","agent-owner-set"],["agent","fallback-chain-configured"],["mcp_tool","mcp-tool-price-set"]] as const)await db.insert(auditLog).values({userId:decisionUserId,objectType,ruleId,effect:"allow",ruleChain:[],reason:"Synthetic config"});
    // Unknown future writers and historical unclassified rows also fail closed.
    await db.insert(auditLog).values({userId:decisionUserId,objectType:"agent",ruleId:"new-config-writer",effect:"allow",ruleChain:[],reason:"Synthetic unknown"});
    await db.insert(auditLog).values({userId:decisionUserId,objectType:"agent",ruleId:"agent-enabled",effect:"allow",ruleChain:[],reason:"Synthetic classified config",detail:{receiptClass:"configuration"}});
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(0);
    await get("/v1/receipts?limit=500");expect((await db.select().from(auditLog).where(eq(auditLog.ruleId,"decision-receipts-listed"))).length).toBeGreaterThan(0);
  });
  it("R21-02: empty/large tool names sign and failures are visible in status",async()=>{
    const before=(await db.select().from(decisionReceipts)).length;
    const long="Z".repeat(5000);
    for(const toolName of ["",long])await db.insert(auditLog).values({userId:decisionUserId,objectType:"mcp_tool",toolName,effect:"deny",ruleId:"synthetic-call-refused",ruleChain:[],reason:"synthetic",detail:{receiptClass:"decision"}});
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(2);
    const value=await bundle();expect(value.receipts[before]!.payload.decision.toolName).toBe("");
    expect(value.receipts[before+1]!.payload.decision).toMatchObject({toolName:null,toolNameHash:createHash("sha256").update(long).digest("hex")});
    expect(verifyReceiptBundle(value).results.every(row=>row.status==="valid")).toBe(true);
    await db.insert(schedulerJobs).values({name:"decision-receipt-sign-sweep",intervalSeconds:60,lastOutcome:"failed",lastError:"synthetic-private-failure",lastFinishedAt:new Date()}).onConflictDoUpdate({target:schedulerJobs.name,set:{lastOutcome:"failed",lastError:"synthetic-private-failure"}});
    expect((await get("/v1/receipts/status")).json().state).toBe("stalled");expect((await get("/v1/receipts/status")).body).not.toContain("synthetic-private-failure");
  });
  it("rolls back an entire pass if an audit row was tampered with", async () => {
    const good = await decision("connector");
    const bad = await decision("approval");
    await db.execute(sql`UPDATE audit_log SET effect = 'allow' WHERE id = ${bad.id}`);
    await expect(runDecisionReceiptSignSweep(db)).rejects.toThrow("Audit row failed integrity");
    expect(await db.select().from(decisionReceipts)).toHaveLength(5);
    await db.execute(sql`UPDATE audit_log SET effect = 'deny' WHERE id = ${bad.id}`);
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(2);
    expect((await get(`/v1/receipts/${good.id}`)).json().receipts).toHaveLength(1);
  });
  it("B4I-01: a retired deployment key cannot sign again but its historical evidence verifies", async () => {
    const before = await bundle();
    await db.update(receiptSigningKeys).set({ retiredAt: new Date() }).where(eq(receiptSigningKeys.keyId, "fixture-1"));
    useKey("fixture-1");
    await decision();
    expect((await get("/v1/receipts/status")).statusCode).toBe(503);
    await expect(runDecisionReceiptSignSweep(db)).rejects.toThrow("conflicts");
    expect(await db.select().from(decisionReceipts)).toHaveLength(before.receipts.length);
    const historical = await bundle();
    expect(historical.keys.find(key => key.keyId === "fixture-1")!.retiredAt).not.toBeNull();
    const checked = await app.inject({ method: "POST", url: "/v1/receipts/verify", headers: admin, payload: historical });
    expect(checked.json().results.every((row: { status: string }) => row.status === "valid")).toBe(true);
    expect(checked.json().cannotProve.join(" ")).toContain("signed before key retirement");
    const cli = offline(historical, true);
    expect(cli.status).toBe(0);
    // ADR-0186 decision 30 item 2: the offline CLI surfaces the same limit as the API
    expect(cli.output.cannotProve.join(" ")).toContain("signed before key retirement");
    expect(cli.output.cannotProve.join(" ")).toContain("not a revocation attestation");
    expect(checked.json().cannotProve.join(" ")).toContain("not a revocation attestation");
    useKey("fixture-2", secondKey);
    expect((await runDecisionReceiptSignSweep(db)).signed).toBe(1);
  });
});
