/**
 * ADR-0054 — THE WIZARD AND THE IMPORTERS, PROVED BY ATTACK.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. AN IMPORT THAT MINTS AN ADMIN. The headline attack, tried four ways: a
 *     JSON row carrying `isAdmin: true`; the snake_case twin `is_admin`; a CSV
 *     with an `is_admin` column (the path a "just paste your directory export"
 *     feature actually gets used through); and a row naming `grants` directly.
 *     Each is asserted REFUSED, asserted AUDITED with a stable rule id,
 *     asserted recorded in `onboarding_imports` as `refused`, and — the
 *     assertion that matters most — asserted to have created NO user at all.
 *     A silent strip would pass a weaker test and would be the worse outcome:
 *     the importer would believe the administrators landed.
 *  2. AN IMPORT THAT NAMES AN ENTITLEMENT. A group→role import referencing a
 *     role that does not exist is refused WHOLE rather than creating the role,
 *     because a file that defines an entitlement bundle is a file defining
 *     policy. Asserted: no role was created, no mapping was created, and the
 *     refusal is audited.
 *  3. AN IMPORT THAT OUTRUNS THE SEAT CAP. Bulk arrival must not be a way past
 *     ADR-0052. The import path is asserted to call the SAME gate
 *     `POST /v1/users` calls, by installing a real signed license with a seat
 *     cap and watching the import stop at it.
 *  4. A WIZARD THAT DUPLICATES ON RE-RUN. Every mutating step is run TWICE and
 *     asserted to leave exactly one of everything: one step row (the primary
 *     key makes that structural), the same role set, the same profile row, the
 *     same users. The original completion timestamp is asserted UNCHANGED by a
 *     second "mark done" — idempotence means the second call is a no-op, not a
 *     fresh event that rewrites history.
 *  5. A WIZARD THAT LEAVES A HALF-CONFIGURED ORG. An interruption is simulated
 *     mid-step (marked `in_progress`, process "dies", a fresh app instance
 *     reads the state) and asserted to resume at exactly that step with the
 *     partial work intact and re-runnable.
 *  6. A CHECKLIST THAT LIES. A step marked done whose backing object is then
 *     deleted is asserted to report `drift: true` and `satisfied: false`
 *     rather than staying green.
 *
 * SHARED-STATE DISCIPLINE. `onboarding_steps` is an ORG SINGLETON per step and
 * `roles` / `compliance_profiles` are org-wide — a stray row would change other
 * suites' behaviour. `afterAll` deletes every row this suite created: the step
 * rows, the import rows, the `onb-` users, the starter roles it seeded, the
 * compliance profile it applied, and the group→role mappings. The deployment
 * ends the run exactly as it started.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  complianceProfiles,
  createDb,
  eq,
  inArray,
  groupRoleMappings,
  licenseVerifications,
  licenses,
  onboardingImports,
  onboardingSteps,
  projects,
  roles,
  sql,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import {
  COMPLIANCE_PACKS,
  LICENSE_SCHEMA_ID,
  ONBOARDING_STEPS,
  STARTER_ROLE_TEMPLATES,
  canonicalLicenseBytes,
  csvToUserRows,
  licenseDocumentSchema,
  parseCsv,
  planUserImport,
  screenForEscalation,
  transitionRefusal,
} from "@regulait/shared";
import { ONBOARDING_RULE_IDS } from "./onboarding.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "onb-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const STARTER_NAMES = STARTER_ROLE_TEMPLATES.map((t) => t.name);
const DRIFT_PROJECT = "onb-drift-project";

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
const createdUserIds: string[] = [];

/** ephemeral license keyring, exactly the ADR-0052 suite's pattern: real
 * crypto, no committed secret, nothing left behind */
let keyring: string;
let priv: KeyObject;
const KEY_ID = "onb-test-key";
const prevKeyring = process.env.REGULAIT_LICENSE_KEYRING;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

async function auditRows(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}
async function importRows() {
  return db.select().from(onboardingImports);
}
async function userByEmail(email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row ?? null;
}
/** every user this suite could possibly have created, so teardown is total */
const ONB_EMAILS = [
  "onb-member@example.com",
  "onb-alice@example.com",
  "onb-bob@example.com",
  "onb-carol@example.com",
  "onb-evil@example.com",
  "onb-evil2@example.com",
  "onb-evil3@example.com",
  "onb-evil4@example.com",
  "onb-csv1@example.com",
  "onb-seat1@example.com",
  "onb-seat2@example.com",
  "onb-seat3@example.com",
];

beforeAll(async () => {
  keyring = mkdtempSync(path.join(tmpdir(), "onb-keyring-"));
  const kp = generateKeyPairSync("ed25519");
  priv = kp.privateKey;
  writeFileSync(
    path.join(keyring, `${KEY_ID}.pub`),
    kp.publicKey.export({ type: "spki", format: "pem" }) as string,
  );
  process.env.REGULAIT_LICENSE_KEYRING = keyring;

  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const created = await post("/v1/users", {
    email: "onb-member@example.com",
    displayName: "Onboarding Member",
  });
  expect(created.statusCode).toBe(201);
  createdUserIds.push(created.json().id as string);
  const key = await post(`/v1/users/${created.json().id}/keys`, { name: "onb-key" });
  memberAuth = { authorization: `Bearer ${key.json().token as string}` };
}, 60_000);

beforeEach(async () => {
  // Each test starts from a deployment that has NOT begun the wizard and has no
  // license. The checklist is an org singleton keyed on the step, so leaving a
  // `skipped` behind would silently unblock a later test's ordering assertion —
  // exactly the kind of cross-test coupling that makes a suite lie.
  await db.delete(onboardingSteps);
  await db.delete(licenseVerifications);
  await db.delete(licenses);
});

afterAll(async () => {
  await db.delete(onboardingSteps);
  await db.delete(onboardingImports);
  await db.delete(licenseVerifications);
  await db.delete(licenses);
  await db.delete(complianceProfiles).where(
    inArray(complianceProfiles.tag, COMPLIANCE_PACKS.map((p) => p.tag)),
  );
  // mappings cascade from roles, but delete explicitly so an unrelated role
  // never loses one
  const starter = await db.select({ id: roles.id }).from(roles).where(inArray(roles.name, STARTER_NAMES));
  if (starter.length > 0) {
    await db.delete(groupRoleMappings).where(inArray(groupRoleMappings.roleId, starter.map((r) => r.id)));
    await db.delete(roles).where(inArray(roles.name, STARTER_NAMES));
  }
  await db.delete(projects).where(eq(projects.name, DRIFT_PROJECT));
  await db.delete(users).where(inArray(users.email, ONB_EMAILS));
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  await app?.close();
  if (prevKeyring === undefined) delete process.env.REGULAIT_LICENSE_KEYRING;
  else process.env.REGULAIT_LICENSE_KEYRING = prevKeyring;
  rmSync(keyring, { recursive: true, force: true });
});

// ===========================================================================
// 1. THE PURE HALF — no database, no HTTP
// ===========================================================================

describe("the pure planner and screen", () => {
  it("screenForEscalation finds a privilege key at any depth and in any casing", () => {
    expect(screenForEscalation({ rows: [{ email: "a@b.c", isAdmin: true }] }).map((f) => f.path)).toEqual([
      "rows[0].isAdmin",
    ]);
    expect(screenForEscalation({ rows: [{ is_admin: 1 }] })).toHaveLength(1);
    expect(screenForEscalation({ rows: [{ "IS-ADMIN": 1 }] })).toHaveLength(1);
    expect(screenForEscalation({ a: { b: { c: { grants: ["*"] } } } })).toHaveLength(1);
    expect(screenForEscalation({ rows: [{ email: "a@b.c", displayName: "A" }] })).toEqual([]);
  });

  it("planUserImport is idempotent — replanning against the post-apply state is all-unchanged", () => {
    const rows = [
      { email: "a@x.com", displayName: "A" },
      { email: "b@x.com", displayName: "B" },
    ];
    const first = planUserImport(rows, []);
    expect(first.counts).toEqual({ create: 2, update: 0, unchanged: 0, reactivate_required: 0 });
    const after = rows.map((r) => ({ ...r, username: null, disabledAt: null }));
    const second = planUserImport(rows, after);
    expect(second.counts).toEqual({ create: 0, update: 0, unchanged: 2, reactivate_required: 0 });
  });

  it("planUserImport never proposes reactivating a deliberately deactivated account", () => {
    const plan = planUserImport(
      [{ email: "a@x.com", displayName: "A" }],
      [{ email: "a@x.com", displayName: "A", username: null, disabledAt: new Date() }],
    );
    expect(plan.entries[0]!.action).toBe("reactivate_required");
  });

  it("a duplicate email is reported, not silently resolved", () => {
    const plan = planUserImport(
      [
        { email: "a@x.com", displayName: "First" },
        { email: "a@x.com", displayName: "Second" },
      ],
      [],
    );
    expect(plan.duplicateEmails).toEqual(["a@x.com"]);
    expect(plan.entries).toHaveLength(1);
  });

  it("the CSV reader handles quotes, embedded commas and newlines without guessing types", () => {
    const rows = parseCsv('email,displayName\n"a@x.com","Doe, John"\n"b@x.com","Line\nBreak"\n');
    expect(rows).toEqual([
      ["email", "displayName"],
      ["a@x.com", "Doe, John"],
      ["b@x.com", "Line\nBreak"],
    ]);
  });

  it("a CSV keeps an unrecognised column so the strict schema can REFUSE it", () => {
    const objs = csvToUserRows("email,displayName,is_admin\na@x.com,A,true\n");
    // deliberately still present — a dropped column would be a silent strip
    expect(objs[0]).toMatchObject({ email: "a@x.com", displayName: "A", is_admin: "true" });
  });

  it("only 'done' is gated, and a skipped prerequisite satisfies it", () => {
    expect(transitionRefusal("seed_roles", "done", { connect_idp: "pending", import_users: "pending" }))
      .toEqual({ blockedBy: ["import_users"] });
    expect(transitionRefusal("seed_roles", "done", { import_users: "skipped" })).toBeNull();
    expect(transitionRefusal("seed_roles", "in_progress", { import_users: "pending" })).toBeNull();
  });
});

// ===========================================================================
// 2. PRIVILEGE ESCALATION — the headline attack
// ===========================================================================

describe("an import cannot escalate privilege", () => {
  const attacks: Array<{ name: string; payload: Record<string, unknown>; email: string }> = [
    {
      name: "a JSON row claiming isAdmin",
      email: "onb-evil@example.com",
      payload: {
        mode: "apply",
        rows: [{ email: "onb-evil@example.com", displayName: "Evil", isAdmin: true }],
      },
    },
    {
      name: "the snake_case twin is_admin",
      email: "onb-evil2@example.com",
      payload: {
        mode: "apply",
        rows: [{ email: "onb-evil2@example.com", displayName: "Evil2", is_admin: "true" }],
      },
    },
    {
      name: "a row naming grants directly",
      email: "onb-evil3@example.com",
      payload: {
        mode: "apply",
        rows: [{ email: "onb-evil3@example.com", displayName: "Evil3", grants: ["*"] }],
      },
    },
    {
      name: "a CSV with an is_admin column",
      email: "onb-evil4@example.com",
      payload: {
        mode: "apply",
        csv: "email,displayName,is_admin\nonb-evil4@example.com,Evil4,true\n",
      },
    },
  ];

  for (const attack of attacks) {
    it(`refuses, audits and records ${attack.name} — and creates no user`, async () => {
      const before = (await auditRows(ONBOARDING_RULE_IDS.importPrivilegeRefused)).length;
      const res = await post("/v1/onboarding/imports/users", attack.payload);

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("import_privilege_escalation_refused");
      expect(res.json().ruleId).toBe(ONBOARDING_RULE_IDS.importPrivilegeRefused);
      expect(res.json().findings.length).toBeGreaterThan(0);

      // THE assertion: the account does not exist, admin or otherwise. A silent
      // strip would have created a non-admin user and passed a weaker test.
      expect(await userByEmail(attack.email)).toBeNull();

      const after = await auditRows(ONBOARDING_RULE_IDS.importPrivilegeRefused);
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.effect).toBe("deny");

      const refused = (await importRows()).filter(
        (r) => r.status === "refused" && r.ruleId === ONBOARDING_RULE_IDS.importPrivilegeRefused,
      );
      expect(refused.length).toBeGreaterThan(0);
      // a refusal records that nothing happened, rather than an empty result
      // object implying it did
      expect(refused.at(-1)!.result).toBeNull();
      expect(refused.at(-1)!.appliedAt).toBeNull();
    });
  }

  it("no user this suite imported is ever an administrator", async () => {
    const res = await post("/v1/onboarding/imports/users", {
      mode: "apply",
      rows: [
        { email: "onb-alice@example.com", displayName: "Alice" },
        { email: "onb-bob@example.com", displayName: "Bob" },
      ],
    });
    expect(res.statusCode).toBe(200);
    for (const email of ["onb-alice@example.com", "onb-bob@example.com"]) {
      const u = await userByEmail(email);
      expect(u).not.toBeNull();
      expect(u!.isAdmin).toBe(false);
    }
  });

  it("a group->role import cannot invent a role — refused whole, nothing partially applied", async () => {
    // one row names a REAL role, one names a fiction. The whole import must be
    // refused: applying the valid half would leave the org in a state the file
    // does not describe.
    await post("/v1/onboarding/roles/seed", { mode: "apply" });
    const rolesBefore = (await db.select().from(roles)).length;
    const mappingsBefore = (await db.select().from(groupRoleMappings)).length;

    const res = await post("/v1/onboarding/imports/group-roles", {
      mode: "apply",
      rows: [
        { source: "saml", externalGroup: "Engineering", roleName: "Builder" },
        { source: "saml", externalGroup: "Everyone", roleName: "GlobalSuperAdmin" },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unknown_role");
    expect(res.json().unknownRoles).toEqual(["GlobalSuperAdmin"]);

    expect((await db.select().from(roles)).length).toBe(rolesBefore);
    expect((await db.select().from(groupRoleMappings)).length).toBe(mappingsBefore);
    const denies = (await auditRows(ONBOARDING_RULE_IDS.importRejected)).filter((r) => r.effect === "deny");
    expect(denies.length).toBeGreaterThan(0);
  });

  it("a malformed payload is refused with a real error and recorded", async () => {
    const before = (await importRows()).length;
    const res = await post("/v1/onboarding/imports/users", {
      mode: "apply",
      rows: [{ email: "not-an-email", displayName: "" }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("import_validation_failed");
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect((await importRows()).length).toBe(before + 1);
    expect((await importRows()).at(-1)!.status).toBe("refused");
  });

  it("an import runs through the SAME seat gate POST /v1/users does", async () => {
    // Install a real, correctly signed license with a cap the deployment has
    // already reached, then try to import past it.
    const activeUsers = (await db.select().from(users)).filter((u) => u.disabledAt === null).length;
    const doc = licenseDocumentSchema.parse({
      schema: LICENSE_SCHEMA_ID,
      licenseId: "onb-seat-lic",
      tenant: "onb",
      tier: "enterprise",
      seatCap: activeUsers + 1,
      features: [],
      deploymentMode: "airgapped",
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      graceDays: 30,
    });
    const bytes = Buffer.from(canonicalLicenseBytes(doc), "utf8");
    const install = await post("/v1/licenses", {
      documentBase64: bytes.toString("base64"),
      signature: cryptoSign(null, bytes, priv).toString("base64"),
      signingKeyId: KEY_ID,
    });
    expect(install.statusCode).toBe(201);

    const res = await post("/v1/onboarding/imports/users", {
      mode: "apply",
      rows: [
        { email: "onb-seat1@example.com", displayName: "Seat One" },
        { email: "onb-seat2@example.com", displayName: "Seat Two" },
        { email: "onb-seat3@example.com", displayName: "Seat Three" },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // exactly one seat of headroom existed, so exactly one landed
    expect(body.applied.created).toHaveLength(1);
    expect(body.applied.skipped.length).toBe(2);
    expect(String(body.applied.skipped[0].why)).toMatch(/seat|licen/i);

    await db.delete(users).where(
      inArray(users.email, ["onb-seat1@example.com", "onb-seat2@example.com", "onb-seat3@example.com"]),
    );
  });
});

// ===========================================================================
// 3. IDEMPOTENCE
// ===========================================================================

describe("the wizard is idempotent", () => {
  it("re-running the role seed creates nothing the second time", async () => {
    const first = await post("/v1/onboarding/roles/seed", { mode: "apply" });
    expect(first.statusCode).toBe(200);
    const afterFirst = await db.select().from(roles).where(inArray(roles.name, STARTER_NAMES));
    expect(afterFirst.length).toBe(STARTER_NAMES.length);

    const second = await post("/v1/onboarding/roles/seed", { mode: "apply" });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(0);
    const afterSecond = await db.select().from(roles).where(inArray(roles.name, STARTER_NAMES));
    expect(afterSecond.length).toBe(STARTER_NAMES.length);
    expect(afterSecond.map((r) => r.id).sort()).toEqual(afterFirst.map((r) => r.id).sort());
  });

  it("a starter role confers NOTHING — no grants, and no 'Admin' template", async () => {
    await post("/v1/onboarding/roles/seed", { mode: "apply" });
    const seeded = await db.select().from(roles).where(inArray(roles.name, STARTER_NAMES));
    for (const r of seeded) {
      const grants = await get(`/v1/roles/${r.id}/grants`);
      const g = grants.json();
      expect(
        [g.tools, g.servers, g.agents, g.connectors].filter(Boolean).flat().length,
        `${r.name} was seeded with grants — a governance product must not ship a default-allow`,
      ).toBe(0);
    }
    expect(STARTER_NAMES.map((n) => n.toLowerCase())).not.toContain("admin");
  });

  it("re-applying a compliance pack updates one row rather than creating a second", async () => {
    const first = await post("/v1/onboarding/compliance-pack", { pack: "soc2", mode: "apply" });
    expect(first.statusCode).toBe(200);
    const second = await post("/v1/onboarding/compliance-pack", { pack: "soc2", mode: "apply" });
    expect(second.statusCode).toBe(200);
    const rows = await db.select().from(complianceProfiles).where(eq(complianceProfiles.tag, "soc2"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.piiMode).toBe("warn");
    // and it is an ORDINARY profile — visible through the existing route, not a
    // parallel "wizard" representation
    const listed = await get("/v1/compliance/profiles");
    expect((listed.json().profiles as Array<{ tag: string }>).some((p) => p.tag === "soc2")).toBe(true);
  });

  it("marking a step done twice keeps ONE row and the ORIGINAL completion time", async () => {
    await post("/v1/onboarding/steps/connect_idp", { status: "done" });
    const first = await db.select().from(onboardingSteps).where(eq(onboardingSteps.stepKey, "connect_idp"));
    expect(first).toHaveLength(1);
    const firstAt = first[0]!.completedAt!.getTime();

    await new Promise((r) => setTimeout(r, 15));
    const second = await post("/v1/onboarding/steps/connect_idp", { status: "done" });
    expect(second.statusCode).toBe(200);
    expect(second.json().changed).toBe(false);

    const rows = await db.select().from(onboardingSteps).where(eq(onboardingSteps.stepKey, "connect_idp"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completedAt!.getTime()).toBe(firstAt);
  });

  it("re-importing the same users reports everything unchanged and creates nobody", async () => {
    const rows = [
      { email: "onb-alice@example.com", displayName: "Alice" },
      { email: "onb-bob@example.com", displayName: "Bob" },
    ];
    await post("/v1/onboarding/imports/users", { mode: "apply", rows });
    const countAfterFirst = (await db.select().from(users)).length;

    const second = await post("/v1/onboarding/imports/users", { mode: "apply", rows });
    expect(second.statusCode).toBe(200);
    expect(second.json().plan.counts).toMatchObject({ create: 0, unchanged: 2 });
    expect(second.json().applied.created).toEqual([]);
    expect((await db.select().from(users)).length).toBe(countAfterFirst);
  });

  it("a dry run changes nothing and previews exactly what the apply then does", async () => {
    const rows = [{ email: "onb-carol@example.com", displayName: "Carol" }];
    const before = (await db.select().from(users)).length;
    const dry = await post("/v1/onboarding/imports/users", { mode: "dry_run", rows });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().plan.counts.create).toBe(1);
    expect((await db.select().from(users)).length).toBe(before);
    expect(await userByEmail("onb-carol@example.com")).toBeNull();

    const applied = await post("/v1/onboarding/imports/users", { mode: "apply", rows });
    // the SAME planner produced both, so the preview is the act
    expect(applied.json().plan.counts).toEqual(dry.json().plan.counts);
    expect(await userByEmail("onb-carol@example.com")).not.toBeNull();
  });

  it("a re-imported group->role mapping is reconciled, not duplicated", async () => {
    await post("/v1/onboarding/roles/seed", { mode: "apply" });
    const payload = {
      mode: "apply",
      rows: [{ source: "saml", externalGroup: "Engineering", roleName: "Builder" }],
    };
    await post("/v1/onboarding/imports/group-roles", payload);
    const second = await post("/v1/onboarding/imports/group-roles", payload);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(0);
    const rows = await db
      .select()
      .from(groupRoleMappings)
      .where(eq(groupRoleMappings.externalGroup, "Engineering"));
    expect(rows).toHaveLength(1);
  });
});

// ===========================================================================
// 4. RESUMABILITY AND HONESTY
// ===========================================================================

describe("an interrupted wizard resumes without a half-configured org", () => {
  it("resumes at the step that was in flight, across a process restart", async () => {
    // the admin starts seeding roles...
    await post("/v1/onboarding/steps/connect_idp", { status: "skipped" });
    await post("/v1/onboarding/steps/import_users", { status: "skipped" });
    await post("/v1/onboarding/steps/seed_roles", { status: "in_progress" });
    await post("/v1/onboarding/roles/seed", { mode: "apply" });
    // ...and the tab/container dies before the step is marked done.

    // a FRESH app instance — nothing in memory survived
    const revived = buildApp(db, { bootstrapToken: BOOT });
    await revived.ready();
    try {
      const state = await revived.inject({ method: "GET", url: "/v1/onboarding", headers: ADMIN });
      expect(state.statusCode).toBe(200);
      const body = state.json();
      expect(body.resumeAt).toBe("seed_roles");
      const step = (body.steps as Array<Record<string, unknown>>).find((s) => s.key === "seed_roles")!;
      expect(step.status).toBe("in_progress");
      // the partial work is INTACT and visible — not rolled back, not doubled
      expect(step.satisfied).toBe(true);
      expect((step.evidence as { starterTemplatesPresent: string[] }).starterTemplatesPresent.sort()).toEqual(
        [...STARTER_NAMES].sort(),
      );

      // re-running the interrupted step reconciles rather than duplicating
      const rerun = await revived.inject({
        method: "POST",
        url: "/v1/onboarding/roles/seed",
        headers: ADMIN,
        payload: { mode: "apply" },
      });
      expect(rerun.json().created).toBe(0);
      const finish = await revived.inject({
        method: "POST",
        url: "/v1/onboarding/steps/seed_roles",
        headers: ADMIN,
        payload: { status: "done" },
      });
      expect(finish.statusCode).toBe(200);
      expect((await db.select().from(roles).where(inArray(roles.name, STARTER_NAMES))).length).toBe(
        STARTER_NAMES.length,
      );
    } finally {
      await revived.close();
    }
  });

  it("a step cannot be completed out of order, and the refusal is audited", async () => {
    const res = await post("/v1/onboarding/steps/seed_roles", { status: "done" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("step_blocked");
    expect(res.json().blockedBy).toContain("import_users");
    const denies = (await auditRows(ONBOARDING_RULE_IDS.stepBlocked)).filter((r) => r.effect === "deny");
    expect(denies.length).toBeGreaterThan(0);
    // and NOTHING was recorded for the step
    expect(await db.select().from(onboardingSteps).where(eq(onboardingSteps.stepKey, "seed_roles"))).toEqual([]);
  });

  it("every step transition lands an audit row with a stable rule id", async () => {
    const before = (await auditRows(ONBOARDING_RULE_IDS.stepUpdated)).length;
    await post("/v1/onboarding/steps/connect_model_provider", { status: "in_progress" });
    const after = await auditRows(ONBOARDING_RULE_IDS.stepUpdated);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.objectType).toBe("onboarding_step");
    expect(after.at(-1)!.effect).toBe("allow");
  });

  it("an unknown step is a 404, not a silently created row", async () => {
    const res = await post("/v1/onboarding/steps/pwn_the_org", { status: "done" });
    expect(res.statusCode).toBe(404);
    expect((await db.select().from(onboardingSteps)).every((r) => r.stepKey !== "pwn_the_org")).toBe(true);
  });
});

// ===========================================================================
// 5. GOVERNANCE OF THE WIZARD ITSELF
// ===========================================================================

describe("the wizard is admin-only and its output is ordinary state", () => {
  it("a non-admin cannot read the checklist or drive any step", async () => {
    for (const [method, url] of [
      ["GET", "/v1/onboarding"],
      ["GET", "/v1/onboarding/imports"],
      ["GET", "/v1/onboarding/export"],
    ] as const) {
      const res = await app.inject({ method, url, headers: memberAuth });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of [
      "/v1/onboarding/steps/connect_idp",
      "/v1/onboarding/roles/seed",
      "/v1/onboarding/compliance-pack",
      "/v1/onboarding/imports/users",
      "/v1/onboarding/imports/group-roles",
    ]) {
      const res = await post(url, {}, memberAuth);
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("the export is replayable — its mappings are a valid import payload", async () => {
    await post("/v1/onboarding/roles/seed", { mode: "apply" });
    await post("/v1/onboarding/imports/group-roles", {
      mode: "apply",
      rows: [{ source: "oidc", externalGroup: "Reviewers", roleName: "Reviewer" }],
    });
    const exported = (await get("/v1/onboarding/export")).json();
    expect(exported.schema).toBe("regulait.onboarding.export/v1");
    expect(exported.roles.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(STARTER_NAMES));

    // feed the export's own mappings straight back in — the round trip that
    // makes "reproduce this onboarding in the next BYOC deployment" real
    const replay = await post("/v1/onboarding/imports/group-roles", {
      mode: "apply",
      rows: exported.groupRoleMappings,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(0);

    // and it deliberately carries no users, no secrets, no admin flags
    expect(exported.users).toBeUndefined();
    expect(JSON.stringify(exported)).not.toMatch(/isAdmin/);
  });

  it("the checklist itself grants nothing, and says so in the payload", async () => {
    const body = (await get("/v1/onboarding")).json();
    expect(body.checklistGrantsNothing).toBe(true);
    expect(body.steps).toHaveLength(ONBOARDING_STEPS.length);
  });

  it("import history includes the refusals — that is the point of keeping it", async () => {
    await post("/v1/onboarding/imports/users", {
      mode: "apply",
      rows: [{ email: "onb-evil@example.com", displayName: "Evil", isAdmin: true }],
    });
    const res = await get("/v1/onboarding/imports?status=refused");
    expect(res.statusCode).toBe(200);
    const rows = res.json().imports as Array<{ status: string; ruleId: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "refused")).toBe(true);
    expect(rows.some((r) => r.ruleId === ONBOARDING_RULE_IDS.importPrivilegeRefused)).toBe(true);
  });
});

// ===========================================================================
// 6. DRIFT — proved on a PRISTINE deployment of its own
// ===========================================================================
//
// This one gets its own scratch database, and that is not fastidiousness. The
// live signals the checklist composes are ORG-WIDE by definition ("is any
// project classified under a tag that has a profile?"), so on the shared test
// database they are true because of rows some other suite created. Driving one
// to false there would mean deleting org-wide state other suites are standing
// on. A pristine deployment is the only place "this step's backing object went
// away" can be stated exactly, which is the same reasoning seed.test.ts uses.

describe("the checklist reports DRIFT rather than staying green", () => {
  const SCRATCH_DB = `regulait_onb_drift_${process.pid}`;
  const scratchUrl = DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$1`);
  let admin: Db;
  let scratch: Db;
  let sapp: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    admin = createDb(DATABASE_URL!);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
    scratch = createDb(scratchUrl);
    await runMigrations(scratch, migrationsFolder);
    sapp = buildApp(scratch, { bootstrapToken: BOOT });
    await sapp.ready();
  }, 120_000);

  afterAll(async () => {
    // closing the app does NOT end the pool — two separate obligations, and
    // dropScratchDatabase waits for Postgres to report zero backends first
    await closeAll([
      () => sapp?.close() ?? Promise.resolve(),
      () => scratch?.$client.end() ?? Promise.resolve(),
      () => dropScratchDatabase(admin, SCRATCH_DB),
      () => admin?.$client.end() ?? Promise.resolve(),
    ]);
  }, 120_000);

  it("flips satisfied to false and drift to true when the backing object goes away", async () => {
    const spost = (url: string, payload: unknown) =>
      sapp.inject({ method: "POST", url, headers: ADMIN, payload: payload as object });
    const stepNow = async (key: string) => {
      const body = (await sapp.inject({ method: "GET", url: "/v1/onboarding", headers: ADMIN })).json();
      return (body.steps as Array<Record<string, unknown>>).find((s) => s.key === key)!;
    };

    const project = await spost("/v1/projects", { name: DRIFT_PROJECT });
    expect([200, 201]).toContain(project.statusCode);
    const applied = await spost("/v1/onboarding/compliance-pack", {
      pack: "soc2",
      projectId: project.json().id as string,
      mode: "apply",
    });
    expect(applied.statusCode).toBe(200);

    expect((await stepNow("compliance_pack")).satisfied).toBe(true);

    for (const k of ["connect_idp", "import_users", "seed_roles"]) {
      expect((await spost(`/v1/onboarding/steps/${k}`, { status: "skipped" })).statusCode).toBe(200);
    }
    expect((await spost("/v1/onboarding/steps/compliance_pack", { status: "done" })).statusCode).toBe(200);

    const green = await stepNow("compliance_pack");
    expect(green.status).toBe("done");
    expect(green.satisfied).toBe(true);
    expect(green.drift).toBe(false);

    // the profile the cascade hangs off is removed afterwards: the project
    // still carries the tag, but the tag now cascades nothing
    await scratch.delete(complianceProfiles).where(eq(complianceProfiles.tag, "soc2"));

    const drifted = await stepNow("compliance_pack");
    expect(drifted.status).toBe("done");
    expect(drifted.satisfied).toBe(false);
    expect(
      drifted.drift,
      "a checklist that stays green over a broken deployment is worse than none",
    ).toBe(true);
  }, 60_000);
});
