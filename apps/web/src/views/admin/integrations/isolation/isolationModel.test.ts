import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../api/client";
import {
  availabilityOf,
  BACKEND_CLASSES,
  CLASSES,
  draftFrom,
  EDITABLE_KEYS,
  executorReading,
  executorNameOk,
  parseExecutors,
  isWithdrawn,
  nextVersionOf,
  profileActions,
  versionOutcomeText,
  REFUSAL_REASONS,
  registerBody,
  runtimeVersionOk,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_LABEL,
  settingChanges,
  settingRelaxed,
  settingsComplete,
  settingsFromEnvelope,
  type Executor,
  VERSIONABLE_SHIPPED_PROFILES,
} from "./isolationModel";

const now = Date.parse("2026-10-11T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const row = (over: Record<string, unknown> = {}) => ({
  executorId: "8d4b1f8e-0000-4000-8000-000000000001",
  name: "gvisor-a",
  backend: "gvisor",
  classesDeclared: ["hardened_container", "user_space_kernel"],
  status: "active",
  quarantineCode: null,
  runtimeVersion: "runsc release-20260901.0",
  declaredClass: null,
  lastSeenAt: iso(now - 60_000),
  attestations: [{ profileDigest: "a".repeat(64), fresh: true, class: "user_space_kernel", expiresAt: iso(now + 3_600_000), reportSha256: "b".repeat(64) }],
  openOffers: 0,
  attestationStrength: "software_attested",
  ...over,
});
const one = (over: Record<string, unknown> = {}) => parseExecutors({ executors: [row(over)] })![0] as Executor;

describe("parity with the shared isolation contract", () => {
  it("defaults, keys, labels, refusal reasons, classes and backend classes match @regulait/shared", async () => {
    // runtime-only import: the SPA does not depend on @regulait/shared
    const sharedPath = new URL("../../../../../../../packages/shared/src/isolation/index.ts", import.meta.url).pathname;
    const shared = (await import(/* @vite-ignore */ sharedPath)) as {
      ISOLATION_STRICT_DEFAULTS: Record<string, unknown>;
      ISOLATION_SETTING_KEYS: string[];
      ISOLATION_SETTING_COPY: Record<string, { label: string }>;
      ISOLATION_ENFORCEMENT_MODES: readonly string[];
      EXECUTION_REFUSAL_REASONS: readonly string[];
      REQUIRABLE_ISOLATION_CLASSES: readonly string[];
      BACKEND_ATTESTABLE_CLASSES: Record<string, readonly string[]>;
      ISOLATION_SETTING_LIMITS: { executorAttestationMaxAgeMinutes: { min: number; max: number } };
    };
    expect(SETTING_DEFAULTS).toEqual(shared.ISOLATION_STRICT_DEFAULTS);
    expect(SETTING_KEYS).toEqual(shared.ISOLATION_SETTING_KEYS);
    for (const key of SETTING_KEYS) expect(SETTING_LABEL[key]).toBe(shared.ISOLATION_SETTING_COPY[key]!.label);
    // owner decision A: `enforce` is the only value
    expect(shared.ISOLATION_ENFORCEMENT_MODES).toEqual(["enforce"]);
    // owner decision B: six reasons, `policy_unresolved` among them
    expect(REFUSAL_REASONS).toEqual([...shared.EXECUTION_REFUSAL_REASONS]);
    expect(CLASSES).toEqual(shared.REQUIRABLE_ISOLATION_CLASSES);
    expect(BACKEND_CLASSES).toEqual(shared.BACKEND_ATTESTABLE_CLASSES);
    expect(shared.ISOLATION_SETTING_LIMITS.executorAttestationMaxAgeMinutes).toEqual({ min: 60, max: 1440 });
  });
});

describe("settings envelope", () => {
  it.each([undefined, null, false, 0, "", {}, [], "x", { settings: null }, { settings: [] }, { settings: 0 }, { settings: "x" }])(
    "malformed envelope %j is unmeasured, never defaulted",
    (value) => {
      expect(settingsFromEnvelope(value)).toBeNull();
      expect(settingsComplete(settingsFromEnvelope(value))).toBe(false);
    },
  );

  it("an inherited `settings` property is not read", () => {
    expect(settingsFromEnvelope(Object.create({ settings: SETTING_DEFAULTS }))).toBeNull();
  });

  it("a retired `warn`, a missing value or an out-of-range lifetime makes the card unmeasured", () => {
    expect(settingsComplete({ ...SETTING_DEFAULTS })).toBe(true);
    expect(settingsComplete({ ...SETTING_DEFAULTS, isolationEnforcement: "warn" })).toBe(false);
    const { isolationFloorRegulated: _omit, ...missing } = SETTING_DEFAULTS;
    expect(settingsComplete(missing)).toBe(false);
    expect(settingsComplete({ ...SETTING_DEFAULTS, executorAttestationMaxAgeMinutes: 59 })).toBe(false);
    expect(settingsComplete({ ...SETTING_DEFAULTS, isolationFloorPublic: "in_gateway" })).toBe(false);
  });

  it("the draft never offers enforcement as an editable field", () => {
    expect(Object.keys(draftFrom({ ...SETTING_DEFAULTS }))).toEqual(EDITABLE_KEYS);
    expect(EDITABLE_KEYS).not.toContain("isolationEnforcement");
  });
});

describe("settings changes", () => {
  const strict = { ...SETTING_DEFAULTS } as Record<string, unknown>;

  it("sends only the edited field and keeps another administrator's unrelated change", () => {
    const d = draftFrom(strict);
    d.isolationFloorPublic = "hardened_container";
    expect(settingChanges(strict, d, { ...strict, executorAttestationMaxAgeMinutes: 60 })).toEqual({
      body: { isolationFloorPublic: "hardened_container" },
      relaxed: ["Isolation floor: public projects: L1 · Hardened container"],
    });
  });

  it("lowering a raised floor back to the default is still a relaxation of what is stored", () => {
    const loaded = { ...strict, isolationFloorPublic: "microvm" };
    const d = draftFrom(loaded);
    d.isolationFloorPublic = "user_space_kernel";
    expect(settingChanges(loaded, d, loaded)).toEqual({
      body: { isolationFloorPublic: "user_space_kernel" },
      relaxed: ["Isolation floor: public projects: L2 · User-space kernel sandbox"],
    });
  });

  it("tightening needs no confirmation", () => {
    const d = draftFrom(strict);
    d.isolationFloorRegulated = "microvm";
    d.executorAttestationMaxAgeMinutes = "60";
    expect(settingChanges(strict, d, strict)).toEqual({ body: { executorAttestationMaxAgeMinutes: 60 }, relaxed: [] });
  });

  it("a value already stored is not sent again", () => {
    const d = draftFrom(strict);
    d.isolationFloorMcpStdio = "hardened_container";
    expect(settingChanges(strict, d, { ...strict, isolationFloorMcpStdio: "hardened_container" })).toEqual({ body: {}, relaxed: [] });
  });

  it.each(["59", "1441", "60.5", "NaN", "Infinity", "-1", "", " ", "1e3", "00120"])("refuses lifetime %j", (value) => {
    const d = draftFrom(strict);
    d.executorAttestationMaxAgeMinutes = value;
    const out = settingChanges(strict, d, strict);
    if (value === "00120") expect(out).toEqual({ body: {}, relaxed: [] });
    else expect(out).toHaveProperty("error");
  });

  it("an unknown class is refused rather than sent", () => {
    const d = draftFrom(strict);
    d.isolationFloorPublic = "in_gateway";
    expect(settingChanges(strict, d, strict)).toHaveProperty("error");
  });

  it("an unreadable base is judged conservatively", () => {
    expect(settingRelaxed("isolationFloorPublic", "microvm", undefined)).toBe(true);
    expect(settingRelaxed("executorAttestationMaxAgeMinutes", 60, "120")).toBe(true);
  });
});

describe("route availability", () => {
  it("501 is not built; 403 is forbidden; anything else is a failure", () => {
    expect(availabilityOf(new ApiError(501, { error: "not_built" }))).toEqual({ kind: "not_built" });
    expect(availabilityOf(new ApiError(403, { error: "forbidden" }))).toEqual({ kind: "forbidden" });
    expect(availabilityOf(new Error("offline")).kind).toBe("failed");
  });
});

describe("executors from GET /v1/executors", () => {
  it.each([undefined, null, {}, [], { executors: null }, { executors: {} }])("malformed envelope %j is unreadable", (value) => {
    expect(parseExecutors(value)).toBeNull();
  });

  it("a malformed row is kept as unreadable, never dropped", () => {
    const out = parseExecutors({ executors: [row(), { executorId: "x" }, row({ backend: "constructor" }), row({ status: "maybe" })] })!;
    expect(out.map((r) => ("unreadable" in r ? "unreadable" : r.name))).toEqual(["gvisor-a", "unreadable", "unreadable", "unreadable"]);
  });

  it("a fresh attestation without a class or expiry is unreadable", () => {
    expect("unreadable" in parseExecutors({ executors: [row({ attestations: [{ profileDigest: "a".repeat(64), fresh: true }] })] })![0]!).toBe(true);
    expect("unreadable" in parseExecutors({ executors: [row({ attestations: [{ profileDigest: "a".repeat(64), fresh: true, class: "user_space_kernel", expiresAt: "soon" }] })] })![0]!).toBe(true);
  });

  it("a fresh gateway verdict reads as a software-attested fresh report", () => {
    const r = executorReading(one(), now);
    expect(r).toMatchObject({ state: "Fresh report", tone: "ok" });
    expect(r.detail).toContain("Software-attested L2 · User-space kernel sandbox");
  });

  it("the device clock can only take assurance away: a fresh report past its expiry reads stale", () => {
    const e = one();
    expect(executorReading(e, e.attestations[0]!.expiresAt! - 1).state).toBe("Fresh report");
    expect(executorReading(e, e.attestations[0]!.expiresAt!)).toMatchObject({ state: "Stale", tone: "warn" });
  });

  it("no fresh attestation is never green", () => {
    expect(executorReading(one({ attestations: [] }), now)).toMatchObject({ state: "No fresh report", tone: "neutral" });
    expect(executorReading(one({ attestations: [{ profileDigest: "a".repeat(64), fresh: false }] }), now).tone).toBe("neutral");
  });

  it("a class the backend cannot attest is not counted (OpenShell never attests L2): no fresh report, not stale", () => {
    const e = one({ backend: "openshell", attestations: [{ profileDigest: "a".repeat(64), fresh: true, class: "user_space_kernel", expiresAt: iso(now + 60_000) }] });
    expect(executorReading(e, now)).toMatchObject({ state: "No fresh report", tone: "neutral" });
    // also after its expiry: it never was evidence, so it never reads as an expired pass
    expect(executorReading(e, now + 120_000)).toMatchObject({ state: "No fresh report", tone: "neutral" });
    // a runc executor reporting L3 is likewise no report
    const runc = one({ backend: "runc", attestations: [{ profileDigest: "a".repeat(64), fresh: true, class: "microvm", expiresAt: iso(now + 60_000) }] });
    expect(executorReading(runc, now).state).toBe("No fresh report");
  });

  it("quarantined and revoked executors are refused whatever their reports say", () => {
    expect(executorReading(one({ status: "quarantined", quarantineCode: "execution_profile_mismatch" }), now)).toMatchObject({ state: "Quarantined", tone: "danger" });
    expect(executorReading(one({ status: "quarantined", quarantineCode: "execution_profile_mismatch" }), now).detail).toContain("disagreed");
    expect(executorReading(one({ status: "revoked" }), now)).toMatchObject({ state: "Revoked", tone: "danger" });
  });

  it("a customer plane is declared, never verified, and unmapped satisfies nothing", () => {
    const att = [{ profileDigest: "a".repeat(64), fresh: true, class: "customer_declared", expiresAt: iso(now + 60_000) }];
    const unmapped = executorReading(one({ backend: "customer", classesDeclared: ["customer_declared"], attestations: att }), now);
    expect(unmapped).toMatchObject({ state: "Customer declared", tone: "warn" });
    expect(unmapped.detail).toContain("satisfies no requirement");
    const mapped = executorReading(one({ backend: "customer", classesDeclared: ["customer_declared"], declaredClass: "microvm", attestations: att }), now);
    expect(mapped.tone).toBe("warn");
    expect(mapped.detail).toContain("declared, not verified");
  });
});

describe("registering an executor", () => {
  const ok = { workloadIdentityId: "8d4b1f8e-0000-4000-8000-000000000009", name: "gvisor-a", backend: "gvisor" as const, runtimeVersion: "release-20260901.0", classesDeclared: ["user_space_kernel"] };

  it("a complete draft becomes the strict body the gateway expects", () => {
    expect(registerBody(ok)).toEqual({ body: ok });
    expect(registerBody({ ...ok, classesDeclared: ["user_space_kernel", "user_space_kernel"] })).toEqual({ body: ok });
  });

  it.each([
    ["no identity", { workloadIdentityId: "" }],
    ["no backend", { backend: "" as const }],
    ["no class", { classesDeclared: [] }],
    ["a class the backend cannot attest (OpenShell never L2)", { backend: "openshell" as const, classesDeclared: ["user_space_kernel"] }],
    ["a customer plane claiming a verified class", { backend: "customer" as const, classesDeclared: ["microvm"] }],
  ])("refuses %s", (_label, over) => {
    expect(registerBody({ ...ok, ...over })).toHaveProperty("error");
  });

  it.each(["a", "A-b", "1abc", "ab_c", "ab c", "a".repeat(64), "ab\u00e9"])("refuses the name %j", (name) => {
    expect(executorNameOk(name)).toBe(false);
  });

  it("accepts names and versions the gateway accepts", () => {
    expect(executorNameOk("ab")).toBe(true);
    expect(executorNameOk("a".repeat(63))).toBe(true);
    expect(runtimeVersionOk("runsc_release-2026.09+1")).toBe(true);
    expect(runtimeVersionOk("")).toBe(false);
    expect(runtimeVersionOk("v 1")).toBe(false);
    expect(runtimeVersionOk("x".repeat(129))).toBe(false);
  });

  it("the identity id must be a UUID", () => {
    expect(registerBody({ ...ok, workloadIdentityId: "not-a-uuid" })).toHaveProperty("error");
    expect(registerBody({ ...ok, workloadIdentityId: "8d4b1f8e00000-4000-8000-000000000009" })).toHaveProperty("error");
    expect(registerBody({ ...ok, workloadIdentityId: "8D4B1F8E-0000-4000-8000-00000000000F" })).toHaveProperty("body");
  });
});

/** the shared source, imported in the test only (the SPA mirrors it at runtime) */
const sharedIsolation = async (): Promise<{ VERSIONABLE_SHIPPED_EXECUTION_PROFILES: readonly string[] }> => import(/* @vite-ignore */ new URL("../../../../../../../packages/shared/src/isolation/index.ts", import.meta.url).pathname);

describe("ADR-0190 I5 follow-up: engine-worker is versioned, never retired; the strict references are neither", () => {
  it("mirrors the shared list of versionable shipped profiles", async () => {
    expect([...VERSIONABLE_SHIPPED_PROFILES]).toEqual([...(await sharedIsolation()).VERSIONABLE_SHIPPED_EXECUTION_PROFILES]);
  });
  it("offers a new version of engine-worker (shipped v1 and admin versions), never its retirement; nothing on restricted", () => {
    expect(profileActions({ name: "engine-worker", shipped: true })).toEqual({ version: true, retire: false });
    expect(profileActions({ name: "engine-worker", shipped: false })).toEqual({ version: true, retire: false });
    expect(profileActions({ name: "restricted", shipped: true })).toEqual({ version: false, retire: false });
    expect(profileActions({ name: "restricted-microvm", shipped: true })).toEqual({ version: false, retire: false });
    expect(profileActions({ name: "team-profile", shipped: false })).toEqual({ version: true, retire: true });
  });
});

describe("review of #397: version numbers, withdrawn rows and the revert toast", () => {
  const live = { name: "engine-worker", version: 1, retiredAt: null };
  const withdrawn = { name: "engine-worker", version: 2, retiredAt: 1 };
  const retired = { name: "team-old", version: 1, retiredAt: 1 };
  const rows = [live, withdrawn, retired, { unreadable: true as const, index: 3 }];
  it("a new version is numbered after the NEWEST version, withdrawn ones included", () => {
    expect(nextVersionOf("engine-worker", rows)).toBe(3);
    expect(nextVersionOf("team-new", rows)).toBe(1);
  });
  it("a retired row beside a live sibling is withdrawn; a profile with none live is retired", () => {
    expect(isWithdrawn(withdrawn, rows)).toBe(true);
    expect(isWithdrawn(live, rows)).toBe(false);
    expect(isWithdrawn(retired, rows)).toBe(false);
  });
  it("says reverted when the route reverted, versioned otherwise", () => {
    expect(versionOutcomeText("engine-worker", { version: 1, revertedFrom: { version: 2 } })).toBe("Execution profile engine-worker reverted to v1");
    expect(versionOutcomeText("engine-worker", { version: 3 })).toBe("Execution profile engine-worker versioned as v3");
    expect(versionOutcomeText("x", null)).toBe("Execution profile x versioned");
  });
});
