/** Real PostgreSQL + real egress guard + independent OpenSSL tokens. DNS and
 * the final pinned transport are synthetic: no live/public TSA is contacted. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { auditAnchors, createDb, egressAllowHosts, eq, orgSettings, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { anchorCanonicalBytes, anchorRecordFromRow, anchorTimestamper, runAnchorTimestampSweep } from "./audit-timestamp.js";
import { flushPendingAnchors, captureAnchor, type AnchorSink } from "./audit-chain.js";
import { parseTimestampTrustBundle, verifyTimestampResponse } from "./audit-timestamp-verify.js";
import { readFileSync } from "node:fs";
import { syntheticTsa } from "./testing/tsa-fixture.js";

const transport = vi.hoisted(() => ({ requests: [] as Array<{ target: unknown; init: RequestInit | undefined }>, issue: null as null | ((body: Uint8Array) => Buffer), fail: false, hold:null as Promise<void>|null, dnsHold:null as Promise<void>|null, dnsEntered:false }));
vi.mock("node:dns/promises", async (original) => ({ ...await original<typeof import("node:dns/promises")>(), lookup: async () => {transport.dnsEntered=true;if(transport.dnsHold)await transport.dnsHold;return [{ address: "93.184.216.34", family: 4 }];} }));
vi.mock("./pinned-fetch.js", async (original) => ({ ...await original<typeof import("./pinned-fetch.js")>(), pinnedFetch: async (target: unknown, init?: RequestInit) => {
  transport.requests.push({ target, init });
  if(transport.hold)await transport.hold;
  if (transport.fail) return new Response("unavailable", { status: 503 });
  const token = transport.issue!(init!.body as Uint8Array);
  return new Response(new Uint8Array(token), { headers: { "content-type": "application/timestamp-reply" } });
} }));
const base = process.env.DATABASE_URL;
const database = `regulait_x22_${process.pid}_${Date.now()}`;
let db: Db, app: ReturnType<typeof buildApp>, tsa: ReturnType<typeof syntheticTsa>;
const saved = Object.fromEntries(["REGULAIT_TSA_URL", "REGULAIT_TSA_TRUST_BUNDLE", "REGULAIT_TSA_POLICY_OID"].map((name) => [name, process.env[name]]));
async function control(statement: string) { const handle = createDb(base!); try { await handle.execute(sql.raw(statement)); } finally { await handle.$client.end(); } }
async function anchor(status: "pending" | "flushed" = "flushed") {
  const [row] = await db.insert(auditAnchors).values({ id: randomUUID(), seq: 1, rowHash: "a".repeat(64), headAt: new Date(), destination: "local_worm", status, createdAt: new Date() }).returning();
  return row!;
}
const auth = { authorization: "Bearer x22-synthetic-bootstrap" };

describe.skipIf(!base)("X22 real timestamp persistence and guarded transport", () => {
  beforeAll(async () => {
    await control(`CREATE DATABASE "${database}"`);
    const url = new URL(base!); url.pathname = `/${database}`;
    db = createDb(url.toString());
    await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
    app = buildApp(db, { bootstrapToken: "x22-synthetic-bootstrap", dataKey: "a".repeat(64) });
    tsa = syntheticTsa(); transport.issue = tsa.issue;
    for (const name of Object.keys(saved)) delete process.env[name];
  }, 120_000);
  afterAll(async () => {
    await app?.close(); await db?.$client.end();
    if (db) await control(`DROP DATABASE "${database}"`);
    tsa?.close();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  it("keeps an unconfigured anchor honestly not timestamped, with no network request", async () => {
    const row = await anchor();
    await anchorTimestamper.afterFlush(db, { id: row.id, record: anchorRecordFromRow(row), flushStatus: "flushed" });
    expect((await runAnchorTimestampSweep(db)).state).toBe("not_configured");
    expect(transport.requests).toHaveLength(0);
    const [stored]=await db.select().from(auditAnchors).where(eq(auditAnchors.id,row.id));
    expect(stored!.tsaStatus).toBe("not_configured");expect(JSON.parse(stored!.tsaToken!).payloadVersion).toBe("regulait.audit.v1");
    const historic={...stored!,tsaToken:JSON.stringify({format:"regulait.timestamp.v1",payloadVersion:"regulait.audit.fixture-v0",replyDer:null})};
    expect(anchorRecordFromRow(historic).payloadVersion).toBe("regulait.audit.fixture-v0");
    expect((await app.inject({ method: "GET", url: `/v1/audit/anchors/${row.id}/timestamp.tsr`, headers: auth })).statusCode).toBe(409);
  });
  it("refuses a TSA outside the admin allow list and schedules bounded backoff", async () => {
    process.env.REGULAIT_TSA_URL = "https://tsa.example.test/"; process.env.REGULAIT_TSA_TRUST_BUNDLE = tsa.trustBundle;
    const row = await anchor();
    await anchorTimestamper.afterFlush(db, { id: row.id, record: anchorRecordFromRow(row), flushStatus: "flushed" });
    const [failed] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, row.id));
    expect(failed).toMatchObject({ tsaStatus: "failed", tsaAttempts: 1, tsaLastError: "timestamp_transport_or_validation_failed" });
    expect(failed!.tsaNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(transport.requests).toHaveLength(0);
    expect((await runAnchorTimestampSweep(db)).attempted).toBe(1); // the earlier unconfigured row is now due
    expect(transport.requests).toHaveLength(0);
  });
  it("pins an allowed host, verifies and stores a token once under concurrent manual retries", async () => {
    await db.insert(egressAllowHosts).values({ host: "tsa.example.test", allowPrivateRanges: false, allowPlaintextHttp: false, note: "synthetic TSA" });
    const row = await anchor();
    const request = () => app.inject({ method: "POST", url: `/v1/audit/anchors/${row.id}/timestamp`, headers: auth });
    const before = transport.requests.length;
    let release:()=>void=()=>{};transport.hold=new Promise<void>(resolve=>{release=resolve;});
    const first=request().then(value=>value);
    await vi.waitFor(()=>expect(transport.requests.length).toBe(before+1));
    try { const second=await request();expect(second.statusCode).toBe(409);expect(second.json().error).toBe("timestamp_in_progress"); }
    finally {release();transport.hold=null;}
    expect((await first).statusCode).toBe(200);
    expect(transport.requests.length - before).toBe(1);
    expect(transport.requests.at(-1)!.target).toMatchObject({ host: "tsa.example.test", addresses: ["93.184.216.34"] });
    const [stored] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, row.id));
    expect(stored).toMatchObject({ status: "flushed", tsaStatus: "granted", tsaAttempts: 1 });
    const download = await app.inject({ method: "GET", url: `/v1/audit/anchors/${row.id}/timestamp.tsr`, headers: auth });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("application/timestamp-reply");
    const checked = await verifyTimestampResponse(download.rawPayload, { bytes: anchorCanonicalBytes(anchorRecordFromRow(stored!)), nonceHex: stored!.tsaNonce!, trust: parseTimestampTrustBundle(readFileSync(tsa.trustBundle, "utf8")), now: new Date(),sentAt:stored!.createdAt });
    expect(checked.imprint).toBe(stored!.tsaMessageImprint);
  });
  it("preserves successful storage flushes when timestamp transport fails, and respects mode off", async () => {
    transport.fail = true;
    const sink: AnchorSink = { destination: "local_worm", tamperResistant: false, write: async () => "synthetic-worm-location", readLatest: async () => null };
    const captured = await captureAnchor(db, sink, null);
    expect(captured!.status).toBe("flushed");
    const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, captured!.anchorId));
    expect(row).toMatchObject({ status: "flushed", tsaStatus: "failed", tsaAttempts: 1 });
    transport.fail = false;
    await db.update(orgSettings).set({ auditAnchorTimestampMode: "off" });
    const before = transport.requests.length;
    expect((await runAnchorTimestampSweep(db)).state).toBe("off");
    expect(transport.requests).toHaveLength(before);
    await db.update(orgSettings).set({ auditAnchorTimestampMode: "required" });
  });
  it("persists the captured canonical record unchanged across insert latency",async()=>{
    let written:unknown;
    const sink:AnchorSink={destination:"local_worm",tamperResistant:false,write:async record=>{written=record;return "synthetic-location";},readLatest:async()=>null};
    const delayed=new Proxy(db,{get(target,key){
      if(key==="insert")return (table:unknown)=>table===auditAnchors?{values:async(value:typeof auditAnchors.$inferInsert)=>{await target.insert(auditAnchors).values(value);await new Promise(resolve=>setTimeout(resolve,25));}}:target.insert(table as typeof auditAnchors);
      const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;
    }});
    const result=await captureAnchor(delayed,sink,null,{afterFlush:async()=>{}});
    const [stored]=await db.select().from(auditAnchors).where(eq(auditAnchors.id,result!.anchorId));
    expect(anchorRecordFromRow(stored!)).toEqual(written);
  });
  it("returns verified summaries rather than raw tokens on the anchors list",async()=>{
    process.env.REGULAIT_TSA_URL="https://tsa.example.test/";process.env.REGULAIT_TSA_TRUST_BUNDLE=tsa.trustBundle;
    await db.insert(egressAllowHosts).values({host:"tsa.example.test",allowPrivateRanges:false,allowPlaintextHttp:false,note:"synthetic TSA"}).onConflictDoNothing();
    const sink:AnchorSink={destination:"local_worm",tamperResistant:false,write:async()=>"synthetic-location",readLatest:async()=>null};
    const captured=await captureAnchor(db,sink,null);
    const [row]=await db.select().from(auditAnchors).where(eq(auditAnchors.id,captured!.anchorId));expect(row!.tsaStatus).toBe("granted");
    const response=await app.inject({method:"GET",url:"/v1/audit/anchors",headers:auth});expect(response.statusCode).toBe(200);
    const listed=response.json().anchors.find((item:{id:string})=>item.id===row!.id);
    expect(listed.timestamp).toMatchObject({status:"granted",verified:true});expect(listed).not.toHaveProperty("tsaToken");
    const before=transport.requests.length;
    expect((await app.inject({method:"POST",url:`/v1/audit/anchors/${row!.id}/timestamp`,headers:auth})).statusCode).toBe(200);
    expect(transport.requests).toHaveLength(before);
    const download=await app.inject({method:"GET",url:`/v1/audit/anchors/${row!.id}/timestamp.tsr`,headers:auth});expect(download.statusCode).toBe(200);
    const checked=await verifyTimestampResponse(download.rawPayload,{bytes:anchorCanonicalBytes(anchorRecordFromRow(row!)),nonceHex:row!.tsaNonce!,trust:parseTimestampTrustBundle(readFileSync(tsa.trustBundle,"utf8")),now:new Date(),sentAt:row!.createdAt});expect(checked.imprint).toBe(row!.tsaMessageImprint);
  });
  it("R22-10: the real DB retry refuses an otherwise valid token predating sentAt",async()=>{
    const row=await anchor();
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(Date.now()+360000));
    try{
      const response=await app.inject({method:"POST",url:`/v1/audit/anchors/${row.id}/timestamp`,headers:auth});expect(response.statusCode).toBe(502);
      const [stored]=await db.select().from(auditAnchors).where(eq(auditAnchors.id,row.id));
      expect(stored).toMatchObject({tsaStatus:"failed",tsaLastError:"timestamp_generation_time_invalid"});
    }finally{vi.useRealTimers();}
  });
  it("R22-11: an expired DNS lookup cannot hold the anchor or send later",async()=>{
    const row=await anchor(),before=transport.requests.length,abort=new AbortController();
    let release:()=>void=()=>{};transport.dnsEntered=false;transport.dnsHold=new Promise<void>(resolve=>{release=resolve;});
    const deadline=vi.spyOn(AbortSignal,"timeout").mockReturnValue(abort.signal);
    try{
      const pending=app.inject({method:"POST",url:`/v1/audit/anchors/${row.id}/timestamp`,headers:auth}).then(value=>value);
      await vi.waitFor(()=>expect(transport.dnsEntered).toBe(true));
      abort.abort(new Error("synthetic deadline"));expect((await pending).statusCode).toBe(502);expect(deadline).toHaveBeenCalledWith(15000);
      release();transport.dnsHold=null;
      // An independent retry acquires the same anchor lock after the expired DNS.
      deadline.mockRestore();
      expect((await app.inject({method:"POST",url:`/v1/audit/anchors/${row.id}/timestamp`,headers:auth})).statusCode).toBe(200);
      expect(transport.requests.length).toBe(before+1);
    }finally{release();transport.dnsHold=null;deadline.mockRestore();}
  });
  it("flushes the stored payload version and refuses corrupt timestamp metadata with 500",async()=>{
    const row=await anchor("pending");
    await db.update(auditAnchors).set({tsaToken:JSON.stringify({format:"regulait.timestamp.v1",payloadVersion:"regulait.audit.fixture-v0",replyDer:null})}).where(eq(auditAnchors.id,row.id));
    let version:string|undefined;
    await flushPendingAnchors(db,{destination:"local_worm",tamperResistant:false,write:async record=>{version=record.payloadVersion;return "synthetic-location";},readLatest:async()=>null},{afterFlush:async()=>{}});
    expect(version).toBe("regulait.audit.fixture-v0");
    await db.update(auditAnchors).set({tsaToken:"{broken"}).where(eq(auditAnchors.id,row.id));
    expect((await app.inject({method:"POST",url:`/v1/audit/anchors/${row.id}/timestamp`,headers:auth})).statusCode).toBe(500);
  });
  it("refuses anonymous access and malformed or unknown anchor IDs", async () => {
    expect((await app.inject({ method: "POST", url: `/v1/audit/anchors/${randomUUID()}/timestamp` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/audit/anchors/invalid/timestamp", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/v1/audit/anchors/${randomUUID()}/timestamp`, headers: auth })).statusCode).toBe(404);
  });
});
