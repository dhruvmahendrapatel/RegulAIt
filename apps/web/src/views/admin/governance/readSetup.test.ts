import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { fetchReadSetup, setOrgTokensSwitch, setSourceKey, targetWith } from "./readSetupApi";
import { ACTIVITY_COPY, ACTIVITY_STATES, normaliseReadSetup, readSetupReducer, safeConsentUrl, type Flow } from "./readSetupModel";
import type { DiscoverySourceView } from "./discoverySourcesModel";

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SID = "11111111-1111-4111-8111-111111111111";
const CONSENT = "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/adminconsent?client_id=33333333-3333-4333-8333-333333333333";
const m365 = (over: Record<string, unknown> = {}) => ({
  sourceId: SID,
  platform: "m365",
  activityLogs: {
    requested: false,
    state: "off",
    permission: "AuditLog.Read.All",
    permissionType: "application",
    license: "Microsoft Entra ID P1 or P2",
    steps: [{ id: "grant-consent", title: "Grant admin consent", detail: "Open the consent page." }],
    consentUrl: CONSENT,
    ...over,
  },
  lastRead: null,
});
const source: DiscoverySourceView = {
  id: SID,
  name: "Tenant",
  kind: "entitlement_m365",
  target: { tenantId: "t", activityLogs: "off" },
  scope: { orgLevel: true, include: [] } as unknown as DiscoverySourceView["scope"],
  enabled: true,
  scheduleIntervalSeconds: 3600,
  version: 4,
  nextRunAt: null,
  lastRunAt: null,
  scannerBuilt: true,
  credential: null,
  lastRun: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("normaliseReadSetup", () => {
  it("reads the Microsoft 365 setup, off by default", () => {
    const out = normaliseReadSetup(m365());
    expect(out.platform).toBe("m365");
    if (out.platform !== "m365") return;
    expect(out.activityLogs).toMatchObject({ requested: false, state: "off", consentUrl: CONSENT });
    expect(out.lastRead).toBeNull();
  });

  it("reads the Salesforce view", () => {
    const out = normaliseReadSetup({ sourceId: SID, platform: "salesforce", orgTokens: { requested: false, allowed: false, permission: "Customize Application", tradeOff: "wider" }, sees: ["a"], cannotSee: ["b", "c"], lastRead: { coverage: "app", note: "ok", recordedAt: "2026-11-22T00:00:00Z", runId: "r" } });
    expect(out.platform === "salesforce" && out.cannotSee).toEqual(["b", "c"]);
    expect(out.lastRead).toEqual({ coverage: "app", note: "ok", recordedAt: "2026-11-22T00:00:00Z" });
  });

  it("a malformed answer is a failed read", () => {
    expect(() => normaliseReadSetup(m365({ state: "connected" }))).toThrow(/state/);
    expect(() => normaliseReadSetup({ sourceId: SID, platform: "okta" })).toThrow(/platform/);
    expect(() => normaliseReadSetup({ sourceId: SID, platform: "salesforce", orgTokens: { requested: "no" } })).toThrow();
  });

  it("drops a consent link that is not on Microsoft's sign-in host", () => {
    expect(safeConsentUrl(CONSENT)).toBe(CONSENT);
    expect(safeConsentUrl("https://login.microsoftonline.com.evil.test/x")).toBeNull();
    expect(safeConsentUrl("http://login.microsoftonline.com/x")).toBeNull();
    expect(safeConsentUrl("javascript:alert(1)")).toBeNull();
    const out = normaliseReadSetup(m365({ consentUrl: "https://example.test/adminconsent" }));
    expect(out.platform === "m365" && out.activityLogs.consentUrl).toBeNull();
  });

  it("only flowing reads as connected", () => {
    for (const s of ACTIVITY_STATES) expect(ACTIVITY_COPY[s].label === "Connected").toBe(s === "flowing");
  });
});

describe("readSetupReducer", () => {
  const idle: Flow = { phase: "idle" };
  const change = { kind: "orgSwitch", on: true } as const;

  it("asks, submits, steps up and finishes; one change at a time", () => {
    const c = readSetupReducer(idle, { type: "ask", change });
    expect(c).toEqual({ phase: "confirming", change });
    const s = readSetupReducer(c, { type: "submit" });
    expect(s.phase).toBe("submitting");
    expect(readSetupReducer(s, { type: "ask", change: { kind: "activityLogs", on: true } })).toBe(s);
    expect(readSetupReducer(s, { type: "dismiss" })).toBe(s);
    const st = readSetupReducer(s, { type: "stepUpRequested" });
    expect(st.phase).toBe("stepping");
    expect(readSetupReducer(st, { type: "succeeded" })).toEqual({ phase: "done", change });
    expect(readSetupReducer(idle, { type: "succeeded" })).toBe(idle);
  });

  it("a declined step-up is told apart from a failure, and both can be tried again", () => {
    const s: Flow = { phase: "stepping", change };
    const refusal = new ApiError(403, { error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action: { kind: "settings_relax", body: {} } } as never);
    expect(readSetupReducer(s, { type: "failed", error: refusal, message: "x" })).toEqual({ phase: "declined", change });
    const failed = readSetupReducer(s, { type: "failed", error: new Error("boom"), message: "boom" });
    expect(failed).toEqual({ phase: "failed", change, message: "boom" });
    expect(readSetupReducer(failed, { type: "submit" }).phase).toBe("submitting");
    expect(readSetupReducer(failed, { type: "cancel" })).toEqual(idle);
  });
});

describe("the calls", () => {
  it("reads the setup, and a 404 is an ApiError", async () => {
    const fetchMock = vi.fn(async () => res(m365()));
    vi.stubGlobal("fetch", fetchMock);
    await fetchReadSetup(SID);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`/v1/discovery/entitlements/sources/${SID}/read-setup`);
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "not_found" }, 404)));
    await expect(fetchReadSetup(SID)).rejects.toBeInstanceOf(ApiError);
  });

  it("changes one target key and keeps the rest", async () => {
    expect(targetWith(source, "activityLogs", true)).toEqual({ tenantId: "t", activityLogs: "on" });
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => res({}));
    vi.stubGlobal("fetch", fetchMock);
    await setSourceKey(source, "activityLogs", true, () => undefined);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/v1/discovery/sources/${SID}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ version: 4, target: { tenantId: "t", activityLogs: "on" } });
  });

  it("sends only the version and the switch to the settings", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => res({}));
    vi.stubGlobal("fetch", fetchMock);
    await setOrgTokensSwitch({ version: 7, credentialWarningAgeDays: 90, endpointRetentionDays: 30 }, true, () => undefined);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/v1/discovery/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ version: 7, salesforceOrgTokens: true });
  });
});
