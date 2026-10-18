import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATEWAY_SRC, SCRATCH_DB_FILES, analyzeTestFile, findEgressAllowLeaks } from "./preflight-egress-allow-cleanup.mjs";

/** the shared helper, imported the way a gateway test file at src/ imports it */
const IMPORT = 'import { removeEgressAllowEntry, trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";\n';
/** the 1-based line of the first line containing `needle` */
const lineOf = (src, needle) => src.split("\n").findIndex((l) => l.includes(needle)) + 1;
/** every create the analysis leaves uncovered, wherever it sits */
const flagged = (a) => [...a.uncoveredCreates, ...a.untrackedTestCreates, ...a.unmatchedMarkers];

describe("every egress allow entry a gateway suite creates on the shared database is removed through the helper (M-068, M-078, #427)", () => {
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
      const a = analyzeTestFile(`${IMPORT}beforeAll(async () => { await ${post}; });\nafterAll(async () => { await app.close(); });`);
      expect(a.creates, post).toBe(true);
      expect(a.uncoveredCreates, post).toEqual([2]);
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

  describe("the one accepted removal: removeEgressAllowEntry with the id the create returned", () => {
    const fileLevel = (create, teardown) => `${IMPORT}let saved;
beforeAll(async () => {
  ${create}
});
afterAll(async () => { ${teardown} });\n`;
    const POST = `const r = await post("/v1/egress-allow-hosts", { host: "127.0.0.1" });\n  saved = r.json().id;`;
    const REMOVE = `const loopback = await removeEgressAllowEntry(app, AUTH, { id: saved }); try { await app.close(); } finally { loopback.assertRemoved(); }`;

    it("accepts the saved id, in each way a suite records it and reaches the removal", () => {
      for (const [create, teardown] of [
        [POST, REMOVE],
        // a cast, a non-null assertion, an awaited json() and a typed json<T>()
        [`saved = ((await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json() as { id: string }).id;`, REMOVE],
        [`const r = await post("/v1/egress-allow-hosts", { host: "127.0.0.1" });\n  saved = r.json<{ id: string }>().id!;`, REMOVE],
        // destructured, and through a step-up wrapper whose callback returns the request
        [`const { id } = (await relaxStepUpAround(db, () => post("/v1/egress-allow-hosts", { host: "127.0.0.1" }))).json();\n  saved = id;`, REMOVE],
        // a direct insert with returning()
        [`const [row] = await db.insert(egressAllowHosts).values({ host: "127.0.0.1" }).returning({ id: egressAllowHosts.id });\n  saved = row.id;`, REMOVE],
        // pushed into a list the afterAll loop removes
        [`created.push((await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json().id);`, `for (const id of created) (await removeEgressAllowEntry(app, AUTH, { id })).assertRemoved();`],
        // through a function declared in the file, passed by name
        [POST, `await closeAll([cleanup]);\n});\nasync function cleanup() { (await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved(); }\nvoid (async () => {`],
        // the create in a helper that returns it, judged where the helper is called
        [`saved = (await allow("127.0.0.1")).json().id;\n});\nconst allow = (h) => post("/v1/egress-allow-hosts", { host: h });\nvoid (async () => {`, REMOVE],
      ]) {
        const src = fileLevel(create, teardown);
        expect(flagged(analyzeTestFile(src)), src).toEqual([]);
      }
    });

    it("a removal only at the end of a test body does not count — a failing assertion before it skips it", () => {
      const src = `${IMPORT}let saved;
beforeAll(async () => { saved = (await post("/v1/egress-allow-hosts", {})).json().id; });
it("uses it", async () => {
  expect(1).toBe(1);
  (await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved();
});
afterAll(async () => { await app.close(); });`;
      expect(analyzeTestFile(src).uncoveredCreates).toEqual([3]);
    });

    it("a helper function that creates without returning or saving the id is judged at each call, and flagged", () => {
      const src = `${IMPORT}let saved;
async function allow(h) { await post("/v1/egress-allow-hosts", { host: h }); }
beforeAll(async () => { await allow("a"); });
afterAll(async () => { (await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved(); });\n`;
      expect(analyzeTestFile(src).uncoveredCreates).toEqual([4]);
    });
  });

  describe("PER ENTRY: a create inside a test body needs its own cleanup", () => {
    const fileLevel = `${IMPORT}let loopbackId;
const perTest = trackEgressAllowHosts();
beforeAll(async () => { loopbackId = (await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json().id; });
afterAll(async () => { (await removeEgressAllowEntry(app, AUTH, { id: loopbackId })).assertRemoved(); });
`;

    it("a second host a test allow-lists is NOT covered by the file's afterAll removal", () => {
      const src = `${fileLevel}it("imds", async () => {
  await app.inject({ method: "POST", url: "/v1/egress-allow-hosts", payload: { host: "169.254.169.254" } });
});`;
      expect(analyzeTestFile(src).untrackedTestCreates).toEqual([lineOf(src, "169.254.169.254")]);
    });

    it("a host passed through trackHost with an afterEach removeAll is clean, and each half alone is not", () => {
      const create = `it.each([1])("imds %s", async () => {
  await app.inject({ method: "POST", url: "/v1/egress-allow-hosts", payload: { host: perTest.trackHost("169.254.169.254") } });
});\n`;
      const teardown = `afterEach(async () => { (await perTest.removeAll(app, AUTH)).assertRemoved(); });\n`;
      expect(flagged(analyzeTestFile(fileLevel + create + teardown))).toEqual([]);
      expect(analyzeTestFile(fileLevel + create).untrackedTestCreates).toHaveLength(1);
      const untracked = create.replace(`perTest.trackHost("169.254.169.254")`, `"169.254.169.254"`);
      expect(analyzeTestFile(fileLevel + untracked + teardown).untrackedTestCreates).toHaveLength(1);
    });

    it("the tracker must be the helper's, a const, removed from afterEach, and wrap the host itself (negative controls)", () => {
      const src = (decl, payload, hook = "afterEach", removed = "perTest") => `${IMPORT}${decl}
it("imds", async () => {
  await post("/v1/egress-allow-hosts", ${payload});
});
${hook}(async () => { (await ${removed}.removeAll(app, AUTH)).assertRemoved(); });\n`;
      const ok = ["const perTest = trackEgressAllowHosts();", `{ host: perTest.trackHost(IMDS) }`];
      expect(flagged(analyzeTestFile(src(...ok)))).toEqual([]);
      for (const [label, s] of [
        ["a let tracker can be reassigned", src("let perTest = trackEgressAllowHosts();", ok[1])],
        ["a tracker of another factory", src("const perTest = makeTracker();", ok[1])],
        ["trackHost on a field that is not the host", src(ok[0], `{ host: IMDS, note: perTest.trackHost(IMDS) }`)],
        ["trackHost inside an expression", src(ok[0], `{ host: perTest.trackHost(IMDS) + "." }`)],
        ["removed only in afterAll: later tests in the file still see it", src(ok[0], ok[1], "afterAll")],
        ["another tracker is removed", src(`${ok[0]}\nconst other = trackEgressAllowHosts();`, ok[1], "afterEach", "other")],
        ["a factory imported from another module", src(ok[0], ok[1]).replace("./testing/egress-allow-cleanup.js", "./fake-cleanup.js")],
      ]) {
        expect(flagged(analyzeTestFile(s)), label).toHaveLength(1);
      }
    });

    it("a restore inside a finally of a covered host, and a refused create, are accepted", () => {
      const restore = `it("withdraw", async () => {
  try { await withdraw(); } finally { await post("/v1/egress-allow-hosts", { host: "127.0.0.1" }); }
});\n`;
      const refused = `it("non-admin", async () => {
  // egress-allow-cleanup: refused — a non-admin POST creates nothing
  for (const [m, u] of [["POST", "/v1/egress-allow-hosts"]]) await app.inject({ method: m, url: u });
});\n`;
      for (const body of [restore, refused]) expect(flagged(analyzeTestFile(fileLevel + body)), body).toEqual([]);
      // a restore of a host no covered create posts is not covered
      const stray = restore.replace(`"127.0.0.1"`, `"169.254.169.254"`);
      expect(analyzeTestFile(fileLevel + stray).unmatchedMarkers).toEqual([lineOf(fileLevel + stray, "169.254.169.254")]);
      // the marker must sit on the creating statement, not on the test
      const misplaced = `// egress-allow-cleanup: refused\nit("shared", async () => {\n  await post("/v1/egress-allow-hosts", { host: "x" });\n});\n`;
      expect(analyzeTestFile(fileLevel + misplaced).untrackedTestCreates).toHaveLength(1);
    });

    it("the afterAll marker needs the create's saved id in an afterAll removal", () => {
      const byId = `${IMPORT}let allowId;
afterAll(async () => { (await removeEgressAllowEntry(app, AUTH, { id: allowId })).assertRemoved(); });
it("upsert", async () => {
  // egress-allow-cleanup: afterAll — the first POST's id is recorded in allowId
  const send = (note) => post("/v1/egress-allow-hosts", { host: H, note });
  const first = await send("a");
  allowId = first.json().id;
});\n`;
      expect(flagged(analyzeTestFile(byId))).toEqual([]);
      // judged where `send` is called
      expect(analyzeTestFile(byId.replace("allowId = first.json().id;", "")).unmatchedMarkers).toEqual([7]);
      // a marked upsert of the same host in the same test is covered by its sibling; a different host is not
      const pushed = `${IMPORT}const created = { allowHosts: [] };
afterAll(async () => { for (const id of created.allowHosts) (await removeEgressAllowEntry(app, AUTH, { id })).assertRemoved(); });
it("add, then upsert the same host", async () => {
  const host = "a.example.test";
  const payload = { host, note: "n" };
  // egress-allow-cleanup: afterAll — the id lands in created.allowHosts
  const added = await post("/v1/egress-allow-hosts", payload);
  created.allowHosts.push(added.json().id);
  // egress-allow-cleanup: afterAll — the same host (an upsert)
  const again = await post("/v1/egress-allow-hosts", { host, note: "edited" });
  // egress-allow-cleanup: afterAll — a DIFFERENT host is not covered by the sibling
  const stray = await post("/v1/egress-allow-hosts", { host: otherHost });
});\n`;
      expect(analyzeTestFile(pushed).unmatchedMarkers).toEqual([13]);
    });
  });

  describe("#427 review N1: every removal form that is not the helper with the saved id is flagged (negative fixtures)", () => {
    /** a marked create of IMDS whose id is recorded in `saved`, with `removal` in afterAll */
    const marked = (removal, { prefix = "", host = "IMDS", record = "saved = r.json().id;" } = {}) => `${IMPORT}${prefix}const IMDS = "169.254.169.254";
const T = egressAllowHosts;
let saved;
afterAll(async () => { (await ${removal}).assertRemoved(); });
it("imds", async () => {
  // egress-allow-cleanup: afterAll — claimed removed by the afterAll above
  const r = await post("/v1/egress-allow-hosts", { host: ${host} });
  ${record}
});\n`;
    const CREATE_LINE = 8;
    const expectFlagged = (src, label) => expect(analyzeTestFile(src).unmatchedMarkers, label).toEqual([lineOf(src, 'post("/v1/egress-allow-hosts"')]);

    it("the live control: the same fixture with the helper and the saved id is accepted", () => {
      expect(lineOf(marked("x"), 'post("/v1/egress-allow-hosts"')).toBe(CREATE_LINE);
      expect(flagged(analyzeTestFile(marked("removeEgressAllowEntry(app, AUTH, { id: saved })")))).toEqual([]);
      expect(flagged(analyzeTestFile(marked("removeEgressAllowEntry(app, AUTH, { id: (saved as string)! })")))).toEqual([]);
    });

    it("the reviewer's table, row by row (a–e), and the earlier rounds' filters", () => {
      for (const removal of [
        // a. an inner .where, and a subquery
        "db.delete(T).where(ne(T.host, IMDS)).then(() => db.select().from(T).where(eq(T.host, IMDS)))",
        "db.delete(T).where(notExists(db.select().from(T).where(eq(T.host, IMDS))))",
        // b. and narrows
        "db.delete(T).where(and(eq(T.host, IMDS), ne(T.host, IMDS)))",
        'db.delete(T).where(and(eq(T.host, IMDS), eq(T.host, "x")))',
        "db.delete(T).where(and(eq(T.host, IMDS), sql`false`))",
        // c. the value transformed
        "db.delete(T).where(eq(T.host, IMDS.toUpperCase()))",
        "db.delete(T).where(eq(T.host, `${IMDS}.`))",
        "db.delete(T).where(eq(T.host, ` ${IMDS}`))",
        'db.delete(T).where(eq(T.host, IMDS + ":80"))',
        'db.delete(T).where(inArray(T.host, [IMDS].map((h) => h + ".")))',
        "db.delete(T).where(eq(T.id, saved + 1))",
        // c. a REST url with a tail
        "app.inject({ method: \"DELETE\", url: `/v1/egress-allow-hosts/${saved}x` })",
        "app.inject({ method: \"DELETE\", url: `/v1/egress-allow-hosts/${saved}/../other` })",
        // d. not the table's column
        "db.delete(T).where(eq(cfg.host, IMDS))",
        // the forms the earlier rounds read as removals, even when exact: no hand-written filter counts now
        "db.delete(T).where(eq(T.host, IMDS))",
        "db.delete(T).where(eq(T.id, saved))",
        "app.inject({ method: \"DELETE\", url: `/v1/egress-allow-hosts/${saved}` })",
        "db.delete(T).where(not(eq(T.host, IMDS)))",
        "db.delete(T).where(ne(T.host, IMDS))",
        "db.delete(T).where(notInArray(T.host, [IMDS]))",
        "db.delete(T).where(or(eq(T.host, IMDS), eq(T.id, saved)))",
        // the helper's old host form is gone, whatever host it names
        'removeEgressAllowEntry(app, AUTH, { host: "169.254.169.254" })',
        "removeEgressAllowEntry(app, AUTH, { host: IMDS })",
      ]) {
        expectFlagged(marked(removal), removal);
      }
    });

    it("e. server-side normalisation: a raw-literal delete of a host the route stored normalised is flagged", () => {
      for (const host of ['"Metadata.Example."', '" 169.254.169.254"', '"[::1]"']) {
        expectFlagged(marked(`db.delete(T).where(eq(T.host, ${host}))`, { host }), host);
      }
    });

    it("the helper with anything but the saved id is flagged: a transformed value, an extra field, a wrong read", () => {
      for (const removal of [
        "removeEgressAllowEntry(app, AUTH, { id: saved + 1 })",
        "removeEgressAllowEntry(app, AUTH, { id: `${saved}x` })",
        "removeEgressAllowEntry(app, AUTH, { id: String(saved) })",
        "removeEgressAllowEntry(app, AUTH, { id: saved.trim() })",
        "removeEgressAllowEntry(app, AUTH, { id: flag ? saved : other })",
        "removeEgressAllowEntry(app, AUTH, { id: other })",
        "removeEgressAllowEntry(app, AUTH, { id: saved, note: saved })",
        "removeEgressAllowEntry(app, AUTH, { ...{ id: saved } })",
        "removeEgressAllowEntry(app, AUTH, target)",
        "removeEgressAllowEntry(app, { id: saved })",
        "helpers.removeEgressAllowEntry(app, AUTH, { id: saved })",
        "keep.forEach((id) => removeEgressAllowEntry(app, AUTH, { id }))",
      ]) {
        expectFlagged(marked(removal), removal);
      }
      // the id is not carried by a read of another property, arithmetic, or a call
      for (const record of [
        "saved = r.json().host;",
        "saved = r.json().id + 1;",
        "saved = String(r.json().id);",
        "saved = `${r.json().id}`;",
        "const bad = r.json(); saved = bad.host;",
        "const { host: id } = r.json(); saved = id;",
      ]) {
        expectFlagged(marked("removeEgressAllowEntry(app, AUTH, { id: saved })", { record }), record);
      }
    });

    it("f. a rebinding of the helper's name, or of drizzle's, is flagged", () => {
      const REMOVE = "removeEgressAllowEntry(app, AUTH, { id: saved })";
      for (const src of [
        // an alias, or an import from another module
        marked(REMOVE).replace("import { removeEgressAllowEntry,", "import { removeAll as removeEgressAllowEntry,"),
        marked(REMOVE).replace("./testing/egress-allow-cleanup.js", "./fake-drizzle.js"),
        marked(REMOVE).replace("./testing/egress-allow-cleanup.js", "egress-allow-cleanup"),
        // shadowed inside the afterAll: a destructured element, an array pattern, a parameter, a function, an import-equals
        marked(`(() => { const { ne: removeEgressAllowEntry } = drizzle; return ${REMOVE}; })()`),
        marked(`(() => { const [removeEgressAllowEntry] = [ne]; return ${REMOVE}; })()`),
        marked(`((removeEgressAllowEntry) => ${REMOVE})(ne)`),
        marked(`(() => { function removeEgressAllowEntry() {} return ${REMOVE}; })()`),
        marked(REMOVE, { prefix: 'import removeEgressAllowEntry = require("./x");\n' }),
        // a second, file-level declaration of the same name
        marked(REMOVE, { prefix: "var removeEgressAllowEntry;\n" }),
      ]) {
        expect(analyzeTestFile(src).unmatchedMarkers, src.split("\n").slice(0, 5).join("\n")).toEqual([lineOf(src, 'post("/v1/egress-allow-hosts"')]);
      }
      // the reviewer's drizzle rebindings: a DB delete names nothing whatever eq is bound to
      for (const prefix of [
        "const { ne: eq } = drizzle;\n",
        "const [eq] = [ne];\n",
        'import { eq } from "./fake-drizzle";\n',
        'import eq = require("./x");\n',
        'import { ne as eq } from "drizzle-orm";\n',
      ]) {
        expectFlagged(marked("db.delete(T).where(eq(T.host, IMDS))", { prefix }), prefix);
      }
    });
  });

  describe("#427 round 3 M1: one saved binding per created row (a reused or reassigned binding is flagged)", () => {
    const REMOVE = "(await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved();";
    /** two marked creates in two tests, each saving its id with `recordA` / `recordB` */
    const pair = (hostA, hostB, { recordA = "saved = r.json().id;", recordB = "saved = r2.json().id;", prefix = "" } = {}) => `${IMPORT}${prefix}let saved;
afterAll(async () => { ${REMOVE} });
it("a", async () => { // egress-allow-cleanup: afterAll
  const r = await post("/v1/egress-allow-hosts", { host: ${hostA} }); ${recordA}
});
it("b", async () => { // egress-allow-cleanup: afterAll
  const r2 = await post("/v1/egress-allow-hosts", { host: ${hostB} }); ${recordB}
});\n`;

    it("the reviewer's probe: two hosts saved into one variable are both flagged (only the last row would be removed)", () => {
      const src = pair('IMDS', '"metadata.example"', { prefix: 'const IMDS = "169.254.169.254";\n' });
      expect(analyzeTestFile(src).unmatchedMarkers).toEqual([lineOf(src, "{ host: IMDS }"), lineOf(src, '"metadata.example" }')]);
      // a host the analysis cannot read is not the same row as anything
      expect(flagged(analyzeTestFile(pair("cfg.host", "cfg.host")))).toHaveLength(2);
      expect(flagged(analyzeTestFile(pair('"a.example"', "`a.example`.trim()")))).toHaveLength(2);
    });

    it("live controls: the same row re-created into one variable (an upsert by host), and different rows pushed to a list", () => {
      for (const src of [
        pair('"127.0.0.1"', '"127.0.0.1"'),
        // a const with the literal is the same row as the literal
        pair('LOOPBACK', '"127.0.0.1"', { prefix: 'const LOOPBACK = "127.0.0.1";\n' }),
        // pushed: every row stays named
        pair('"a.example"', '"b.example"', { recordA: "ids.push(r.json().id);", recordB: "ids.push(r2.json().id);", prefix: "const ids = [];\n" }).replace(
          REMOVE,
          "for (const id of ids) (await removeEgressAllowEntry(app, AUTH, { id })).assertRemoved();",
        ),
      ]) {
        expect(flagged(analyzeTestFile(src)), src).toEqual([]);
      }
    });

    it("a create in a function is judged per call with the host its argument names", () => {
      const viaFn = (a, b) => `${IMPORT}let saved;
const allow = async (h) => { saved = (await post("/v1/egress-allow-hosts", { host: h })).json().id; };
beforeAll(async () => { await allow(${a}); await allow(${b}); });
afterAll(async () => { ${REMOVE} });\n`;
      expect(flagged(analyzeTestFile(viaFn('"127.0.0.1"', '"127.0.0.1"')))).toEqual([]);
      const two = viaFn('"a.example"', '"b.example"');
      expect(analyzeTestFile(two).uncoveredCreates).toEqual([lineOf(two, "beforeAll")]);
    });

    it("a write to the saved binding that is not a create's result is flagged (review L1: the backstop never fires)", () => {
      for (const later of [
        "saved = undefined;",
        'saved = "fixed-id";',
        "saved ??= other;",
        "[saved] = [other];",
        "({ id: saved } = other);",
        "saved += \"\";",
      ]) {
        const src = pair('"127.0.0.1"', '"127.0.0.1"').replace('it("b"', `it("c", () => { ${later} });\nit("b"`);
        expect(flagged(analyzeTestFile(src)), later).toHaveLength(2);
      }
      const list = (later) => `${IMPORT}let ids = [];
afterAll(async () => { for (const id of ids) (await removeEgressAllowEntry(app, AUTH, { id })).assertRemoved(); });
beforeAll(async () => { ids.push((await post("/v1/egress-allow-hosts", { host: "a" })).json().id); });
it("x", () => { ${later} });\n`;
      expect(flagged(analyzeTestFile(list("expect(1).toBe(1);")))).toEqual([]);
      for (const later of ["ids = [];", "ids.length = 0;", "ids.splice(0);", "ids.pop();", "ids.shift();"]) {
        expect(analyzeTestFile(list(later)).uncoveredCreates, later).toEqual([4]);
      }
    });
  });

  describe("#427 round 3 L1: the removal must run, and its result must be asserted", () => {
    const file = (body) => `${IMPORT}let saved;
beforeAll(async () => { saved = (await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json().id; });
afterAll(async () => { ${body} });
async function cleanup() { (await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved(); }\n`;
    const CALL = "removeEgressAllowEntry(app, AUTH, { id: saved })";

    it("live controls: asserted directly, through a const in a finally, through a pushed list, and through a function called unconditionally", () => {
      for (const body of [
        `(await ${CALL}).assertRemoved();`,
        `const x = await ${CALL}; try { await app.close(); } finally { x.assertRemoved(); }`,
        `const rs = []; rs.push(await ${CALL}); try { await app.close(); } finally { for (const r of rs) r.assertRemoved(); }`,
        "await cleanup();",
        "await closeAll([cleanup]);",
      ]) {
        expect(flagged(analyzeTestFile(file(body))), body).toEqual([]);
      }
    });

    it("negative fixtures: unasserted, conditional, unreachable, or in a function never called", () => {
      for (const body of [
        `await ${CALL};`,
        `void ${CALL};`,
        `const x = await ${CALL};`,
        `let x = await ${CALL}; x.assertRemoved();`,
        `const x = await ${CALL}; if (ok) x.assertRemoved();`,
        `const x = await ${CALL}; const later = () => x.assertRemoved();`,
        `const rs = []; rs.push(await ${CALL});`,
        `if (false) (await ${CALL}).assertRemoved();`,
        `flag ? (await ${CALL}).assertRemoved() : 0;`,
        `flag && (await ${CALL}).assertRemoved();`,
        `return; (await ${CALL}).assertRemoved();`,
        `try { await app.close(); (await ${CALL}).assertRemoved(); } finally { }`,
        `try { await app.close(); } catch { (await ${CALL}).assertRemoved(); }`,
        `while (more) (await ${CALL}).assertRemoved();`,
        `const never = async () => (await ${CALL}).assertRemoved();`,
        `(await ${CALL})?.assertRemoved();`,
        "if (flag) await cleanup();",
        "return; await cleanup();",
      ]) {
        expect(analyzeTestFile(file(body)).uncoveredCreates, body).toEqual([lineOf(file(body), "beforeAll")]);
      }
    });

    it("the tracker's removeAll must be asserted too", () => {
      const src = (hook) => `${IMPORT}const perTest = trackEgressAllowHosts();
it("imds", async () => { await post("/v1/egress-allow-hosts", { host: perTest.trackHost(IMDS) }); });
afterEach(async () => { ${hook} });\n`;
      expect(flagged(analyzeTestFile(src("(await perTest.removeAll(app, AUTH)).assertRemoved();")))).toEqual([]);
      expect(analyzeTestFile(src("await perTest.removeAll(app, AUTH);")).untrackedTestCreates).toEqual([lineOf(src(""), "post(")]);
    });

    it("a marked create in a test is covered by a tracker removed from afterAll; unmarked it still needs afterEach", () => {
      const src = (marker) => `${IMPORT}const allowed = trackEgressAllowHosts();
afterAll(async () => { (await allowed.removeAll(app, AUTH)).assertRemoved(); });
it("withdraw and restore", async () => {
  ${marker}
  await post("/v1/egress-allow-hosts", { host: allowed.trackHost(H) });
});\n`;
      expect(flagged(analyzeTestFile(src("// egress-allow-cleanup: afterAll")))).toEqual([]);
      expect(analyzeTestFile(src("")).untrackedTestCreates).toEqual([lineOf(src(""), "post(")]);
    });
  });

  it("#427 round 3 L2: only the one real helper module counts, resolved from the test file's directory", () => {
    const src = (spec) => `import { removeEgressAllowEntry } from "${spec}";
let saved;
beforeAll(async () => { saved = (await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json().id; });
afterAll(async () => { (await removeEgressAllowEntry(app, AUTH, { id: saved })).assertRemoved(); });\n`;
    for (const [spec, fileName] of [
      ["./testing/egress-allow-cleanup.js", "x.test.ts"],
      ["./testing/egress-allow-cleanup", "x.test.ts"],
      ["../testing/egress-allow-cleanup.js", "sub/x.test.ts"],
    ]) {
      expect(flagged(analyzeTestFile(src(spec), fileName)), `${fileName}: ${spec}`).toEqual([]);
    }
    for (const [spec, fileName] of [
      ["./fake/testing/egress-allow-cleanup.js", "x.test.ts"],
      ["./testing/egress-allow-cleanup.js", "sub/x.test.ts"],
      ["../testing/egress-allow-cleanup.js", "x.test.ts"],
      ["../../src/testing/egress-allow-cleanup.js", "sub/x.test.ts"],
      ["/abs/testing/egress-allow-cleanup.js", "x.test.ts"],
    ]) {
      expect(analyzeTestFile(src(spec), fileName).uncoveredCreates, `${fileName}: ${spec}`).toEqual([lineOf(src(spec), "beforeAll")]);
    }
  });

  it("#427 round 3 L3: a payload with one tracked and one untracked host is flagged (the untracked count guard)", () => {
    const src = `${IMPORT}const perTest = trackEgressAllowHosts();
it("imds", async () => {
  await post("/v1/egress-allow-hosts", flag ? { host: perTest.trackHost("a.example") } : { host: "b.example" });
});
afterEach(async () => { (await perTest.removeAll(app, AUTH)).assertRemoved(); });\n`;
    expect(analyzeTestFile(src).untrackedTestCreates).toEqual([lineOf(src, "post(")]);
  });

  it("review L3: findEgressAllowLeaks reports an unremoved create as a leak (and a removed one as clean)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "egress-preflight-"));
    try {
      const dir = path.join(base, GATEWAY_SRC);
      mkdirSync(dir, { recursive: true });
      const file = (removal) => `${IMPORT}let saved;
beforeAll(async () => { saved = (await post("/v1/egress-allow-hosts", { host: "127.0.0.1" })).json().id; });
afterAll(async () => { (await ${removal}).assertRemoved(); });
`;
      writeFileSync(path.join(dir, "leaks.test.ts"), file("db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, saved))"));
      writeFileSync(path.join(dir, "clean.test.ts"), file("removeEgressAllowEntry(app, AUTH, { id: saved })"));
      const { leaks } = findEgressAllowLeaks(base);
      expect(leaks).toEqual([expect.stringContaining("leaks.test.ts (creates at line 3, and no afterAll removes that entry through the helper)")]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("recognises a scratch database dropped from afterAll by the helper or by its own statement", () => {
    expect(analyzeTestFile(`afterAll(async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`afterAll(async () => { await control(\`DROP DATABASE "\${database}"\`); });`).dropsScratchDb).toBe(true);
    expect(analyzeTestFile(`it("x", async () => { await dropScratchDatabase(admin, NAME); });`).dropsScratchDb).toBe(false);
  });
});
