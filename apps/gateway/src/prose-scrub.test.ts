/**
 * ADR-0102 e2e — PROOF BY THE STORED COLUMN.
 *
 * PENDING S5 is a specific, reproducible defect, not a vague worry: an
 * AWS-shaped key typed into an MCP admission-clear reason was scrubbed in
 * `audit_log.reason` by ADR-0099 and stored VERBATIM in
 * `mcp_servers.admission_clear_reason` in the same request. Two records of one
 * event, disagreeing about whether the secret was contained.
 *
 * So the first test in this file is that exact reproduction, INVERTED, and it
 * asserts the thing the defect was actually about: not merely that the column
 * is now redacted, but that the marker in the column is BYTE-IDENTICAL to the
 * marker in `audit_log`. Identical markers are what make the two rows
 * correlate; two different redactions would have been a second bug wearing the
 * fix's clothes.
 *
 * Everything is read back OUT OF POSTGRES with raw SQL after the write has
 * committed — never the HTTP response, never the ORM's return value, because a
 * scrubber that is correct and unwired protects nothing.
 *
 * What is proven, in order:
 *  1. The S5 reproduction, inverted, with marker identity.
 *  2. Two more surfaces end-to-end through their real routes, deliberately
 *     different in shape: an approval decision (an `update().set()` inside the
 *     ROUTE'S OWN transaction) and an agent revocation (a plain `insert()`).
 *  3. A raw `db.update(...)` and a raw `db.insert(...)` — no route, no helper —
 *     which is what proves the scrub is sited at the handle and not at call
 *     sites, and an `onConflictDoUpdate` upsert, which is a third write shape.
 *  4. The OVER-SCRUB guard: ordinary operator prose is byte-identical
 *     afterwards, on every one of those surfaces. This matters as much as the
 *     positive case — a governance product whose reason fields quietly mangle
 *     what an operator wrote is worse than the leak it prevents.
 *  5. ONE detector: the prose path and the audit path are the same function
 *     over the same rule list, asserted by reference and behaviourally.
 *  6. The covered / NOT-covered inventory, so the ADR's enumeration is a test
 *     and cannot silently go stale.
 *
 * SHARED-STATE DISCIPLINE. Every fixture is prefixed `ps-`; every count is a
 * DELTA over rows this file created; nothing mutates the `org_settings`
 * singleton.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agentRevocations,
  and,
  auditLog,
  createDb,
  eq,
  mcpServers,
  proseScrubInventory,
  PROSE_SCRUB,
  PROSE_SCRUB_EXCLUSIONS,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { CREDENTIAL_MATERIAL_RULES, scrubAuditText } from "@regulait/shared";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ps-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

/** Shapes, not live secrets: the AWS id is AWS's own published example and the
 * RegulAIt tokens are hex fill. */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const RGL_KEY = `rgl_${"a1b2c3d4".repeat(6)}`;

/** The over-scrub fixture. Deliberately full of the things a naive detector
 * eats: an underscore-cased identifier, a uuid, an email, a model name, a
 * number that looks like a token count, and the word "token" itself. */
const ORDINARY =
  "approved after review with the vendor on 2026-09-06; ticket SEC-4412, owner " +
  "ana@example.com, agent 7f1a5b2c-9d4e-4a10-b3c8-2e5f6a7b8c90, model claude-opus-4, " +
  "tokensIn 1200 — the tool description is a documented false positive, not an injection";

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId: string;
let ownerAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
let initiatorAuth: { authorization: string };
const createdServerIds: string[] = [];

async function mkUser(email: string) {
  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${u.json().id}/keys`,
    payload: { name: "ps-key" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** One row, by raw SQL, so nothing in the ORM layer can be why an assertion
 * passes. */
async function raw(table: string, id: string): Promise<Record<string, any>> {
  const res = await db.execute(sql.raw(`select * from ${table} where id = '${id}'`));
  const row = (res as unknown as { rows: Array<Record<string, any>> }).rows[0];
  if (!row) throw new Error(`no ${table} row ${id}`);
  return row;
}

const markerIn = (s: string | null): string | undefined =>
  s == null ? undefined : (/\[redacted:[^\]]+\]/.exec(s)?.[0] ?? undefined);

/**
 * Register a server and force it into `held` — the state the admin CLEAR route
 * requires. The hold is set directly because the point of this file is the
 * clear, not the scanner (ADR-0097's own suite proves the scanner); the clear
 * itself is driven through the real HTTP route.
 */
let upstreamPort = 9000;
async function heldServer(name: string): Promise<string> {
  // A loopback URL nothing listens on. This file never CONNECTS to a server —
  // it drives the admin clear, which is a database write — so the destination
  // only has to pass ADR-0043's write-time egress check.
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name, url: `http://127.0.0.1:${(upstreamPort += 1)}/` },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  createdServerIds.push(id);
  await db
    .update(mcpServers)
    .set({
      admissionState: "held",
      admissionSeverity: "high",
      admissionFindings: [{ ruleId: "mcp.admission.injection", severity: "high", toolName: "t" }],
      admissionManifestDigest: "sha256:ps",
      admissionScannedAt: new Date(),
    })
    .where(eq(mcpServers.id, id));
  return id;
}

/** Drive the REAL admin clear route and return both stored records. */
async function clearWithReason(name: string, reason: string) {
  const serverId = await heldServer(name);
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/servers/${serverId}/admission/clear`,
    payload: { reason },
  });
  expect(res.statusCode).toBe(200);
  const server = await raw("mcp_servers", serverId);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, serverId), eq(auditLog.ruleId, "mcp-admission-cleared")));
  expect(rows).toHaveLength(1);
  const audit = await raw("audit_log", rows[0]!.id);
  return { serverId, server, audit };
}

/** A workflow whose single gate is a human approval by `approverId`. */
async function pendingApproval(changeType: string): Promise<string> {
  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: {
      name: `ps-${changeType}`,
      definition: {
        workflow: `ps-${changeType}`,
        stages: [
          { id: "intake", type: "trigger" },
          { id: "gate", type: "human_approval", approvers: [approverId] },
        ],
      },
    },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType },
  });
  expect(rule.statusCode).toBe(201);
  const inst = await app.inject({
    method: "POST",
    headers: initiatorAuth,
    url: "/v1/workflows/instances",
    payload: { change: { description: `ps ${changeType}`, paths: ["src/"], changeType, environment: "ps-env" } },
  });
  expect(inst.statusCode).toBe(201);
  const list = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
  const found = (list.json().approvals as Array<{ id: string; instanceId: string | null }>).find(
    (a) => a.instanceId === inst.json().id,
  );
  expect(found).toBeTruthy();
  return found!.id;
}

/** Decide it with a reason — an `update().set()` inside the ROUTE'S OWN
 * `db.transaction()`, which is the case a wrapper that forgot to propagate
 * through `transaction()` would silently miss. */
async function decideWithReason(changeType: string, reason: string) {
  const approvalId = await pendingApproval(changeType);
  const res = await app.inject({
    method: "POST",
    headers: approverAuth,
    url: `/v1/approvals/${approvalId}/decide`,
    payload: { decision: "approved", reason },
  });
  expect(res.statusCode).toBe(200);
  return raw("approvals", approvalId);
}

/** An agent + a per-user revocation of it, carrying a reason. A plain
 * `insert().values()` through a real route. */
async function revokeWithReason(agentName: string, reason: string) {
  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: agentName, provider: "anthropic", tier: 0 },
  });
  expect(agent.statusCode).toBe(201);
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${ownerId}/revocations/agents`,
    payload: { agentId: agent.json().id, reason },
  });
  expect(res.statusCode).toBe(201);
  return raw("agent_revocations", res.json().id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  ({ id: ownerId, auth: ownerAuth } = await mkUser("ps-owner@example.com"));
  ({ id: approverId, auth: approverAuth } = await mkUser("ps-approver@example.com"));
  ({ auth: initiatorAuth } = await mkUser("ps-initiator@example.com"));
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

// ---------------------------------------------------------------------------

describe("1. the S5 reproduction, inverted", () => {
  it("scrubs the admission-clear reason IN THE COLUMN, and the marker is identical to audit_log's", async () => {
    const reason = `cleared while rotating ${AWS_KEY}, which the vendor had embedded in the manifest`;
    const { server, audit } = await clearWithReason("ps-s5", reason);

    // THE DEFECT: this column held the key verbatim.
    expect(server.admission_clear_reason).not.toContain(AWS_KEY);
    expect(server.admission_clear_reason).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    // the sentence around it is intact — the operator's explanation survives
    expect(server.admission_clear_reason).toContain("cleared while rotating ");
    expect(server.admission_clear_reason).toContain(", which the vendor had embedded in the manifest");

    // ADR-0099's half still holds
    expect(audit.reason).not.toContain(AWS_KEY);
    expect((audit.detail as Record<string, any>).reason).not.toContain(AWS_KEY);

    // THE POINT OF THE FIX: one secret, one marker, in both records.
    const inColumn = markerIn(server.admission_clear_reason);
    const inAudit = markerIn(audit.reason);
    const inDetail = markerIn((audit.detail as Record<string, any>).reason);
    expect(inColumn).toBeTruthy();
    expect(inColumn).toBe(inAudit);
    expect(inColumn).toBe(inDetail);
  });

  it("correlates the SAME key across two different clears, and never collapses two keys", async () => {
    const a = await clearWithReason("ps-corr-a", `first sighting ${AWS_KEY}`);
    const b = await clearWithReason("ps-corr-b", `second sighting ${AWS_KEY}`);
    const c = await clearWithReason("ps-corr-c", `unrelated key ${RGL_KEY}`);
    expect(markerIn(a.server.admission_clear_reason)).toBe(markerIn(b.server.admission_clear_reason));
    expect(markerIn(c.server.admission_clear_reason)).not.toBe(markerIn(a.server.admission_clear_reason));
    expect(c.server.admission_clear_reason).toContain("[redacted:regulait_token:");
  });
});

// ---------------------------------------------------------------------------

describe("2. two more covered columns, through their real routes", () => {
  it("approvals.decision_reason — an update().set() inside the ROUTE's own transaction", async () => {
    const row = await decideWithReason(
      "ps-approve-change",
      `approved; the failing job was using ${AWS_KEY} and it has been rotated`,
    );
    expect(row.decision_reason).not.toContain(AWS_KEY);
    expect(row.decision_reason).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    expect(row.decision_reason).toContain("approved; the failing job was using ");
    expect(row.status).toBe("approved");
  });

  it("agent_revocations.reason — a plain insert().values()", async () => {
    const row = await revokeWithReason(
      "ps-revoked-agent",
      `revoked after the shared key ${RGL_KEY} turned up in a ticket`,
    );
    expect(row.reason).not.toContain(RGL_KEY);
    expect(row.reason).toContain("[redacted:regulait_token:");
    expect(row.reason).toContain("revoked after the shared key ");
  });
});

// ---------------------------------------------------------------------------

describe("3. the siting: no route, no helper, and a third write shape", () => {
  it("scrubs a RAW db.update() a future module might write", async () => {
    const id = await heldServer("ps-raw-update");
    await db
      .update(mcpServers)
      .set({ admissionClearReason: `raw update carrying ${AWS_KEY} straight into the column` })
      .where(eq(mcpServers.id, id));
    const row = await raw("mcp_servers", id);
    expect(row.admission_clear_reason).not.toContain(AWS_KEY);
    expect(row.admission_clear_reason).toContain("raw update carrying ");
    // the columns NOT registered are untouched by the wrapper
    expect(row.admission_state).toBe("held");
  });

  it("scrubs a RAW db.insert()", async () => {
    const agent = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/agents",
      payload: { name: "ps-raw-insert-agent", provider: "anthropic", tier: 0 },
    });
    expect(agent.statusCode).toBe(201);
    const id = randomUUID();
    await db.insert(agentRevocations).values({
      id,
      userId: ownerId,
      agentId: agent.json().id,
      reason: `raw insert carrying ${AWS_KEY}`,
    });
    const row = await raw("agent_revocations", id);
    expect(row.reason).not.toContain(AWS_KEY);
    expect(row.reason).toContain("raw insert carrying ");
  });

  it("scrubs the UPSERT branch — onConflictDoUpdate({ set }) writes the same columns", async () => {
    const host = `ps-upsert-${randomUUID().slice(0, 8)}.example.com`;
    const post = (note: string) =>
      app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/egress-allow-hosts",
        payload: { host, note },
      });

    const first = await post("initial registration, reviewed by security");
    expect(first.statusCode).toBeLessThan(300);
    // the INSERT branch left ordinary prose byte-identical …
    const created = await raw("egress_allow_hosts", first.json().id);
    expect(created.note).toBe("initial registration, reviewed by security");

    // … and the CONFLICT branch, which is a different code path in drizzle,
    // scrubs too. `custom-providers.ts` passes the SAME object to `.values()`
    // and to `.onConflictDoUpdate({ set })`, so a fix applied to only one of
    // them would pass the first assertion and fail here.
    const second = await post(`re-registered with ${AWS_KEY} pasted from the runbook`);
    expect(second.statusCode).toBeLessThan(300);
    const updated = await raw("egress_allow_hosts", second.json().id);
    expect(updated.id).toBe(created.id);
    expect(updated.note).not.toContain(AWS_KEY);
    expect(updated.note).toMatch(/\[redacted:aws_key:20:[0-9a-f]{12}\]/);
    expect(updated.note).toContain("re-registered with ");
  });
});

// ---------------------------------------------------------------------------

describe("4. the OVER-SCRUB guard — ordinary prose is byte-identical", () => {
  it("leaves a realistic admission-clear reason exactly as typed", async () => {
    const { server, audit } = await clearWithReason("ps-plain", ORDINARY);
    expect(server.admission_clear_reason).toBe(ORDINARY);
    expect(audit.reason).toContain(ORDINARY);
    expect(server.admission_clear_reason).not.toContain("[redacted:");
  });

  it("leaves an approval decision reason and a revocation reason exactly as typed", async () => {
    const approval = await decideWithReason("ps-plain-approve", ORDINARY);
    expect(approval.decision_reason).toBe(ORDINARY);
    const revocation = await revokeWithReason("ps-plain-agent", ORDINARY);
    expect(revocation.reason).toBe(ORDINARY);
  });

  it("returns the values object BY IDENTITY when nothing matched", () => {
    // the guard expressed at the unit level: the common path does not rebuild
    // the string, so it cannot accidentally change it
    expect(PROSE_SCRUB(ORDINARY)).toBe(ORDINARY);
    for (const s of [
      "rotate the api key next quarter",
      "tokensIn 1200 / tokensOut 340 over budget",
      "see https://example.com/runbook#step-3",
      "declined: the requester is the approver",
      "",
    ]) {
      expect(PROSE_SCRUB(s)).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------

describe("5. ONE detector, shared with the audit path", () => {
  it("is literally the same function reference ADR-0099 uses", () => {
    // A second implementation could drift, and a drifted marker is exactly the
    // S5 defect again in a new place. There is no second implementation.
    expect(PROSE_SCRUB).toBe(scrubAuditText);
  });

  it("covers every rule in CREDENTIAL_MATERIAL_RULES, and names it in the marker", () => {
    const samples: Record<string, string> = {
      "dlp.secret.aws_key": AWS_KEY,
      "dlp.secret.jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2hlcmVfb2s",
      "dlp.secret.private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKA\n-----END RSA PRIVATE KEY-----",
      "dlp.secret.assignment": 'api_key = "s3cr3t-value-goes-here"',
      "dlp.secret.provider_token": `sk-${"a1b2c3d4".repeat(5)}`,
      "dlp.secret.regulait_token": RGL_KEY,
    };
    // every shipped rule has a sample here — a NEW rule added to
    // `guardrails.ts` fails this line until it is exercised on this path too
    expect(CREDENTIAL_MATERIAL_RULES.map((r) => r.id).sort()).toEqual(Object.keys(samples).sort());
    for (const [id, sample] of Object.entries(samples)) {
      const out = PROSE_SCRUB(`operator wrote ${sample} in the box`);
      expect(out, id).toContain("[redacted:");
      expect(out, id).toContain("operator wrote ");
      expect(out, id).toContain(" in the box");
    }
  });

  it("produces the identical marker whether the text is going to audit_log or to a column", () => {
    // the invariant the e2e above proves through Postgres, stated directly
    const text = `same secret ${AWS_KEY} either way`;
    expect(PROSE_SCRUB(text)).toBe(scrubAuditText(text));
  });
});

// ---------------------------------------------------------------------------

describe("6. the covered / NOT-covered inventory", () => {
  /**
   * The ADR's enumeration, as a test. If someone adds a reason column and does
   * not register it, this list is what tells the next reader — and this ADR's
   * honest-limits section — that it is uncovered.
   */
  const COVERED = [
    "agent_revocations.reason",
    "agents.lifecycle_reason",
    "ai_endpoint_signatures.replacement_note",
    "ai_risks.acceptance_note",
    "ai_use_cases.retired_reason",
    "ai_vendors.retired_reason",
    "approval_delegations.reason",
    "approvals.decision_reason",
    "billing_statements.issue_reason",
    "cert_rotations.reason",
    "compliance_pack_controls.owner_note",
    "config_activation_events.reason",
    "config_canary_observations.candidate_reason",
    "config_canary_observations.failure_reason",
    "config_canary_observations.served_reason",
    "connector_revocations.reason",
    "copilot_proposals.rationale",
    "cost_import_batches.reason",
    "data_key_attestations.note",
    "decisions.rationale",
    "egress_allow_hosts.note",
    "eval_datasets.note",
    "eval_results.judge_rationale",
    "eval_runs.gate_reason",
    "eval_runs.note",
    "imported_cost_lines.superseded_reason",
    "interception_scope_rules.note",
    "license_verifications.reason",
    "mcp_registry_entries.catalogue_reason",
    "mcp_servers.admission_clear_reason",
    "model_card_approvals.decision_reason",
    "model_card_evidence.note",
    "model_cards.note",
    "onboarding_imports.reason",
    "policy_simulations.note",
    "redteam_libraries.note",
    "redteam_probes.note",
    "redteam_runs.gate_reason",
    "redteam_runs.note",
    "shadow_ai_findings.disposition_reason",
    "shadow_ai_findings.replacement_note",
    "shadow_ai_imports.reason",
    "sod_rules.reason",
    "spend_anomalies.decision_reason",
    "spend_anomalies.explanation",
    "spend_scheduled_changes.reason",
    // ADR-0111 — the EXPORTED OBSERVABILITY COPY. Not prose: a governed tool
    // call's arguments and result (and, on an `llm` span, the prompt and
    // completion). Registered because they are a DUPLICATE of a record ADR-0104
    // and ADR-0099 already scrub, and because ADR-0070 puts them on the OTLP
    // wire as `gen_ai.input.messages` / `gen_ai.output.messages`.
    "trace_spans.input_preview",
    "trace_spans.output_preview",
    "trace_spans.status_reason",
    "training_datasets.note",
    "vendor_account_aliases.reason",
    "vendor_domain_rules.reason",
    "workflow_templates.retired_reason",
  ];

  it("covers exactly the enumerated columns — the ADR's list is this list", () => {
    expect(proseScrubInventory()).toEqual([...COVERED].sort());
  });

  it("names its exclusions rather than merely omitting them", () => {
    expect([...PROSE_SCRUB_EXCLUSIONS].sort()).toEqual([
      "audit_log.reason",
      "mcp_registry_entries.conflict_reason",
      "usage_events.stop_reason",
    ]);
    // and the excluded ones are genuinely absent from the covered set
    for (const c of PROSE_SCRUB_EXCLUSIONS) expect(proseScrubInventory()).not.toContain(c);
  });

  it("every reason/note column in the schema is either covered or explicitly excluded", async () => {
    // Asked of POSTGRES, not of the TypeScript, so a column added by a
    // hand-authored migration cannot slip past the registry unnoticed.
    const res = await db.execute(sql`
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and data_type in ('text', 'character varying')
         and (column_name like '%reason%' or column_name like '%note%'
              or column_name like '%rationale%' or column_name like '%explanation%'
              -- widened 2026-09-06: the schema sweep that FOUND S5 also matched
              -- these two. Neither exists today, so this catches nothing now —
              -- which is the point: a guard that is narrower than the sweep that
              -- found the bug will not notice the next column of the same kind.
              or column_name like '%justification%' or column_name like '%comment%')
    `);
    const found = (res as unknown as { rows: Array<{ table_name: string; column_name: string }> }).rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .sort();
    const accounted = new Set([...proseScrubInventory(), ...PROSE_SCRUB_EXCLUSIONS]);
    expect(found.filter((c) => !accounted.has(c))).toEqual([]);
  });
});
