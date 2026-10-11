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

  it("recognises a scratch database dropped from afterAll by the helper or by its own statement", () => {
    expect(analyzeTestFile(`afterAll(async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`afterAll(async () => { await control(\`DROP DATABASE "\${database}"\`); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`it("x", async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(false);
  });
});
