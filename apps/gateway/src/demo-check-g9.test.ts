/**
 * G9 (owner, 2026-10-19: "Seed demo data for the G9 screens") — the `demo:check` beat for the Incidents and Feedback
 * and appeals screens, over a stubbed API: PASS only when the screens' DEFAULT filters (active incidents, open items in
 * the queue) show the seeded open work routed to Ada, and FAIL with the rerun hint otherwise. The seeded story itself is
 * pinned against a database by zz-c6-demo-intake-seed.test.ts and zz-c11-demo-check.test.ts.
 */
import { describe, expect, it } from "vitest";
import { checkG9Records, G9_BEAT } from "./demo-check-lib.js";
import { DEMO_OPEN_ACCOUNTABILITY_USE_CASE, DEMO_OPEN_ACTION_NOT_DUE_BEFORE, DEMO_OPEN_INCIDENT_TITLE } from "./demo-intake-seed-lib.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_INTAKE_FIXTURES } from "@regulait/shared";

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
    if (url === "/v1/feedback?scope=queue&status=open") return { status: 200, body: { items: w.items ?? [item("problem", "acknowledged"), item("appeal", "in_review")] } };
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
        "2 open feedback items routed to Ada (acknowledged, in_review; an appeal among them)",
    );
    expect(urls).toEqual(["/v1/incidents?status=active", "/v1/incidents/inc-1", "/v1/feedback?scope=queue&status=open"]);
  });

  it.each([
    ["the incident is missing (closed, or never seeded)", { incidents: [incident({ title: "another incident" })] }, "no open demo incident"],
    ["the incident has no owner", { incidents: [incident({ ownerUserId: null })] }, "has no owner"],
    ["the timeline is too short", { events: 1 }, "1 timeline entry"],
    ["the corrective action is done", { actions: ["done"] }, "no open corrective action"],
    ["one item only", { items: [item("appeal", "in_review")] }, "1 open feedback item(s) routed to Ada (2 needed)"],
    ["the items are routed to someone else", { items: [item("problem", "acknowledged", DANA), item("appeal", "in_review", DANA)] }, "0 open feedback item(s) routed to Ada"],
    ["both in one state", { items: [item("problem", "acknowledged"), item("appeal", "acknowledged")] }, "all acknowledged"],
    ["no appeal", { items: [item("problem", "acknowledged"), item("problem", "in_review")] }, "no open appeal routed to Ada"],
    // PR #461 review M1: an unacknowledged item breaches the acknowledgement SLA and raises a Monitor alert
    ["an item is not acknowledged", { items: [item("problem", "received"), item("appeal", "in_review")] }, "a feedback item routed to Ada is not acknowledged"],
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

/**
 * PR #461 review M1: the deploy gate reads every open alert on its use case, and an open G9 record can raise one (a
 * lapsed feedback SLA, an overdue action). So the G9 records sit on an approved use case that no scripted `demo:gate`
 * run names, and the action falls due after the demo day.
 */
describe("the G9 use case", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const g9 = DEMO_INTAKE_FIXTURES.useCases.find((u) => u.key === DEMO_OPEN_ACCOUNTABILITY_USE_CASE);

  it("is an approved demo use case", () => {
    expect(g9?.targetStatus).toBe("approved");
  });

  it("is not a gate subject anywhere the demo runs `demo:gate`", () => {
    const sources = ["docs/product/DEMO_SCRIPT_2026-11-01.md", "docs/product/DEMO_SCRIPT_2026-10-05.md", "apps/web/e2e/fallback-deck.mjs"];
    const subjects = new Set<string>();
    for (const s of sources) {
      for (const m of read(s).matchAll(/demo:gate --\s+"([^"]+)"/g)) subjects.add(m[1]!);
    }
    // the 11-01 G3 beat names its subject in prose ("... lines for *<use case>*")
    const g3 = read("docs/product/DEMO_SCRIPT_2026-11-01.md").split("### G3.")[1]!.split("\n### ")[0]!;
    for (const m of g3.matchAll(/\*([^*]+)\*/g)) if (DEMO_INTAKE_FIXTURES.useCases.some((u) => u.name === m[1])) subjects.add(m[1]!);
    // non-vacuous: the scripted subject is found
    expect([...subjects]).toContain("Real-Time Fraud Detection Engine");
    expect([...subjects]).not.toContain(g9!.name);
  });

  it("keeps its open action due after the demo day", () => {
    expect(Date.parse(DEMO_OPEN_ACTION_NOT_DUE_BEFORE)).toBeGreaterThan(Date.parse("2026-11-01T23:59:59Z"));
  });
});
