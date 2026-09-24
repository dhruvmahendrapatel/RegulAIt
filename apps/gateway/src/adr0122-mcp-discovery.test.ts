import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * ADR-0122 — MCP DISCOVERY AND THE REGISTRY DIFF.
 *
 * Detecting an MCP endpoint in a log is half a capability; the half that
 * matters is "and it is not one of mine". So the load-bearing assertions here
 * are the DIFF: a registered host must come back governed and an unknown one
 * must come back unregistered, **in the same response**, from the same
 * evidence. Asserting only the unregistered half would pass just as well
 * against a route that called everything unregistered (M-033).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0122-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

/**
 * Two DISTINCT loopback addresses. The egress guard resolves a server's host at
 * REGISTRATION time and refuses one that does not exist — correct behaviour,
 * and it rules out invented hostnames as fixtures. Loopback resolves, is
 * permitted under the default private-ranges posture, and reaches nothing.
 */
/** the host we REGISTER, so the governed side of the diff is real */
const KNOWN = "127.0.0.1";
/** the host we do NOT register — the thing the PoC criterion asks for */
const UNKNOWN = "127.0.0.2";

let db: Db;
let app: ReturnType<typeof buildApp>;

const evidence = [
  `2026-09-24T10:00:01Z POST https://${KNOWN}/mcp 200 {"jsonrpc":"2.0","method":"tools/call"}`,
  `2026-09-24T10:00:02Z POST https://${UNKNOWN}/mcp 200 {"jsonrpc":"2.0","method":"tools/call"}`,
  `2026-09-24T10:00:03Z GET  https://www.example.com/index.html 200`,
].join("\n");

const discover = (mode: "preview" | "apply" = "preview") =>
  app.inject({
    method: "POST",
    url: "/v1/shadow-ai/mcp-discovery",
    headers: AUTH,
    payload: { content: evidence, mode },
  });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });

  // Register ONE of the two hosts. `allowPrivateRanges` is irrelevant here —
  // nothing is connected to; the row exists only to be diffed against.
  const reg = await app.inject({
    method: "POST",
    url: "/v1/servers",
    headers: AUTH,
    payload: { name: `known-server-${RUN}`, url: `http://${KNOWN}:9/mcp`, allowPrivateRanges: true },
  });
  expect(reg.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe("the registry diff — what makes detection an answer", () => {
  it("reports the unregistered host AND the registered one, from the same evidence", async () => {
    const res = await discover();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byHost = new Map<string, { registered: boolean; verdict: string; registeredAs: string | null }>(
      body.results.map((r: { host: string }) => [r.host, r as never]),
    );

    // the POSITIVE half: a registered server is reported as governed, named.
    // Without this, "everything is unregistered" would pass.
    const known = byHost.get(KNOWN)!;
    expect(known).toBeTruthy();
    expect(known.registered).toBe(true);
    expect(known.registeredAs).toBe(`known-server-${RUN}`);
    expect(known.verdict).toMatch(/governed/);

    // the criterion itself
    const rogue = byHost.get(UNKNOWN)!;
    expect(rogue).toBeTruthy();
    expect(rogue.registered).toBe(false);
    expect(rogue.verdict).toMatch(/UNREGISTERED/);

    expect(body.unregistered).toBe(1);
    expect(body.registryCount).toBeGreaterThanOrEqual(1);
  });

  it("ignores the ordinary web traffic in the same file", async () => {
    const body = (await discover()).json();
    expect(body.results.map((r: { host: string }) => r.host)).not.toContain("www.example.com");
    // paired positive: it DID read the file and find the two MCP hosts, so the
    // absence above is discrimination rather than a parser that found nothing
    expect(body.observed).toBe(2);
  });

  it("carries its own posture on the payload, so the limit travels with the answer", async () => {
    const body = (await discover()).json();
    expect(body.posture).toMatch(/Nothing is scanned, resolved, crawled or connected to/);
  });

  it("preview writes NOTHING; apply writes one audited record", async () => {
    const count = async () =>
      (await db.select().from(auditLog).where(eq(auditLog.ruleId, "mcp-discovery-applied"))).length;

    const before = await count();
    await discover("preview");
    expect(await count()).toBe(before);

    const applied = await discover("apply");
    expect(applied.statusCode).toBe(200);
    // positive control: the apply run really did find the rogue host, so the
    // +1 below is the delta of a run that had something to report
    expect(applied.json().unregistered).toBe(1);
    expect(await count()).toBe(before + 1);
  });

  it("a host registered under a different URL shape still matches — the diff normalizes both sides", async () => {
    // registered as https://host/mcp; evidence says the same host on a port
    const res = await app.inject({
      method: "POST",
      url: "/v1/shadow-ai/mcp-discovery",
      headers: AUTH,
      payload: { content: `POST https://${KNOWN}:8443/mcp 200 {"method":"tools/call"}` },
    });
    const r = res.json().results[0];
    expect(r.host).toBe(KNOWN);
    expect(r.registered).toBe(true);
  });
});
