/**
 * ADR-0351 slice 1 — the syslog-over-TLS SIEM destination end to end: the admin routes, a real TLS receiver on
 * loopback (its certificate issued by a throwaway CA made in memory), the egress allow-list and the ADR-0303 cursor.
 *
 * The receiver's host name resolves (injected resolver) to 127.0.0.1, so its allow-list entry opens private ranges
 * for this file only; it is removed in afterAll. Every fixture names its own rows by this run's ids.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { randomUUID, webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import { auditLog, createDb, eq, runMigrations, siemDestinations, sql, type Db } from "@regulait/db";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { makeCert, type TestCert } from "./testing/x509-fixtures.js";
import { deliverSiemDestinationOnce, SIEM_ENVELOPE_SCHEMA } from "./siem-delivery.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0351-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const RUN = Date.now();
const HOST = `syslog-${RUN}.example.com`;
const UNLISTED = `syslog-unlisted-${RUN}.example.com`;
const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
const deps = { resolve, syslog: { hostname: "gw-test" } };

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let root: TestCert;
let otherRoot: TestCert;
let server: tls.Server;
let port: number;
const received: Buffer[] = [];
const restores: Array<() => Promise<void>> = [];
const allowed = trackEgressAllowHosts();

const pemKey = async (c: TestCert) => {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", c.key.privateKey));
  // the PEM label is built at run time (as spiffe-endpoint-fixture.ts does): the key itself is generated per run
  const label = ["PRIVATE", "KEY"].join(" ");
  return `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
};

/** RFC 5425 octet-counted frames back into messages */
function unframe(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const len = Number(buf.subarray(i, sp).toString("ascii"));
    out.push(buf.subarray(sp + 1, sp + 1 + len).toString("utf8"));
    i = sp + 1 + len;
  }
  return out;
}

const asSteppedUp = async (facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));
const row = async (id: string) => (await db.select().from(siemDestinations).where(eq(siemDestinations.id, id)))[0]!;

async function create(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/siem/destinations", headers: AUTH, payload });
}
async function enable(id: string, url: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/v1/siem/destinations/${id}/enabled`,
    ...(await asSteppedUp({ siem: "enable", destinationId: id, url })),
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
}
async function writeAuditRow(tag: string): Promise<string> {
  const id = randomUUID();
  await db.insert(auditLog).values({
    id,
    userId: adminId,
    objectType: "project",
    objectId: null,
    detail: { secretish: `DETAIL-${tag}-${RUN}` },
    effect: "deny",
    ruleId: `adr0351-test-${tag}`,
    ruleChain: [],
    reason: `REASON-${tag}-${RUN}`,
  });
  return id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost(HOST), allowPrivateRanges: true, allowPlaintextHttp: false, note: `adr0351 ${RUN}` } }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0351-admin-${RUN}@example.com`, displayName: "syslog admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;

  root = await makeCert({ isCA: true, name: `adr0351-root-${RUN}` });
  otherRoot = await makeCert({ isCA: true, name: `adr0351-other-${RUN}` });
  const leaf = await makeCert({ issuer: root, name: HOST, dnsNames: [HOST] });
  server = tls.createServer({ key: await pemKey(leaf), cert: leaf.pem, minVersion: "TLSv1.2" }, (sock) => {
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.on("end", () => {
      received.push(Buffer.concat(chunks));
      sock.end();
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    await db.update(siemDestinations).set({ enabled: false }).where(sql`${siemDestinations.name} like ${`adr0351-${RUN}%`}`);
    for (const r of restores.reverse()) await r();
    await new Promise<void>((r) => server.close(() => r()));
    await app?.close();
  } finally {
    entries.assertRemoved();
  }
});

describe("creating a syslog destination", () => {
  it("refuses plaintext, a bad url, a leaf as the CA, and a CA on a webhook", async () => {
    const url = `syslog+tls://${HOST}:${port}`;
    expect((await create({ name: `adr0351-${RUN}-x1`, kind: "syslog_tls", url, allowPlaintextHttp: true })).statusCode).toBe(400);
    const bad = await create({ name: `adr0351-${RUN}-x2`, kind: "syslog_tls", url: `udp://${HOST}:514` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_url");
    const leaf = await makeCert({ issuer: root, name: "x" });
    const ca = await create({ name: `adr0351-${RUN}-x3`, kind: "syslog_tls", url, tlsCaPem: leaf.pem });
    expect(ca.statusCode).toBe(400);
    expect(ca.json().error).toBe("invalid_ca");
    expect((await create({ name: `adr0351-${RUN}-x4`, url: "https://h.example.com/x", tlsCaPem: root.pem })).statusCode).toBe(400);
  });
});

describe("delivery over verified TLS", () => {
  let id: string;
  const url = () => `syslog+tls://${HOST}:${port}`;

  it("is created off, with no secret, and has no secret to rotate", async () => {
    const res = await create({ name: `adr0351-${RUN}-ok`, kind: "syslog_tls", url: url(), tlsCaPem: root.pem });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.secret).toBeNull();
    expect(body.destination).toMatchObject({ kind: "syslog_tls", url: url(), enabled: false, customCa: true, secretRotatedAt: null });
    id = body.destination.id;
    const stored = await row(id);
    expect(stored.secretCiphertext).toBeNull();
    const rot = await app.inject({ method: "POST", url: `/v1/siem/destinations/${id}/rotate-secret`, headers: AUTH });
    expect(rot.statusCode).toBe(409);
    expect(rot.json().error).toBe("not_applicable");
  });

  it("sends each new event as one RFC 5424 message, octet-counted, scrubbed, and moves the cursor", async () => {
    await enable(id, url());
    const a = await writeAuditRow("a");
    const b = await writeAuditRow("b");
    received.length = 0;
    const pass = await deliverSiemDestinationOnce(db, id, DATA_KEY, deps);
    expect(pass.outcome, JSON.stringify(pass)).toBe("delivered");
    const text = Buffer.concat(received);
    const messages = unframe(text);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const mine = messages.filter((m) => m.includes(a) || m.includes(b));
    expect(mine).toHaveLength(2);
    for (const m of mine) {
      expect(m).toMatch(/^<108>1 \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z gw-test regulait - audit - \{/);
      const ev = JSON.parse(m.slice(m.indexOf("{")));
      expect(ev.schema).toBe(SIEM_ENVELOPE_SCHEMA);
      expect(Object.keys(ev).sort()).toEqual(["at", "chain", "effect", "id", "object", "ruleId", "schema", "scope", "seq"]);
    }
    // ADR-0135 point 1: nothing but the allow-listed fields leaves
    expect(text.toString("utf8")).not.toContain(`REASON-a-${RUN}`);
    expect(text.toString("utf8")).not.toContain(`DETAIL-a-${RUN}`);
    expect(text.toString("utf8")).not.toContain(adminId);
    const after = await row(id);
    expect(after.state).toBe("active");
    expect(after.lastErrorCode).toBeNull();
    const [seqB] = await db.select({ seq: auditLog.seq }).from(auditLog).where(eq(auditLog.id, b));
    expect(after.cursorSeq).toBeGreaterThanOrEqual(Number(seqB!.seq));
  });
});

describe("refusals keep the cursor", () => {
  it("a receiver certificate from another CA is tls_handshake, and nothing is acknowledged", async () => {
    const url = `syslog+tls://${HOST}:${port}`;
    const res = await create({ name: `adr0351-${RUN}-wrongca`, kind: "syslog_tls", url, tlsCaPem: otherRoot.pem });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().destination.id;
    await enable(id, url);
    await writeAuditRow("c");
    const before = (await row(id)).cursorSeq;
    const pass = await deliverSiemDestinationOnce(db, id, DATA_KEY, deps);
    expect(pass).toMatchObject({ outcome: "failed", code: "tls_handshake" });
    const after = await row(id);
    expect(after.cursorSeq).toBe(before);
    expect(after.state).toBe("backoff");
    expect(after.lastErrorCode).toBe("tls_handshake");
  });

  it("the system trust store does not trust a private CA", async () => {
    const url = `syslog+tls://${HOST}:${port}`;
    const res = await create({ name: `adr0351-${RUN}-systemca`, kind: "syslog_tls", url });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().destination.customCa).toBe(false);
    const id = res.json().destination.id;
    await enable(id, url);
    await writeAuditRow("d");
    const pass = await deliverSiemDestinationOnce(db, id, DATA_KEY, deps);
    expect(pass).toMatchObject({ outcome: "failed", code: "tls_handshake" });
  });

  it("a host off the egress allow-list is egress_blocked and never dialled", async () => {
    const url = `syslog+tls://${UNLISTED}:${port}`;
    const res = await create({ name: `adr0351-${RUN}-unlisted`, kind: "syslog_tls", url, tlsCaPem: root.pem });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().destination.id;
    await enable(id, url);
    await writeAuditRow("e");
    received.length = 0;
    const pass = await deliverSiemDestinationOnce(db, id, DATA_KEY, deps);
    expect(pass).toMatchObject({ outcome: "failed", code: "egress_blocked" });
    expect(received).toHaveLength(0);
  });

  it("the database refuses a syslog row with a secret or plaintext (kind CHECK)", async () => {
    await expect(
      db.insert(siemDestinations).values({ name: `adr0351-${RUN}-chk`, kind: "syslog_tls", url: "syslog+tls://h:6514", secretCiphertext: "x", cursorSeq: 0 }),
    ).rejects.toThrow();
    await expect(
      db.insert(siemDestinations).values({ name: `adr0351-${RUN}-chk2`, kind: "webhook", url: "https://h/x", secretCiphertext: null, cursorSeq: 0 }),
    ).rejects.toThrow();
  });
});
