/**
 * ADR-0121 amendment (ADR-0183 2.6 review) — REGULAIT_PUBLIC_URL: what is a
 * valid value, that an invalid one refuses the boot before anything listens,
 * and that the posture and setup-status reads report it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { startGateway } from "./boot.js";
import { PublicUrlBootError, deploymentBaseUrl, joinPublicUrl, parsePublicUrl, publicUrlPosture } from "./public-url.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "public-url-boot";

describe("parsePublicUrl", () => {
  it("accepts an https origin, an optional base path, and http only on loopback", () => {
    expect(parsePublicUrl(undefined)).toBeNull();
    expect(parsePublicUrl("  ")).toBeNull();
    expect(parsePublicUrl("https://regulait.acme.example")).toBe("https://regulait.acme.example");
    expect(parsePublicUrl("https://regulait.acme.example/")).toBe("https://regulait.acme.example");
    expect(parsePublicUrl("https://acme.example:8443/gov/regulait/")).toBe("https://acme.example:8443/gov/regulait");
    expect(parsePublicUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parsePublicUrl("http://127.0.0.1:3105")).toBe("http://127.0.0.1:3105");
  });

  it("refuses everything else, by reason", () => {
    const bad: Array<[string, RegExp]> = [
      ["regulait.acme.example", /not an absolute URL/],
      ["http://regulait.acme.example", /https/],
      ["ftp://regulait.acme.example", /https/],
      ["https://user:pw@regulait.acme.example", /credentials/],
      ["https://regulait.acme.example/?next=evil", /query/],
      ["https://regulait.acme.example/#x", /fragment/],
      ["https://regulait.acme.example/a b", /base path/],
      ["https://regulait.acme.example/a%3Fb", /base path/],
      // ADR-0183 batch 2 review L3–L5: refused as written, never normalised
      ["https://:@regulait.acme.example", /credentials/],
      ["https://@regulait.acme.example", /credentials/],
      ["https://regulait.acme.example.", /dot/],
      ["https://regulait.acme.example./gov", /dot/],
      ["https://regulait.acme.example/..", /'\.' or '\.\.'/],
      ["https://regulait.acme.example/gov/../x", /'\.' or '\.\.'/],
      ["https://regulait.acme.example/./gov", /'\.' or '\.\.'/],
      ["https://regulait.acme.example/gov/%2e%2e", /'\.' or '\.\.'/],
    ];
    for (const [value, why] of bad) {
      expect(() => parsePublicUrl(value), value).toThrow(PublicUrlBootError);
      expect(() => parsePublicUrl(value), value).toThrow(why);
    }
  });

  it("sign-in/discovery base: the public URL when set (a forged Host ignored), else the request's scheme and Host", () => {
    const req = { protocol: "https", headers: { host: "attacker.example" } };
    expect(deploymentBaseUrl(req, { REGULAIT_PUBLIC_URL: "https://sp.example/gov" })).toBe("https://sp.example/gov");
    expect(deploymentBaseUrl(req, {})).toBe("https://attacker.example");
    expect(deploymentBaseUrl({ protocol: "http", headers: {} }, {})).toBe("http://localhost");
    expect(() => deploymentBaseUrl(req, { REGULAIT_PUBLIC_URL: "https://:@x.example" })).toThrow(PublicUrlBootError);
  });

  it("L5: joining the base and an in-app path never doubles /ui", () => {
    expect(joinPublicUrl("https://h.example", "/ui/admin?x=1")).toBe("https://h.example/ui/admin?x=1");
    expect(joinPublicUrl("https://h.example/gov", "/ui/admin")).toBe("https://h.example/gov/ui/admin");
    expect(joinPublicUrl("https://h.example/ui", "/ui/admin")).toBe("https://h.example/ui/admin");
    expect(joinPublicUrl("https://h.example/gov/ui", "/ui/builder/inbox?tab=all")).toBe("https://h.example/gov/ui/builder/inbox?tab=all");
    expect(joinPublicUrl("https://h.example/build", "/ui/x")).toBe("https://h.example/build/ui/x");
  });

  it("the posture fact: set and its value, or unset (never throws)", () => {
    expect(publicUrlPosture({ REGULAIT_PUBLIC_URL: "https://r.example/" } as NodeJS.ProcessEnv)).toEqual({ set: true, value: "https://r.example", env: "REGULAIT_PUBLIC_URL" });
    expect(publicUrlPosture({} as NodeJS.ProcessEnv)).toEqual({ set: false, value: null, env: "REGULAIT_PUBLIC_URL" });
    expect(publicUrlPosture({ REGULAIT_PUBLIC_URL: "http://evil.example" } as NodeJS.ProcessEnv).set).toBe(false);
  });
});

let db: Db;
let app: ReturnType<typeof buildApp>;
const prior = process.env.REGULAIT_PUBLIC_URL;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
});
afterAll(async () => {
  if (prior === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prior;
  await app.close();
  await db.$client.end();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

describe("boot and the posture reads", () => {
  it("an invalid REGULAIT_PUBLIC_URL refuses the boot before anything listens", async () => {
    const port = await freePort();
    await expect(
      startGateway({
        db,
        migrationsFolder,
        port,
        host: "127.0.0.1",
        bootstrapToken: BOOT,
        dataKey: "a".repeat(64),
        log: () => {},
        env: { PATH: process.env.PATH, VITEST: "1", REGULAIT_PUBLIC_URL: "http://regulait.evil.example" } as NodeJS.ProcessEnv,
      }),
    ).rejects.toBeInstanceOf(PublicUrlBootError);
    expect(await listening(port)).toBe(false);
  });

  it("GET /v1/org/posture and GET /v1/setup/status report it", async () => {
    const auth = { authorization: `Bearer ${BOOT}` };
    process.env.REGULAIT_PUBLIC_URL = "https://regulait.acme.example";
    const posture = await app.inject({ method: "GET", url: "/v1/org/posture", headers: auth });
    expect(posture.json().publicUrl).toEqual({ set: true, value: "https://regulait.acme.example", env: "REGULAIT_PUBLIC_URL" });
    delete process.env.REGULAIT_PUBLIC_URL;
    const setup = await app.inject({ method: "GET", url: "/v1/setup/status", headers: auth });
    expect(setup.json().publicUrl).toEqual({ set: false, value: null, env: "REGULAIT_PUBLIC_URL" });
  });
});
