/**
 * ADR-0233 (PENDING S6) — the content-credential guard, proved on the bytes Postgres holds.
 *
 *  1. The inventory: Postgres (information_schema, not the TypeScript) lists every text column named
 *     name/title/description/summary/body; each one is guarded or excluded with a category, never both,
 *     never neither. ADR-0233's inventory table is regenerated from the same registry and must match.
 *  2. One detector: the guard's detector IS `scrubAuditText`, by reference.
 *  3. Per column family, through the real routes (templates, agents, projects, packs): a credential is
 *     refused with 422 naming the field, nothing is stored, and the refusal never echoes the value.
 *  4. Through the raw handle: insert, update().set(), an onConflictDoUpdate upsert, and a write inside a
 *     transaction (which rolls back whole).
 *  5. The over-guard: ordinary content is stored byte-identical.
 *  6. The relaxation: turning the guard off is an audited relaxation (strictness registry: settings_relax),
 *     after which the text is stored as typed; the report then finds the row by id without echoing it.
 *  7. The report is admin-only.
 *
 * Fixtures are prefixed `cg-`; the org setting is restored in afterAll (M-068).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  CONTENT_COLUMN_PATTERN,
  CONTENT_GUARD_DETECTOR,
  CONTENT_GUARD_EXCLUSION_REASONS,
  CONTENT_GUARD_EXCLUSIONS,
  ContentCredentialError,
  auditLog,
  builderSkills,
  contentGuardInventory,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  projects,
  proseScrubInventory,
  roles,
  runMigrations,
  sql,
  teams,
  type Db,
} from "@regulait/db";
import { scrubAuditText } from "@regulait/shared";
import { buildApp } from "./app.js";
import { ORG_SETTING_STRICTNESS } from "./org-setting-strictness.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const ADR = path.resolve(here, "../../../internal/decisions/0233-content-column-credential-guard.md");

const BOOT = "cg-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);

/** Shapes, not live secrets: AWS's published example id, and hex fill. */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const RGL_KEY = `rgl_${"a1b2c3d4".repeat(6)}`;
/** Ordinary content full of what a naive detector eats. */
const ORDINARY =
  "Owner ana@example.com, ticket SEC-4412, agent 7f1a5b2c-9d4e-4a10-b3c8-2e5f6a7b8c90, model claude-opus-4, " +
  "tokensIn 1200; rotate the API token quarterly and keep the password policy in the wiki";

let db: Db;
let app: ReturnType<typeof buildApp>;

const rowsOf = (r: unknown) => (r as { rows: Array<Record<string, any>> }).rows;
const post = (url: string, payload: unknown, headers = AUTH) => app.inject({ method: "POST", url, headers, payload: payload as object });
const countWhere = async (table: string, column: string, value: string) =>
  Number(rowsOf(await db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${value}`))[0]!.n);

function expectRefused(res: { statusCode: number; body: string; json: () => any }, field: string, secret: string) {
  expect(res.statusCode, res.body).toBe(422);
  const body = res.json();
  expect(body.error).toBe("credential_in_content");
  expect(body.field).toBe(field);
  expect(Array.isArray(body.rules) && body.rules.length > 0).toBe(true);
  expect(res.body).not.toContain(secret);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  await db.update(orgSettings).set({ contentCredentialGuard: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}, 120_000);

afterAll(async () => {
  await db.update(orgSettings).set({ contentCredentialGuard: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0233 inventory (generated from the schema)", () => {
  it("every text name/title/description/summary/body column is guarded or excluded — not both, not neither", async () => {
    const cols = rowsOf(
      await db.execute(sql`select table_name || '.' || column_name as c from information_schema.columns
        where table_schema = 'public' and data_type in ('text', 'character varying')`),
    )
      .map((r) => r.c as string)
      .filter((c) => CONTENT_COLUMN_PATTERN.test(c.split(".")[1]!))
      .sort();
    const guarded = new Set(contentGuardInventory());
    const excluded = new Set(Object.keys(CONTENT_GUARD_EXCLUSIONS));
    const neither = cols.filter((c) => !guarded.has(c) && !excluded.has(c));
    const both = [...guarded].filter((c) => excluded.has(c));
    expect(neither, "unclassified content columns — add each to the guard registry or to the exclusions").toEqual([]);
    expect(both).toEqual([]);
    // nothing stale: every registered or excluded column exists in Postgres
    const live = new Set(cols);
    expect([...guarded, ...excluded].filter((c) => !live.has(c))).toEqual([]);
    // the existing-rows report keys every guarded table by its id column
    const withId = new Set(
      rowsOf(await db.execute(sql`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'id'`)).map((r) => r.t as string),
    );
    expect([...guarded].map((c) => c.split(".")[0]!).filter((t) => !withId.has(t))).toEqual([]);
    // one column, one owner: nothing guarded here is also on ADR-0102's prose registry
    const prose = new Set(proseScrubInventory());
    expect([...guarded].filter((c) => prose.has(c))).toEqual([]);
    for (const [c, cat] of Object.entries(CONTENT_GUARD_EXCLUSIONS)) {
      if (cat === "prose_owned_by_adr0102") expect(prose.has(c), c).toBe(true);
    }
  });

  it("ADR-0233's inventory table is the registry, regenerated", () => {
    const adr = readFileSync(ADR, "utf8");
    const block = /<!-- content-guard-inventory:start -->\n([\s\S]*?)<!-- content-guard-inventory:end -->/.exec(adr)?.[1];
    expect(block, "ADR-0233 must carry the generated inventory block").toBeDefined();
    const expected = [
      `Guarded (${contentGuardInventory().length}): ${contentGuardInventory().map((c) => `\`${c}\``).join(", ")}.`,
      "",
      ...Object.entries(CONTENT_GUARD_EXCLUSION_REASONS).map(([cat, reason]) => {
        const members = Object.entries(CONTENT_GUARD_EXCLUSIONS)
          .filter(([, c]) => c === cat)
          .map(([col]) => col)
          .sort();
        return `- Excluded, ${cat} (${members.length}) — ${reason}: ${members.map((c) => `\`${c}\``).join(", ")}.`;
      }),
      "",
    ].join("\n");
    expect(block).toBe(expected);
  });

  it("every handle built in @regulait/db composes all three wrappers (review finding 1)", () => {
    const dir = path.resolve(here, "../../../packages/db/src");
    const sites: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/drizzle\(/g)) {
        const line = text.slice(text.lastIndexOf("\n", m.index) + 1, text.indexOf("\n", m.index));
        if (/^\s*(\/\/|\*|import)/.test(line)) continue;
        sites.push(`${f}: ${line.trim()}`);
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) expect(site).toMatch(/withContentGuard\(withProseScrub\(withAuditChain\(drizzle\(/);
  });

  it("uses ONE detector: the guard's detector is ADR-0099's scrubAuditText, by reference", () => {
    expect(CONTENT_GUARD_DETECTOR).toBe(scrubAuditText);
  });

  it("the setting is a strictness rule: on is strict, off is a relaxation (settings_relax step-up, audited)", () => {
    const entry = ORG_SETTING_STRICTNESS.contentCredentialGuard;
    expect(entry.kind).toBe("rule");
    if (entry.kind !== "rule") return;
    expect(entry.strict).toBe(true);
    expect(entry.relaxed(false)).toBe(true);
    expect(entry.relaxed(true)).toBe(false);
  });
});

describe("refused per column family, through the real routes", () => {
  it("templates: a workflow template name", async () => {
    const name = `cg-tpl-${RUN} ${AWS_KEY}`;
    const res = await post("/v1/workflows/templates", {
      name,
      definition: { workflow: `cg-${RUN}`, stages: [{ id: "intake", type: "trigger" }] },
    });
    expectRefused(res, "name", AWS_KEY);
    expect(await countWhere("workflow_templates", "name", name)).toBe(0);
  });

  it("agents: an agent name", async () => {
    const name = `cg-agent-${RUN}-${RGL_KEY}`;
    const res = await post("/v1/agents", { name, provider: "mock", tier: 1 });
    expectRefused(res, "name", RGL_KEY);
    expect(await countWhere("agents", "name", name)).toBe(0);
  });

  it("projects: a project name", async () => {
    const name = `cg-proj-${RUN} ${AWS_KEY}`;
    const res = await post("/v1/projects", { name });
    expectRefused(res, "name", AWS_KEY);
    expect(await countWhere("projects", "name", name)).toBe(0);
  });

  it("packs: a control description inside the pack's transaction refuses the whole pack", async () => {
    const framework = `cg-fw-${RUN}`;
    const res = await post("/v1/compliance/packs", {
      framework,
      version: 1,
      title: `cg pack ${RUN}`,
      provenance: { source: "cg test" },
      controls: [
        { controlRef: "c1", title: "clean control", coverage: "enforced", collector: "audit_decisions", attestationRequired: false },
        {
          controlRef: "c2",
          title: "second control",
          description: `rotate ${AWS_KEY} monthly`,
          coverage: "enforced",
          collector: "audit_decisions",
          attestationRequired: false,
        },
      ],
    });
    expectRefused(res, "description", AWS_KEY);
    expect(await countWhere("compliance_packs", "framework", framework)).toBe(0);
  });
});

describe("refused per remaining column family and through an update route (review finding 3)", () => {
  it("access control: a role name", async () => {
    const name = `cg-role-${RUN} ${AWS_KEY}`;
    const res = await post("/v1/roles", { name, description: "fine" });
    expectRefused(res, "name", AWS_KEY);
    expect(await countWhere("roles", "name", name)).toBe(0);
  });

  it("access control: a role description", async () => {
    const name = `cg-role-desc-${RUN}`;
    const res = await post("/v1/roles", { name, description: `deploy with ${RGL_KEY}` });
    expectRefused(res, "description", RGL_KEY);
    expect(await countWhere("roles", "name", name)).toBe(0);
  });

  it("connections and integrations: a connector name", async () => {
    const name = `cg-conn-${RUN} ${AWS_KEY}`;
    const res = await post("/v1/connectors", { name, kind: "ticketing" });
    expectRefused(res, "name", AWS_KEY);
    expect(await countWhere("connectors", "name", name)).toBe(0);
  });

  it("evaluation, monitoring and spend: an eval dataset name", async () => {
    const name = `cg-ds-${RUN} ${AWS_KEY}`;
    const res = await post("/v1/evals/datasets", { name });
    expectRefused(res, "name", AWS_KEY);
    expect(await countWhere("eval_datasets", "name", name)).toBe(0);
  });

  it("an update route: renaming a project through PATCH /v1/projects/:id", async () => {
    const created = await post("/v1/projects", { name: `cg-patch-${RUN}` });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json().project ?? created.json()).id as string;
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${id}`,
      headers: AUTH,
      payload: { name: `cg-patch-${RUN} ${AWS_KEY}` },
    });
    expectRefused(res, "name", AWS_KEY);
    expect(rowsOf(await db.execute(sql`select name from projects where id = ${id}`))[0]!.name).toBe(`cg-patch-${RUN}`);
  });
});

describe("refused through the raw handle (no route, no helper)", () => {
  it("insert().values()", async () => {
    await expect(
      db.insert(builderSkills).values({ name: `cg-skill-${RUN}`, description: "d", body: `use ${AWS_KEY}` } as never),
    ).rejects.toBeInstanceOf(ContentCredentialError);
    expect(await countWhere("builder_skills", "name", `cg-skill-${RUN}`)).toBe(0);
  });

  it("update().set()", async () => {
    const [p] = await db.insert(projects).values({ name: `cg-upd-${RUN}` }).returning();
    await expect(db.update(projects).set({ name: `cg-upd-${RUN} ${AWS_KEY}` }).where(eq(projects.id, p!.id))).rejects.toMatchObject({
      code: "credential_in_content",
      column: "name",
      table: "projects",
    });
    expect(rowsOf(await db.execute(sql`select name from projects where id = ${p!.id}`))[0]!.name).toBe(`cg-upd-${RUN}`);
  });

  it("insert().onConflictDoUpdate({ set })", async () => {
    const [t] = await db.insert(teams).values({ name: `cg-team-${RUN}` }).returning();
    await expect(
      db
        .insert(teams)
        .values({ id: t!.id, name: `cg-team-${RUN}` })
        .onConflictDoUpdate({ target: teams.id, set: { name: `cg-team ${RGL_KEY}` } }),
    ).rejects.toBeInstanceOf(ContentCredentialError);
    expect(rowsOf(await db.execute(sql`select name from teams where id = ${t!.id}`))[0]!.name).toBe(`cg-team-${RUN}`);
  });

  it("inside a transaction: the refusal rolls the whole transaction back", async () => {
    const clean = `cg-tx-${RUN}`;
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(roles).values({ name: clean, description: "fine" } as never);
        await tx.insert(roles).values({ name: `${clean}-2`, description: `token ${AWS_KEY}` } as never);
      }),
    ).rejects.toBeInstanceOf(ContentCredentialError);
    expect(await countWhere("roles", "name", clean)).toBe(0);
  });
});

describe("the over-guard: ordinary content is stored byte-identical", () => {
  it("through a route and through the raw handle", async () => {
    const framework = `cg-ok-${RUN}`;
    const res = await post("/v1/compliance/packs", {
      framework,
      version: 1,
      title: `cg ok ${RUN}`,
      description: ORDINARY,
      provenance: { source: "cg test" },
      controls: [{ controlRef: "c1", title: "t", description: ORDINARY, coverage: "enforced", collector: "audit_decisions", attestationRequired: false }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const stored = rowsOf(await db.execute(sql`select description from compliance_packs where framework = ${framework}`))[0];
    expect(stored!.description).toBe(ORDINARY);
    const [r] = await db.insert(roles).values({ name: `cg-ord-${RUN}`, description: ORDINARY } as never).returning();
    expect(rowsOf(await db.execute(sql`select description from roles where id = ${r!.id}`))[0]!.description).toBe(ORDINARY);
  });
});

describe("relaxed by an admin, then reported (never rewritten)", () => {
  it("turning the guard off is an audited relaxation; the text is then stored as typed and the report finds it", async () => {
    const off = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { contentCredentialGuard: false } });
    expect(off.statusCode, off.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1);
    expect((row!.detail as { relaxed?: string[] }).relaxed).toContain("contentCredentialGuard");

    const name = `cg-relaxed-${RUN} ${AWS_KEY}`;
    const created = await post("/v1/projects", { name });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json().project ?? created.json()).id as string;
    expect(rowsOf(await db.execute(sql`select name from projects where id = ${id}`))[0]!.name).toBe(name);

    const on = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { contentCredentialGuard: true } });
    expect(on.statusCode, on.body).toBe(200);

    const report = await app.inject({ method: "GET", url: "/v1/admin/content-credential-report?perColumnLimit=500", headers: AUTH });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.body).not.toContain(AWS_KEY);
    const finding = (report.json().findings as any[]).find((f) => f.rowId === id);
    expect(finding).toMatchObject({ table: "projects", column: "name", field: "name" });
    expect(finding.rules.length).toBeGreaterThan(0);
    // reported, not rewritten
    expect(rowsOf(await db.execute(sql`select name from projects where id = ${id}`))[0]!.name).toBe(name);
    // tidy the fixture (a clean value passes the guard)
    await db.update(projects).set({ name: `cg-relaxed-${RUN}-cleaned` }).where(eq(projects.id, id));
  });

  it("the report has a total row budget and says when it stopped early (review finding 4)", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/admin/content-credential-report?rowBudget=500", headers: AUTH });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.rowBudget).toBe(500);
    expect(typeof body.scannedRows).toBe("number");
    expect(typeof body.incomplete).toBe("boolean");
    if (body.incomplete) expect(body.unscannedColumns.length + body.truncatedColumns.length).toBeGreaterThan(0);
    const bad = await app.inject({ method: "GET", url: "/v1/admin/content-credential-report?rowBudget=10", headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });

  it("the report is admin-only", async () => {
    const u = await post("/v1/users", { email: `cg-${RUN}@example.com`, displayName: "cg user" });
    expect(u.statusCode, u.body).toBe(201);
    const k = await post(`/v1/users/${u.json().id}/keys`, { name: "cg-key" });
    const r = await app.inject({
      method: "GET",
      url: "/v1/admin/content-credential-report",
      headers: { authorization: `Bearer ${k.json().token}` },
    });
    expect(r.statusCode).toBe(403);
  });
});
