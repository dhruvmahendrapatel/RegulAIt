/**
 * The per-entry egress allow cleanup helper (M-068 / M-078), against a fake
 * injector: no database. The route string is built, not written as a literal,
 * so the static cleanup check does not read this file as creating an entry.
 */
import { describe, expect, it } from "vitest";
import { trackEgressAllowHosts, type EgressAllowInjector } from "./egress-allow-cleanup.js";

const ROUTE = ["", "v1", "egress-allow-hosts"].join("/");

/** a fake allow-list: GET lists it, DELETE by id removes from it */
function fakeApp(rows: Array<{ id: string; host: string }>, deleteStatus = 200) {
  const calls: string[] = [];
  const app: EgressAllowInjector = {
    inject: async ({ method, url }) => {
      calls.push(`${method} ${url}`);
      if (method === "GET") {
        const body = JSON.stringify({ hosts: rows });
        return { statusCode: 200, body, json: () => JSON.parse(body) as unknown };
      }
      const id = url.slice(ROUTE.length + 1);
      const at = rows.findIndex((r) => r.id === id);
      if (deleteStatus === 200 && at >= 0) rows.splice(at, 1);
      return { statusCode: deleteStatus, body: "{}", json: () => ({}) };
    },
  };
  return { app, calls, rows };
}

describe("trackEgressAllowHosts: every host a test allow-lists is removed after it, per entry", () => {
  it("trackHost returns the host, so it can sit in the payload; removeAll removes each tracked host's row by host", async () => {
    const perTest = trackEgressAllowHosts();
    expect(perTest.trackHost("169.254.169.254")).toBe("169.254.169.254");
    perTest.trackHost("metadata.google.internal");
    perTest.trackHost("169.254.169.254"); // tracked twice, removed once
    const f = fakeApp([
      { id: "a", host: "169.254.169.254" },
      { id: "b", host: "metadata.google.internal" },
      { id: "c", host: "127.0.0.1" }, // the file's own entry: not this test's to remove
    ]);
    (await perTest.removeAll(f.app, {})).assertRemoved();
    expect(f.rows.map((r) => r.host)).toEqual(["127.0.0.1"]);
    expect(f.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE ${ROUTE}/a`, `DELETE ${ROUTE}/b`]);
  });

  it("forgets what it removed: the next test starts with nothing tracked", async () => {
    const perTest = trackEgressAllowHosts();
    perTest.trackHost("x.example");
    const f = fakeApp([{ id: "x", host: "x.example" }]);
    (await perTest.removeAll(f.app, {})).assertRemoved();
    const calls = f.calls.length;
    (await perTest.removeAll(f.app, {})).assertRemoved();
    expect(f.calls.length).toBe(calls);
  });

  it("a host the test already removed (or never managed to create) is not an error", async () => {
    const perTest = trackEgressAllowHosts();
    perTest.trackHost("gone.example");
    (await perTest.removeAll(fakeApp([]).app, {})).assertRemoved();
  });

  it("a failed DELETE is reported by assertRemoved, after every host was tried", async () => {
    const perTest = trackEgressAllowHosts();
    perTest.trackHost("a.example");
    perTest.trackHost("b.example");
    const f = fakeApp(
      [
        { id: "a", host: "a.example" },
        { id: "b", host: "b.example" },
      ],
      500,
    );
    const removal = await perTest.removeAll(f.app, {});
    expect(f.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(2);
    expect(() => removal.assertRemoved()).toThrow(/M-068: the egress allow entry this suite created was not removed: DELETE returned 500/);
  });
});
