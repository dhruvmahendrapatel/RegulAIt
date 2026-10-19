/**
 * G9 (owner, 2026-10-19: "Seed demo data for the G9 screens") — the `demo:check` beat for the Incidents and Feedback
 * and appeals screens, over a stubbed API: PASS only when the screens' DEFAULT filters (active incidents, open items in
 * the queue) show the seeded open work routed to Ada, and FAIL with the rerun hint otherwise. The seeded story itself is
 * pinned against a database by zz-c6-demo-intake-seed.test.ts and zz-c11-demo-check.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkG9Records, G9_BEAT } from "./demo-check-lib.js";
import { DEMO_OPEN_INCIDENT_TITLE } from "./demo-intake-seed-lib.js";

type Json = Record<string, any>;
const ADA = "00000000-0000-4000-8000-00000000000a";
const DANA = "00000000-0000-4000-8000-00000000000d";

const incident = (over: Json = {}): Json => ({
  id: "inc-1", ref: "INC-0002", title: DEMO_OPEN_INCIDENT_TITLE, status: "open", severity: "medium", ownerUserId: DANA, ownerName: "Dana Developer", ...over,
});
const item = (kind: string, status: string, ownerUserId: string = ADA): Json => ({ id: `${kind}-${status}`, kind, status, ownerUserId });

function api(w: { incidents?: Json[]; events?: number; actions?: string[]; items?: Json[] }) {
  const urls: string[] = [];
  const get = async (url: string) => {
    urls.push(url);
    if (url === "/v1/incidents?status=active") return { status: 200, body: { incidents: w.incidents ?? [incident()] } };
    if (url.startsWith("/v1/incidents/")) {
      return {
        status: 200,
        body: {
          events: Array.from({ length: w.events ?? 4 }, (_, i) => ({ id: `e${i}` })),
          actions: (w.actions ?? ["open"]).map((status, i) => ({ id: `a${i}`, status })),
        },
      };
    }
    if (url === "/v1/feedback?scope=queue&status=open") return { status: 200, body: { items: w.items ?? [item("problem", "received"), item("appeal", "acknowledged")] } };
    return { status: 404, body: {} };
  };
  return { get, urls };
}

describe("checkG9Records", () => {
  it("PASSes on the seeded open work, read through the screens' default filters", async () => {
    const { get, urls } = api({});
    const [c] = await checkG9Records(get, ADA);
    expect(c).toMatchObject({ beat: G9_BEAT, level: "PASS" });
    expect(c!.detail).toBe(
      "incident INC-0002 open, medium, owned by Dana Developer, 4 timeline entries; " +
        "2 open feedback items routed to Ada (acknowledged, received; an appeal among them)",
    );
    expect(urls).toEqual(["/v1/incidents?status=active", "/v1/incidents/inc-1", "/v1/feedback?scope=queue&status=open"]);
  });

  it.each([
    ["the incident is missing (closed, or never seeded)", { incidents: [incident({ title: "another incident" })] }, "no open demo incident"],
    ["the incident has no owner", { incidents: [incident({ ownerUserId: null })] }, "has no owner"],
    ["the timeline is too short", { events: 1 }, "1 timeline entry"],
    ["the corrective action is done", { actions: ["done"] }, "no open corrective action"],
    ["one item only", { items: [item("appeal", "acknowledged")] }, "1 open feedback item(s) routed to Ada (2 needed)"],
    ["the items are routed to someone else", { items: [item("problem", "received", DANA), item("appeal", "acknowledged", DANA)] }, "0 open feedback item(s) routed to Ada"],
    ["both in one state", { items: [item("problem", "received"), item("appeal", "received")] }, "all received"],
    ["no appeal", { items: [item("problem", "received"), item("problem", "acknowledged")] }, "no open appeal routed to Ada"],
  ])("FAILs with the rerun hint when %s", async (_why, w, detail) => {
    const [c] = await checkG9Records(api(w).get, ADA);
    expect(c!.level).toBe("FAIL");
    expect(c!.detail).toContain(detail);
    expect(c!.fix).toContain("re-run `demo:intake`");
    expect(c!.fix).toContain("`demo:intake --live`");
  });

  it("FAILs when Ada is not a user (nothing can be routed to her)", async () => {
    const [c] = await checkG9Records(api({}).get, undefined);
    expect(c!.level).toBe("FAIL");
    expect(c!.detail).toContain("0 open feedback item(s) routed to Ada");
  });
});
