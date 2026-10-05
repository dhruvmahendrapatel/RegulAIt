/**
 * ADR-0080 amendment (batch B6b) — THE ATTRIBUTION MANDATE, proved by attack
 * in exactly the shape `use-case-gate.test.ts` (B3a) and `mrm.test.ts`
 * (ADR-0045) use, because it is the same rung of the same gate anatomy.
 *
 * B3a recorded the hole it could not close from inside itself: *"nothing
 * mandates that a dispatch be attributed to a linked project at all —
 * attribution stays the pillar-5 opt-in, so the gate cannot see a call naming
 * no project."* This file pins the knob that closes it, and pins the
 * composition of the two knobs so nobody has to guess at a precedence rule:
 *
 *  1. SHIPS ON (ADR-0181); RELAXED OFF IS BYTE-IDENTICAL. With
 *     `dispatchAttributionRequired` relaxed by an admin, the EXACT projectless
 *     dispatch that refuses when it is on succeeds, reaches the provider, and
 *     writes ZERO rows under the gate's ruleId (a delta, M-008).
 *  2. ON REFUSES PRE-PROVIDER. 409 `attribution_required` with a recording
 *     provider spy at ZERO calls for that attempt, and one audited deny.
 *  3. ON + ATTRIBUTED PASSES. The mandate only ever looks at calls naming NO
 *     project, so an attributed dispatch is untouched by it.
 *  4. THE FOUR COMBINATIONS. Both knobs, all four states, both kinds of
 *     dispatch (projectless / attributed-to-a-use-case-linked-project) —
 *     which is the proof that they are independent rather than ordered. The
 *     off/enforce cell is the B3a hole itself, still demonstrable and now
 *     closable by the OTHER knob rather than by this one.
 *
 * SHARED-STATE DISCIPLINE (M-012): this file flips TWO fields of the
 * `org_settings` singleton (`dispatchAttributionRequired`, `useCaseGateMode`);
 * `afterAll` restores the exact pre-existing values of both. Everything here
 * is prefixed atg-, and every audit assertion is a DELTA (M-008).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, count, createDb, eq, orgSettings, runMigrations, type Db } from "@regulait/db";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

declare global {
  // eslint-disable-next-line no-var
  var __atgProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__atgProviderCalls = [];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        globalThis.__atgProviderCalls.push({ model: req.model, input: req.input ?? "" });
        return inner.dispatch(req);
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "atg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);

const GATE_RULE = "attribution-required";

let db: Db;
let app: ReturnType<typeof buildApp>;
let danaId: string;
let danaAuth: { authorization: string };
let agentId: string;
let linkedProjectId: string;
let priorAttribution: boolean | null = null;
let priorGateMode: string | null = null;

function resetProviderCalls() {
  globalThis.__atgProviderCalls = [];
}

async function setKnobs(knobs: {
  attribution?: boolean;
  useCaseGateMode?: "off" | "warn" | "enforce";
}) {
  const payload: Record<string, unknown> = {};
  if (knobs.attribution !== undefined) payload.dispatchAttributionRequired = knobs.attribution;
  if (knobs.useCaseGateMode !== undefined) payload.useCaseGateMode = knobs.useCaseGateMode;
  const res = await app.inject({
    method: "PUT",
    url: "/v1/org/settings",
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(200);
  if (knobs.attribution !== undefined) {
    expect(res.json().settings.dispatchAttributionRequired).toBe(knobs.attribution);
  }
  if (knobs.useCaseGateMode !== undefined) {
    expect(res.json().settings.useCaseGateMode).toBe(knobs.useCaseGateMode);
  }
}

/** the SAME dispatch throughout — only the presence of `projectId` differs */
async function invoke(projectId: string | null) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: danaAuth,
    payload: {
      mode: "execute",
      input: "atg probe",
      dispatch: true,
      ...(projectId ? { projectId } : {}),
    },
  });
}

async function auditCount(ruleId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return row?.n ?? 0;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false });

  const [org] = await db.select().from(orgSettings);
  priorAttribution = org?.dispatchAttributionRequired ?? null;
  priorGateMode = org?.useCaseGateMode ?? null;

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: "atg-dana@example.com", displayName: "atg dana" },
  });
  expect(u.statusCode).toBe(201);
  danaId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${danaId}/keys`,
    headers: AUTH,
    payload: { name: "atg" },
  });
  danaAuth = { authorization: `Bearer ${k.json().token}` };

  // ONE agent for the ONE invoking user, so "which agent was served" is never
  // a variable in these assertions (the use-case-gate.test.ts discipline)
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: "atg-subject",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: danaId, agentId },
  });

  const p = await app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: AUTH,
    payload: { name: "atg-linked-project" },
  });
  expect(p.statusCode).toBe(201);
  linkedProjectId = p.json().id;

  // a REAL use case through the front door, naming the project and resting
  // UNAPPROVED at the plan stage — the state B3a's gate is about, so the
  // four-combination matrix below exercises a use-case gate that can fire
  const uc = await app.inject({
    method: "POST",
    url: "/v1/use-cases",
    headers: danaAuth,
    payload: {
      name: "atg-ticket-summaries",
      description: "summarize inbound support tickets",
      businessContext: "cut first-response time",
      dataSensitivity: "internal",
      projectId: linkedProjectId,
    },
  });
  expect(uc.statusCode).toBe(201);
  resetProviderCalls();
});

afterAll(async () => {
  // M-012: restore BOTH singleton fields exactly — a leaked mandate would 409
  // every later suite's unattributed dispatch
  await db
    .update(orgSettings)
    .set({
      dispatchAttributionRequired: priorAttribution ?? true,
      useCaseGateMode: (priorGateMode ?? "enforce") as "off" | "warn" | "enforce",
    })
    .where(eq(orgSettings.id, "singleton"));
  await restoreSb2Gates();
  await app.close();
  await db.$client.end();
});

describe("ships on (ADR-0181); relaxed off — byte-identical", () => {
  it("ships on: the settings read reports dispatchAttributionRequired true", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.dispatchAttributionRequired).toBe(true);
  });

  it("relaxed off, the projectless dispatch that refuses when ON passes untouched: 200, provider called, ZERO gate audit rows", async () => {
    await setKnobs({ attribution: false });
    const before = await auditCount(GATE_RULE);
    resetProviderCalls();

    const res = await invoke(null);
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText.length).toBeGreaterThan(0);
    // it really reached a provider — the control that makes "passes" mean
    // something (M-002)
    expect(globalThis.__atgProviderCalls.length).toBe(1);

    // …and the knob-off path did not even write the refusal-shaped fact
    expect(await auditCount(GATE_RULE)).toBe(before);
  });
});

describe("on — refused BEFORE any provider work", () => {
  it("409 attribution_required, provider spy at zero calls, one audited deny", async () => {
    await setKnobs({ attribution: true });
    const before = await auditCount(GATE_RULE);
    resetProviderCalls();

    const res = await invoke(null);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("attribution_required");
    expect(res.json().detail).toContain("dispatchAttributionRequired");

    // THE PRE-PROVIDER CLAIM, measured rather than asserted: nothing was sent
    expect(globalThis.__atgProviderCalls.length).toBe(0);

    // exactly one new deny row, naming the gate
    expect(await auditCount(GATE_RULE)).toBe(before + 1);
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, GATE_RULE));
    const mine = rows.filter((r) => r.userId === danaId);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1)!.effect).toBe("deny");
    expect((mine.at(-1)!.detail as { projectId?: string | null }).projectId).toBeNull();
  });

  it("the SAME dispatch, attributed, passes — the mandate only looks at calls naming no project", async () => {
    // the linked project's use case is unapproved: relax the OTHER knob (ADR-0181
    // ships it enforce) so this test is about the mandate alone
    await setKnobs({ useCaseGateMode: "off" });
    const before = await auditCount(GATE_RULE);
    resetProviderCalls();

    const res = await invoke(linkedProjectId);
    expect(res.statusCode).toBe(200);
    expect(globalThis.__atgProviderCalls.length).toBe(1);
    // an attributed dispatch never reaches the mandate at all
    expect(await auditCount(GATE_RULE)).toBe(before);

    await setKnobs({ attribution: false });
  });
});

describe("the two knobs are INDEPENDENT — all four combinations", () => {
  /** run both kinds of dispatch under one knob combination */
  async function probe(attribution: boolean, useCaseGateMode: "off" | "enforce") {
    await setKnobs({ attribution, useCaseGateMode });
    resetProviderCalls();
    const projectless = await invoke(null);
    const attributed = await invoke(linkedProjectId);
    return {
      projectless: { status: projectless.statusCode, error: projectless.json().error ?? null },
      attributed: { status: attributed.statusCode, error: attributed.json().error ?? null },
      providerCalls: globalThis.__atgProviderCalls.length,
    };
  }

  it("off / off — nothing is gated", async () => {
    const r = await probe(false, "off");
    expect(r.projectless).toEqual({ status: 200, error: null });
    expect(r.attributed).toEqual({ status: 200, error: null });
    expect(r.providerCalls).toBe(2);
  });

  it("off / enforce — THE B3a HOLE: the attributed call is gated, the projectless one walks past", async () => {
    const r = await probe(false, "enforce");
    // the hole this amendment exists to close, still demonstrable
    expect(r.projectless).toEqual({ status: 200, error: null });
    expect(r.attributed).toEqual({ status: 409, error: "use_case_approval_required" });
    // only the projectless one reached a provider
    expect(r.providerCalls).toBe(1);
  });

  it("on / off — the mandate alone: the projectless call is refused, the attributed one runs", async () => {
    const r = await probe(true, "off");
    expect(r.projectless).toEqual({ status: 409, error: "attribution_required" });
    expect(r.attributed).toEqual({ status: 200, error: null });
    expect(r.providerCalls).toBe(1);
  });

  it("on / enforce — both are refused, each BY ITS OWN NAME (no precedence to remember)", async () => {
    const r = await probe(true, "enforce");
    expect(r.projectless).toEqual({ status: 409, error: "attribution_required" });
    expect(r.attributed).toEqual({ status: 409, error: "use_case_approval_required" });
    expect(r.providerCalls).toBe(0);

    await setKnobs({ attribution: false, useCaseGateMode: "off" });
  });
});
