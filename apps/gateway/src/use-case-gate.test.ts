/**
 * ADR-0080 amendment (batch B3) — THE USE-CASE DISPATCH GATE, proved by
 * attack, the mrm.test.ts way (the ADR-0045 gate shape this deliberately
 * copies):
 *
 *  1. DEFAULT-OFF IS BYTE-IDENTICAL. With `useCaseGateMode` untouched, the
 *     exact dispatch that refuses under enforce succeeds, reaches the
 *     provider, carries NO `useCaseGate` annotation, and writes ZERO rows
 *     under either gate ruleId (deltas, M-008).
 *  2. WARN RECORDS, NEVER BLOCKS. The dispatch proceeds (provider called),
 *     the refusal-shaped fact rides the result as `dispatch.useCaseGate`,
 *     and one `use-case-gate-warned` allow row lands on the trail.
 *  3. ENFORCE REFUSES PRE-PROVIDER. 409 `use_case_approval_required` with a
 *     recording provider spy at ZERO calls, audited deny — and an APPROVAL
 *     through the one decide path flips the same dispatch live.
 *  4. THE JOIN IS HONEST. A project no use case links is untouched in every
 *     mode — the gate applies only where `ai_use_cases.projectId` exists.
 *  5. RETIREMENT TAKES THE APPROVAL BACK OUT. A retired use case does not
 *     satisfy the gate.
 *
 * SHARED-STATE DISCIPLINE (M-012): this file flips the `org_settings`
 * singleton's `useCaseGateMode`; `afterAll` restores the exact pre-existing
 * value. Everything here is prefixed ucg-.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, count, createDb, eq, orgSettings, runMigrations, type Db } from "@regulait/db";

declare global {
  // eslint-disable-next-line no-var
  var __ucgProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__ucgProviderCalls = [];

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
        globalThis.__ucgProviderCalls.push({ model: req.model, input: req.input ?? "" });
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

const BOOT = "ucg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let danaId: string;
let danaAuth: { authorization: string };
let agentId: string;
let linkedProjectId: string;
let unlinkedProjectId: string;
let useCaseId: string;
let intakeInstanceId: string;
let priorGateMode: string | null = null;

function providerCalls() {
  return globalThis.__ucgProviderCalls;
}
function resetProviderCalls() {
  globalThis.__ucgProviderCalls = [];
}

async function setGateMode(mode: "off" | "warn" | "enforce") {
  const res = await app.inject({
    method: "PUT",
    url: "/v1/org/settings",
    headers: AUTH,
    payload: { useCaseGateMode: mode },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().settings.useCaseGateMode).toBe(mode);
}

async function invoke(projectId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: danaAuth,
    payload: { mode: "execute", input: "ucg probe", dispatch: true, projectId },
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

  const [org] = await db.select().from(orgSettings);
  priorGateMode = org?.useCaseGateMode ?? null;

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    // no "@" in the display name — another suite asserts nothing email-shaped
    // leaks through the names-only directory
    payload: { email: "ucg-dana@example.com", displayName: "ucg dana" },
  });
  expect(u.statusCode).toBe(201);
  danaId = u.json().id;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${danaId}/keys`,
    headers: AUTH,
    payload: { name: "ucg" },
  });
  danaAuth = { authorization: `Bearer ${k.json().token}` };

  // ONE agent for the ONE invoking user (the mrm.test.ts lesson): the gate
  // governs the SERVED agent, and a single-agent entitlement makes "which
  // agent was served" deterministic so these assertions are about the gate.
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: "ucg-subject", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: danaId, agentId },
  });

  for (const name of ["ucg-linked-project", "ucg-unlinked-project"]) {
    const p = await app.inject({ method: "POST", url: "/v1/projects", headers: AUTH, payload: { name } });
    expect(p.statusCode).toBe(201);
    if (name === "ucg-linked-project") linkedProjectId = p.json().id;
    else unlinkedProjectId = p.json().id;
  }

  // the link: a REAL proposal through the front door, naming the project —
  // it rests at the plan stage, unapproved, which is the state the gate is
  // about
  const uc = await app.inject({
    method: "POST",
    url: "/v1/use-cases",
    headers: danaAuth,
    payload: {
      name: "ucg-support-summaries",
      description: "summarize inbound support tickets",
      businessContext: "cut first-response time",
      dataSensitivity: "internal",
      projectId: linkedProjectId,
    },
  });
  expect(uc.statusCode).toBe(201);
  useCaseId = uc.json().id;
  intakeInstanceId = uc.json().instance.id;
  resetProviderCalls();
});

afterAll(async () => {
  // M-012: restore the singleton EXACTLY — a leaked enforce mode would 409
  // every later suite's attributed dispatch to a use-case-linked project
  await db
    .update(orgSettings)
    .set({ useCaseGateMode: (priorGateMode ?? "off") as "off" | "warn" | "enforce" })
    .where(eq(orgSettings.id, "singleton"));
  await app.close();
  await db.$client.end();
});

describe("default off — byte-identical (the entire safety argument)", () => {
  it("ships off: the settings read reports useCaseGateMode 'off'", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.useCaseGateMode).toBe("off");
  });

  it("the dispatch that would refuse under enforce passes untouched: 200, provider called, no annotation, zero gate audit rows", async () => {
    const warnedBefore = await auditCount("use-case-gate-warned");
    const refusedBefore = await auditCount("use-case-gate-refused");
    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
    expect(res.json().dispatch.useCaseGate).toBeUndefined();
    expect(await auditCount("use-case-gate-warned")).toBe(warnedBefore);
    expect(await auditCount("use-case-gate-refused")).toBe(refusedBefore);
  });
});

describe("warn — the refusal-shaped fact is recorded, nothing blocked", () => {
  it("dispatch proceeds, the result carries the useCaseGate annotation, and one allow row is audited", async () => {
    await setGateMode("warn");
    const before = await auditCount("use-case-gate-warned");
    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1); // never blocked
    const annotation = res.json().dispatch.useCaseGate;
    expect(annotation).toMatchObject({ mode: "warn", projectId: linkedProjectId });
    expect(annotation.linkedUseCases).toEqual([
      expect.objectContaining({ id: useCaseId, name: "ucg-support-summaries", status: "proposed" }),
    ]);
    expect(annotation.note).toContain("would be REFUSED under enforce");
    expect(await auditCount("use-case-gate-warned")).toBe(before + 1);
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "use-case-gate-warned"));
    const mine = rows.filter((r) => (r.detail as { projectId?: string }).projectId === linkedProjectId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.effect).toBe("allow");
    expect(mine[0]!.objectType).toBe("ai_use_case");
  });

  it("a project NO use case links dispatches with no annotation and no audit row (the honest join)", async () => {
    const before = await auditCount("use-case-gate-warned");
    resetProviderCalls();
    const res = await invoke(unlinkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
    expect(res.json().dispatch.useCaseGate).toBeUndefined();
    expect(await auditCount("use-case-gate-warned")).toBe(before);
  });
});

describe("enforce — refused pre-provider, and an approval flips it live", () => {
  it("refuses 409 use_case_approval_required with ZERO provider calls, audited deny", async () => {
    await setGateMode("enforce");
    const before = await auditCount("use-case-gate-refused");
    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("use_case_approval_required");
    expect(res.json().detail).toContain("ucg-support-summaries");
    expect(res.json().detail).toContain("none is approved");
    expect(providerCalls().length).toBe(0);
    expect(await auditCount("use-case-gate-refused")).toBe(before + 1);
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, "use-case-gate-refused"));
    const mine = rows.filter((r) => (r.detail as { projectId?: string }).projectId === linkedProjectId);
    expect(mine.length).toBe(1);
    expect(mine[0]!.effect).toBe("deny");
  });

  it("an UNLINKED project is unaffected even under enforce", async () => {
    resetProviderCalls();
    const res = await invoke(unlinkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
  });

  it("approving the linked use case through the ONE decide path flips the refused dispatch live", async () => {
    // drive the intake exactly as use-cases.test.ts does: leave plan, submit
    // the questionnaire artifact, then decide the sign-off (self-review, so a
    // reason is required — SoD inherited, not mocked around)
    const left = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/workflows/instances/${intakeInstanceId}/advance`,
      payload: { stageId: "plan" },
    });
    expect(left.statusCode).toBe(200);
    const art = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/workflows/instances/${intakeInstanceId}/artifacts`,
      payload: { stageId: "questionnaire", content: "# AI use-case intake questionnaire\n\nucg filled." },
    });
    expect(art.statusCode).toBe(201);
    const q = await app.inject({ method: "GET", headers: danaAuth, url: "/v1/approvals?status=pending" });
    const signoff = q
      .json()
      .approvals.find(
        (a: { instanceId: string | null; stageId: string | null }) =>
          a.instanceId === intakeInstanceId && a.stageId === "signoff",
      );
    expect(signoff).toBeTruthy();
    const approved = await app.inject({
      method: "POST",
      headers: danaAuth,
      url: `/v1/approvals/${signoff.id}/decide`,
      payload: { decision: "approved", reason: "ucg-e2e: self-review acknowledged for the test" },
    });
    expect(approved.statusCode).toBe(200);

    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
    // an approved link satisfies the gate silently — no annotation in any mode
    expect(res.json().dispatch.useCaseGate).toBeUndefined();
  });

  it("retiring the approved use case takes the approval back out of service for dispatch", async () => {
    const retired = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/use-cases/${useCaseId}/retire`,
      payload: { reason: "ucg-e2e: retired to prove the gate reads live status" },
    });
    expect(retired.statusCode).toBe(200);
    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("use_case_approval_required");
    expect(providerCalls().length).toBe(0);
  });

  it("turning the gate back off restores dispatch with every registry row intact (reversible)", async () => {
    await setGateMode("off");
    resetProviderCalls();
    const res = await invoke(linkedProjectId);
    expect(res.statusCode, res.body).toBe(200);
    expect(providerCalls().length).toBe(1);
  });
});
