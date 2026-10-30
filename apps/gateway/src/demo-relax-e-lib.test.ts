/**
 * Beat E's demo-data relaxation (demo-relax-e-lib.ts), against a stubbed gateway. Pure: no database. The real gateway
 * path (step-up, audit row, then the beat queueing and executing) is in demo-relax-e-enforce.test.ts.
 */
import { describe, expect, it } from "vitest";
import { STEP_UP_HEADER } from "@regulait/shared";
import {
  DEMO_E_RELAXATIONS,
  ENFORCE_BEAT,
  ORG_SETTINGS_PATH,
  applyDemoERelaxation,
  checkEnforceBeatPrereqs,
  pendingDemoERelaxations,
  type GatewayCall,
} from "./demo-relax-e-lib.js";
import { DEMO_PERSONA_EMAILS } from "./demo-set-passwords-lib.js";

type Json = Record<string, any>;
const STRICT = { toolApprovalSensitiveQuorum: 2, approvalSignatureMode: "passkey" };
const personas = DEMO_PERSONA_EMAILS.map((email) => ({ email }));

/** a stub gateway: GETs served from state, PUTs answered by `onPut`; every call recorded */
function gateway(opts: { settings?: Json; beatsStatus?: number; users?: Json[]; onPut?: (headers: Record<string, string>, body: Json) => { status: number; body: Json } } = {}) {
  const settings: Json = { ...STRICT, ...opts.settings };
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const call: GatewayCall = async (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    if (method === "GET" && url === "/v1/demo/beats") return { status: opts.beatsStatus ?? 200, body: { beats: [{ beatId: "enforce-it", mode: "live" }] } };
    if (method === "GET" && url === "/v1/users") return { status: 200, body: { users: opts.users ?? personas } };
    if (method === "GET" && url === ORG_SETTINGS_PATH) return { status: 200, body: { settings } };
    if (method === "PUT" && url === ORG_SETTINGS_PATH) {
      const r = opts.onPut ? opts.onPut(headers, body as Json) : { status: 200, body: {} };
      if (r.status === 200) Object.assign(settings, body);
      return r.status === 200 ? { status: 200, body: { settings } } : r;
    }
    return { status: 404, body: {} };
  };
  return { call, calls, settings, puts: () => calls.filter((c) => c.method === "PUT") };
}
const BOOT = { authorization: "Bearer boot" };
const bootstrapRefusal = { status: 403, body: { error: "step_up_required", actionKind: "settings_relax", credential: "bootstrap", methods: [] } };

describe("pendingDemoERelaxations", () => {
  it("names only the keys that differ", () => {
    expect(pendingDemoERelaxations(STRICT)).toEqual(DEMO_E_RELAXATIONS);
    expect(pendingDemoERelaxations({ ...STRICT, approvalSignatureMode: "off" })).toEqual({ toolApprovalSensitiveQuorum: 1 });
    expect(pendingDemoERelaxations({ ...DEMO_E_RELAXATIONS })).toEqual({});
  });
});

describe("applyDemoERelaxation", () => {
  it("relaxes both settings through PUT /v1/org/settings, sending only what differs", async () => {
    const g = gateway({ settings: { approvalSignatureMode: "step_up" } });
    const r = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(r.status).toBe("relaxed");
    expect(g.puts()).toHaveLength(1);
    expect(g.puts()[0]!.body).toEqual(DEMO_E_RELAXATIONS);
    expect(r.lines.join("\n")).toContain("org-settings-updated");
  });

  it("is idempotent: a second run writes nothing", async () => {
    const g = gateway();
    expect((await applyDemoERelaxation(g.call, { headers: BOOT })).status).toBe("relaxed");
    const again = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(again.status).toBe("already");
    expect(g.puts()).toHaveLength(1);
  });

  it("refuses a gateway without the demo beats route, and writes nothing", async () => {
    const g = gateway({ beatsStatus: 404 });
    const r = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(r.status).toBe("refused");
    expect(g.puts()).toHaveLength(0);
    expect(g.calls.some((c) => c.url === ORG_SETTINGS_PATH)).toBe(false);
  });

  it("refuses a gateway without the demo personas, and writes nothing", async () => {
    const g = gateway({ users: [{ email: "someone@example.com" }] });
    const r = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(r.status).toBe("refused");
    expect(r.lines[0]).toContain("demo seed's personas");
    expect(g.puts()).toHaveLength(0);
  });

  it("refuses when the beats route cannot be read (not a 200 or a 404)", async () => {
    const g = gateway({ beatsStatus: 403 });
    expect((await applyDemoERelaxation(g.call, { headers: BOOT })).status).toBe("refused");
    expect(g.puts()).toHaveLength(0);
  });

  it("the bootstrap credential's step-up refusal is reported as needs_admin, never retried, nothing changed", async () => {
    const g = gateway({ onPut: () => bootstrapRefusal });
    const r = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(r.status).toBe("needs_admin");
    expect(r.lines.join("\n")).toContain("demo:relax-e");
    expect(g.puts()).toHaveLength(1);
    expect(g.settings).toMatchObject(STRICT);
  });

  it("an admin session: the step-up is asked for with the 403's action, and the retry carries its token", async () => {
    const action = { kind: "settings_relax", body: { values: DEMO_E_RELAXATIONS } };
    const g = gateway({
      onPut: (headers) =>
        headers[STEP_UP_HEADER] === "rgsu_ok" ? { status: 200, body: {} } : { status: 403, body: { error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action } },
    });
    const seen: Json[] = [];
    const r = await applyDemoERelaxation(g.call, { headers: { cookie: "regulait_session=x" }, stepUp: async (a) => (seen.push(a), "rgsu_ok") });
    expect(r.status).toBe("relaxed");
    expect(seen).toEqual([action]);
    expect(g.puts().map((p) => p.headers[STEP_UP_HEADER])).toEqual([undefined, "rgsu_ok"]);
  });

  it("an abandoned step-up changes nothing", async () => {
    const g = gateway({ onPut: () => ({ status: 403, body: { error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action: {} } }) });
    const r = await applyDemoERelaxation(g.call, { headers: { cookie: "x" }, stepUp: async () => null });
    expect(r.status).toBe("failed");
    expect(g.puts()).toHaveLength(1);
    expect(g.settings).toMatchObject(STRICT);
  });

  it("any other refusal fails with its status", async () => {
    const g = gateway({ onPut: () => ({ status: 400, body: { error: "invalid" } }) });
    const r = await applyDemoERelaxation(g.call, { headers: BOOT });
    expect(r.status).toBe("failed");
    expect(r.lines[0]).toContain("400 invalid");
  });
});

describe("checkEnforceBeatPrereqs (demo:check row)", () => {
  const getter = (settings: Json, mode = "live") => async (url: string) =>
    url === "/v1/demo/beats"
      ? { status: 200, body: { beats: [{ beatId: "enforce-it", mode }] } }
      : url === ORG_SETTINGS_PATH
        ? { status: 200, body: { settings } }
        : { status: 404, body: {} };

  it("PASS once relaxed", async () => {
    const [row] = await checkEnforceBeatPrereqs(getter({ ...DEMO_E_RELAXATIONS }));
    expect(row).toMatchObject({ beat: ENFORCE_BEAT, level: "PASS" });
  });

  it("FAIL under the strict defaults while the beat is live, naming both causes and the fix", async () => {
    const [row] = await checkEnforceBeatPrereqs(getter(STRICT));
    expect(row!.level).toBe("FAIL");
    expect(row!.detail).toContain("quorum is 2");
    expect(row!.detail).toContain("passkey");
    expect(row!.fix).toContain("demo:relax-e");
  });

  it("FAIL when only one is relaxed", async () => {
    const [row] = await checkEnforceBeatPrereqs(getter({ toolApprovalSensitiveQuorum: 1, approvalSignatureMode: "passkey" }));
    expect(row!.level).toBe("FAIL");
    expect(row!.detail).not.toContain("quorum is");
  });

  it("WARN, not FAIL, while the beat is on its simulated fallback (nothing queues)", async () => {
    const [row] = await checkEnforceBeatPrereqs(getter(STRICT, "simulated"));
    expect(row!.level).toBe("WARN");
  });

  it("FAIL when the settings cannot be read", async () => {
    const [row] = await checkEnforceBeatPrereqs(async () => ({ status: 500, body: {} }));
    expect(row!.level).toBe("FAIL");
  });
});
