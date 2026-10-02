/**
 * AER-042 — the intake wizard's `dataSensitivity` reaches the registry row.
 *
 * The wizard (apps/web IntakeWizardPage.tsx) once posted "restricted", a value
 * outside AI_USE_CASE_DATA_SENSITIVITIES, so every real submission failed
 * while the mocked browser suite stayed green. It now derives the level from
 * the declared data categories (apps/web/.../governance/dataSensitivity.ts:
 * the strictest category wins; none or an unknown one fails closed to
 * "regulated"). What this file proves against the real gateway and Postgres:
 *
 *  1. EVERY LEVEL THE WIZARD CAN DERIVE PERSISTS. The exact body the wizard's
 *     submit() posts — name, description, businessContext (the description
 *     again), the derived dataSensitivity, the accepted framework tags and the
 *     picked agent — is created (201), and ai_use_cases.data_sensitivity and
 *     the proposal's audit row hold the derived value. The derivation can
 *     produce public, confidential and regulated; nothing else.
 *  2. "internal" IS API-ONLY, BY DECISION. No intake category maps to it. The
 *     one candidate, "proprietary", spans internal-grade data (a code copilot)
 *     and confidential data (contract clauses) — the demo fixtures classify
 *     proprietary-only use cases as public, internal AND confidential — so the
 *     fail-closed rule keeps it at the stricter "confidential" rather than
 *     lowering the bar on a guess. A proposer who needs "internal" posts it
 *     directly (dataSensitivity is not editable after create); the API accepts
 *     and persists it.
 *  3. AN OUT-OF-ENUM VALUE CREATES NOTHING. "restricted" — the pre-fix wizard
 *     body, byte for byte apart from the name — is a 400 validation error on
 *     that one field, and the create path leaves no ai_use_cases row, no
 *     workflow instance and no proposal audit row: exact deltas of zero.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed ucds- and run-unique. Row deltas are scoped to
 * this suite's own proposer (M-008).
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  count,
  createDb,
  eq,
  runMigrations,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ucds-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let proposerId: string;
let proposerAuth: { authorization: string };
let agentId: string;

/** the body IntakeWizardPage's submit() posts to /v1/use-cases — same keys,
 * same derivations (businessContext repeats the description; complianceTags
 * are the accepted framework suggestions; intendedAgentIds is the picked
 * agent or empty) */
function wizardBody(o: {
  name: string;
  dataSensitivity: string;
  complianceTags: string[];
  agentId?: string;
}) {
  const description = `${o.name}: drafts a recommendation a human reviews before anything is sent.`;
  return {
    name: o.name,
    description,
    businessContext: description,
    dataSensitivity: o.dataSensitivity,
    complianceTags: o.complianceTags,
    intendedAgentIds: o.agentId ? [o.agentId] : [],
  };
}

const propose = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: proposerAuth, url: "/v1/use-cases", payload });

/** the proposer's own footprint in every table the create path writes */
async function footprint() {
  const [useCases] = await db
    .select({ n: count() })
    .from(aiUseCases)
    .where(eq(aiUseCases.ownerUserId, proposerId));
  const [instances] = await db
    .select({ n: count() })
    .from(workflowInstances)
    .where(eq(workflowInstances.initiatorUserId, proposerId));
  const [proposals] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.userId, proposerId), eq(auditLog.ruleId, "use-case-proposed")));
  return { useCases: useCases!.n, instances: instances!.n, proposals: proposals!.n };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    // no "@" in the display name — another suite asserts nothing email-shaped
    // leaks through the names-only directory
    payload: { email: `ucds-proposer-${RUN}@example.com`, displayName: `ucds proposer ${RUN}` },
  });
  expect(user.statusCode).toBe(201);
  proposerId = user.json().id;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${proposerId}/keys`,
    payload: { name: "ucds-key" },
  });
  expect(key.statusCode).toBe(201);
  proposerAuth = { authorization: `Bearer ${key.json().token}` };
  const [agent] = await db
    .insert(agents)
    .values({ name: `ucds-agent-${RUN}`, provider: "mock", tier: 0 })
    .returning({ id: agents.id });
  agentId = agent!.id;
});

describe("AER-042 — the intake wizard's dataSensitivity persists end to end", () => {
  // The derived level for each set of declared categories, as pinned by
  // apps/web/src/views/admin/governance/dataSensitivity.test.ts — restated,
  // since a gateway suite cannot import the SPA. One case per reachable level.
  const reachable = [
    { categories: ["public"], derived: "public", complianceTags: ["nist-ai-rmf", "iso-42001"] },
    { categories: ["proprietary"], derived: "confidential", complianceTags: ["nist-ai-rmf", "iso-42001", "soc-2"] },
    {
      // the credit demo: personal + financial, an agent picked on Link stack
      categories: ["personal", "financial"],
      derived: "regulated",
      complianceTags: ["eu-ai-act", "nist-ai-rmf", "iso-42001", "soc-2", "iso-27001"],
      withAgent: true,
    },
  ] as const;

  for (const c of reachable) {
    it(`wizard: [${c.categories.join(", ")}] → '${c.derived}' is created and persisted`, async () => {
      const name = `ucds-${RUN}-${c.derived}`;
      const res = await propose(
        wizardBody({
          name,
          dataSensitivity: c.derived,
          complianceTags: [...c.complianceTags],
          ...("withAgent" in c ? { agentId } : {}),
        }),
      );
      expect(res.statusCode).toBe(201);
      const created = res.json() as { id: string; dataSensitivity: string; workflowInstanceId: string };
      expect(created.dataSensitivity).toBe(c.derived);

      const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, created.id));
      expect(row).toMatchObject({
        name,
        dataSensitivity: c.derived,
        status: "proposed",
        ownerUserId: proposerId,
        complianceTags: [...c.complianceTags],
        intendedAgentIds: "withAgent" in c ? [agentId] : [],
      });
      // the governing intake instance exists — the record is live, not a stub
      const [instance] = await db
        .select()
        .from(workflowInstances)
        .where(eq(workflowInstances.id, created.workflowInstanceId));
      expect(instance?.initiatorUserId).toBe(proposerId);
      const proposal = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.objectId, created.id), eq(auditLog.ruleId, "use-case-proposed")));
      expect(proposal).toHaveLength(1);
      expect(proposal[0]!.detail).toMatchObject({ dataSensitivity: c.derived });
    });
  }

  it("'internal' is API-only: no intake category derives it, and a direct create persists it", async () => {
    const res = await propose(
      wizardBody({ name: `ucds-${RUN}-internal`, dataSensitivity: "internal", complianceTags: ["nist-ai-rmf"] }),
    );
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, res.json().id));
    expect(row?.dataSensitivity).toBe("internal");
  });

  it("refuses 'restricted' (the pre-fix wizard value) with a 400 and creates nothing", async () => {
    const name = `ucds-${RUN}-restricted`;
    const before = await footprint();
    const res = await propose(
      wizardBody({
        name,
        dataSensitivity: "restricted",
        complianceTags: ["eu-ai-act", "nist-ai-rmf"],
        agentId,
      }),
    );
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("validation");
    expect(body.issues.map((i) => i.path.join("."))).toEqual(["dataSensitivity"]);

    // exact deltas: no use case, no intake instance, no proposal audit row
    expect(await footprint()).toEqual(before);
    expect(await db.select().from(aiUseCases).where(eq(aiUseCases.name, name))).toHaveLength(0);
  });
});
