import { describe, expect, it } from "vitest";
import { SCRATCH_DB_FILES, analyzeTestFile, findEgressAllowLeaks } from "./preflight-egress-allow-cleanup.mjs";

describe("every gateway suite that adds an egress allow entry on the shared database removes it in afterAll (M-068, M-078)", () => {
  it("the repository has no leaking suite and no stale scratch-database exemption", () => {
    const { files, creators, leaks, stale } = findEgressAllowLeaks();
    // non-vacuity: the scan read the real suite and found the known creators
    expect(files.length).toBeGreaterThan(300);
    expect(creators).toContain("setup-status.test.ts");
    expect(creators).toContain("custom-providers.test.ts");
    for (const exempt of SCRATCH_DB_FILES.keys()) expect(creators).toContain(exempt);
    expect(leaks).toEqual([]);
    expect(stale).toEqual([]);
    // parsing ~45 suites with the compiler API takes seconds on a busy runner
  }, 30_000);

  it("a POST in beforeAll with no removal is a leak, in each call shape the suite uses", () => {
    for (const post of [
      `app.inject({ method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts", payload: {} })`,
      `inject("POST", "/v1/egress-allow-hosts", AUTH, {})`,
      `k.req("POST", "/v1/egress-allow-hosts", k.BOOT, {})`,
      `post("/v1/egress-allow-hosts", {})`,
      `db.insert(egressAllowHosts).values({ host: "127.0.0.1" })`,
      // a call whose method cannot be read counts as a POST
      `send("/v1/egress-allow-hosts")`,
    ]) {
      const a = analyzeTestFile(`beforeAll(async () => { await ${post}; });\nafterAll(async () => { await app.close(); });`);
      expect(a.creates, post).toBe(true);
      expect(a.cleansInAfterAll, post).toBe(false);
    }
  });

  it("a GET of the list is not a creation", () => {
    for (const get of [
      `app.inject({ method: "GET", headers: AUTH, url: "/v1/egress-allow-hosts" })`,
      `["GET", "/v1/egress-allow-hosts"]`,
      `page.request.get("/v1/egress-allow-hosts")`,
    ]) {
      expect(analyzeTestFile(`it("x", async () => { await ${get}; });`).creates, get).toBe(false);
    }
  });

  it("accepts every removal form, directly in afterAll or through a helper declared in the file", () => {
    const post = `beforeAll(async () => { await inject("POST", "/v1/egress-allow-hosts", {}); });\n`;
    for (const teardown of [
      `afterAll(async () => { await app.inject({ method: "DELETE", url: \`/v1/egress-allow-hosts/\${id}\` }); });`,
      `afterAll(async () => { await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1")); });`,
      `afterAll(async () => { const r = await removeEgressAllowEntry(app, AUTH, { id }); try {} finally { r.assertRemoved(); } });`,
      `const disallow = async (id) => { await inject("DELETE", \`/v1/egress-allow-hosts/\${id}\`); };\nafterAll(async () => { for (const id of ids) await disallow(id); });`,
      `function cleanup() { return db.delete(egressAllowHosts); }\nafterAll(async () => { await closeAll([cleanup]); });`,
      `describe("nested", () => { afterAll(async () => { await db.delete(egressAllowHosts); }); });`,
    ]) {
      expect(analyzeTestFile(post + teardown).cleansInAfterAll, teardown).toBe(true);
    }
  });

  it("a removal only at the end of a test body does not count — a failing assertion before it skips it", () => {
    const src = `beforeAll(async () => { await inject("POST", "/v1/egress-allow-hosts", {}); });
it("uses it", async () => {
  expect(1).toBe(1);
  await app.inject({ method: "DELETE", url: \`/v1/egress-allow-hosts/\${id}\` });
});
afterAll(async () => { await app.close(); });`;
    expect(analyzeTestFile(src)).toMatchObject({ creates: true, cleansInAfterAll: false });
  });

  describe("PER ENTRY: a create inside a test body needs its own cleanup", () => {
    const fileLevel = `beforeAll(async () => { await post("/v1/egress-allow-hosts", { host: "127.0.0.1" }); });
afterAll(async () => { await removeEgressAllowEntry(app, AUTH, { host: "127.0.0.1" }); });
`;

    it("a second host a test allow-lists is NOT covered by the file's afterAll removal", () => {
      const src = `${fileLevel}it("imds", async () => {
  await app.inject({ method: "POST", url: "/v1/egress-allow-hosts", payload: { host: "169.254.169.254" } });
  expect(1).toBe(1);
  await app.inject({ method: "DELETE", url: \`/v1/egress-allow-hosts/\${id}\` });
});`;
      const a = analyzeTestFile(src);
      expect(a.cleansInAfterAll).toBe(true);
      expect(a.untrackedTestCreates).toEqual([4]);
    });

    it("a try/finally DELETE after the POST statement is not enough either: the brief's credential-egress shape", () => {
      const src = `${fileLevel}it("imds", async () => {
  const r = await app.inject({ method: "POST", url: "/v1/egress-allow-hosts", payload: { host: "x" } });
  try { expect(1).toBe(1); } finally { await app.inject({ method: "DELETE", url: \`/v1/egress-allow-hosts/\${r.id}\` }); }
});`;
      expect(analyzeTestFile(src).untrackedTestCreates).toEqual([4]);
    });

    it("a host passed through trackHost with an afterEach removeAll is clean, and each half alone is not", () => {
      const create = `it.each([1])("imds %s", async () => {
  await app.inject({ method: "POST", url: "/v1/egress-allow-hosts", payload: { host: perTest.trackHost("169.254.169.254") } });
});\n`;
      const teardown = `afterEach(async () => { (await perTest.removeAll(app, AUTH)).assertRemoved(); });\n`;
      expect(analyzeTestFile(fileLevel + create + teardown)).toMatchObject({ cleansInAfterEach: true, untrackedTestCreates: [] });
      expect(analyzeTestFile(fileLevel + create).untrackedTestCreates).toHaveLength(1);
      const untracked = create.replace(`perTest.trackHost("169.254.169.254")`, `"169.254.169.254"`);
      expect(analyzeTestFile(fileLevel + untracked + teardown).untrackedTestCreates).toHaveLength(1);
    });

    it("a restore inside a finally, and a marked file-scoped or refused create, are accepted", () => {
      const restore = `it("withdraw", async () => {
  try { await db.delete(egressAllowHosts); } finally { await db.insert(egressAllowHosts).values(saved); }
});\n`;
      const marked = `it("shared", async () => {
  // egress-allow-cleanup: afterAll — the loopback entry later tests use
  const r = await post("/v1/egress-allow-hosts", { host: "127.0.0.1" });
});\n`;
      const refused = `it("non-admin", async () => {
  // egress-allow-cleanup: refused — a non-admin POST creates nothing
  for (const [m, u] of [["POST", "/v1/egress-allow-hosts"]]) await app.inject({ method: m, url: u });
});\n`;
      for (const body of [restore, marked, refused]) expect(analyzeTestFile(fileLevel + body).untrackedTestCreates, body).toEqual([]);
      // the marker must sit on the creating statement, not on the test
      const misplaced = `// egress-allow-cleanup: afterAll\nit("shared", async () => {\n  await post("/v1/egress-allow-hosts", { host: "127.0.0.1" });\n});\n`;
      expect(analyzeTestFile(fileLevel + misplaced).untrackedTestCreates).toHaveLength(1);
    });

    it("a create in beforeAll or in a helper stays a file-level create (afterAll rule only)", () => {
      const helper = `async function allow(h) { await post("/v1/egress-allow-hosts", { host: h }); }\nit("x", async () => { await allow("a"); });\n`;
      expect(analyzeTestFile(fileLevel + helper).untrackedTestCreates).toEqual([]);
    });
  });

  it("recognises a scratch database dropped from afterAll by the helper or by its own statement", () => {
    expect(analyzeTestFile(`afterAll(async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`afterAll(async () => { await control(\`DROP DATABASE "\${database}"\`); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`it("x", async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(false);
  });
});
