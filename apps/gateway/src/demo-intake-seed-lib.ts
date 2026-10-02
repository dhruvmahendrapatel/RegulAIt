/**
 * Demo task C6 — load the AI-intake demo fixtures THROUGH THE REAL APIS.
 *
 * Why not raw inserts: every seeded object then passes the same validation,
 * separation-of-duties, workflow and audit path a person's would, so the
 * demo database contains nothing the product could not have produced itself.
 * The EU AI Act tier of every use case is COMPUTED by the platform from the
 * submitted questionnaire; the fixtures never state one.
 *
 * Idempotent by name: re-running creates nothing that exists (and reports it
 * as skipped). It never throws on one bad item — each failure is recorded in
 * the report with the API's own error, because a seeder that dies half way
 * leaves a demo database nobody can reason about.
 *
 * Personas (created by `seed.ts`; created here if absent, e.g. in tests):
 *  - Ada Admin    — registers vendors and model cards, accepts risks
 *  - Dana Developer — proposes use cases and owns their risks
 * Intake and vendor sign-offs route to the requesting user (the templates'
 * `requesting_user` approver), so each is a recorded SELF-REVIEW with an
 * explicit reason saying it was seeded — the audit trail stays true.
 */
import type { FastifyInstance } from "fastify";
import {
  intakeAssistRequestSchema,
  renderQuestionnaireMarkdown,
  suggestIntake,
  type DemoIntakeFixtures,
  type DemoUseCase,
} from "@regulait/shared";
import { VENDOR_QUESTIONNAIRE_TEMPLATE } from "./vendors.js";

type Json = Record<string, any>;
type Headers = Record<string, string>;

export interface DemoSeedReport {
  created: string[];
  skipped: string[];
  failed: string[];
  notes: string[];
}

/** vendors: the vendor-assessment template still routes to its requester */
const SEED_REASON = "seeded demo record (demo:intake) — self-review recorded for the demo dataset";
/** use cases: decided by the independent governance approver (ADR-0165) */
const SEED_REASON_USE_CASE = "seeded demo record (demo:intake) — decided by the governance approver";

export async function seedDemoIntake(
  app: FastifyInstance,
  fixtures: DemoIntakeFixtures,
  opts: { bootstrapToken: string },
): Promise<DemoSeedReport> {
  const BOOT: Headers = { authorization: `Bearer ${opts.bootstrapToken}` };
  const report: DemoSeedReport = { created: [], skipped: [], failed: [], notes: [] };

  async function call(method: string, url: string, payload?: unknown, headers: Headers = BOOT) {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: Json = {};
    try {
      body = res.json() as Json;
    } catch {
      /* 204 */
    }
    return { status: res.statusCode, body };
  }
  const ok = (s: number) => s >= 200 && s < 300;
  const fail = (what: string, r: { status: number; body: Json }) =>
    report.failed.push(`${what}: ${r.status} ${String(r.body.error ?? "")} ${String(r.body.detail ?? "").slice(0, 160)}`.trim());

  // --- personas ------------------------------------------------------------------
  const users: Json[] = (await call("GET", "/v1/users")).body.users ?? [];
  async function persona(email: string, displayName: string, isAdmin: boolean): Promise<{ id: string; auth: Headers }> {
    let u = users.find((x) => x.email === email);
    if (!u) {
      const r = await call("POST", "/v1/users", { email, displayName, isAdmin });
      if (!ok(r.status)) throw new Error(`cannot create persona ${email}: ${r.status}`);
      u = r.body;
      report.created.push(`user ${email}`);
    }
    const key = await call("POST", `/v1/users/${u!.id}/keys`, { name: "demo-intake-seed" });
    return { id: u!.id as string, auth: { authorization: `Bearer ${key.body.token}` } };
  }
  const ada = await persona("admin@regulait.local", "Ada Admin", true);
  const dana = await persona("dana@regulait.local", "Dana Developer", false);
  const avery = await persona("avery@regulait.local", "Avery Approver", false);

  // --- use-case sign-offs go to an independent governance approver -------------------
  // The built-in `ai-use-case-intake` shape routes sign-off back to the requester
  // (self-review with a recorded reason). The demo, like a real deployment, names
  // a governance owner: a newer intake VARIANT (ADR-0165) routes every new use
  // case's sign-off to Avery — so a proposal registered in the UI lands in
  // Avery's Inbox, never in its proposer's.
  {
    const VARIANT = "ai-use-case-intake/governance-owner";
    const templates: Json[] = (await call("GET", "/v1/workflows/templates", undefined, ada.auth)).body.templates ?? [];
    const routed = templates.some(
      (t) =>
        String(t.name).startsWith(VARIANT) && t.retiredAt == null && JSON.stringify(t.definition ?? {}).includes(avery.id),
    );
    if (routed) report.skipped.push("use-case sign-off routed to Avery");
    else {
      // names stay unique after retirement — take a fresh one if this name was used before
      const name = templates.some((t) => t.name === VARIANT) ? `${VARIANT}-${Date.now()}` : VARIANT;
      const r = await call(
        "POST",
        "/v1/workflows/template-gallery/ai-use-case-intake/create",
        { name, approverUserId: avery.id },
        ada.auth,
      );
      if (ok(r.status)) report.created.push("use-case sign-off routed to Avery");
      else fail("use-case sign-off routing", r);
    }
  }

  // --- agents by name (from seed.ts) ---------------------------------------------------
  const agentList: Json[] = (await call("GET", "/v1/agents")).body.agents ?? [];
  const agentId = new Map(agentList.map((a) => [a.name as string, a.id as string]));
  const agentIdsFor = (names: string[], owner: string) =>
    names.flatMap((n) => {
      const id = agentId.get(n);
      if (!id) report.notes.push(`${owner}: agent '${n}' not found — run the base seed first`);
      return id ? [id] : [];
    });
  // the intended agents must be grantable to the proposer for the stack to mean anything
  for (const name of new Set(fixtures.useCases.flatMap((u) => u.intendedAgentNames))) {
    const id = agentId.get(name);
    if (id) await call("POST", "/v1/grants/agents", { userId: dana.id, agentId: id });
  }

  // --- packs: seed, and activate the latest demo versions when licensed ---------------
  await call("POST", "/v1/compliance/packs/seed", {});
  const packs: Json[] = (await call("GET", "/v1/compliance/packs")).body.packs ?? [];
  for (const fw of ["eu-ai-act", "nist-ai-rmf"]) {
    const latest = packs.filter((p) => p.framework === fw).sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (!latest || latest.status === "active") continue;
    const r = await call("POST", `/v1/compliance/packs/${latest.id}/activate`, {});
    if (ok(r.status)) report.notes.push(`pack ${fw} v${latest.version} activated`);
    else report.notes.push(`pack ${fw} v${latest.version} NOT activated (${r.status} ${String(r.body.error ?? "")}) — install the demo licence (demo:setup) for a measured dashboard`);
  }

  // --- shared workflow driving ---------------------------------------------------------
  async function driveToReview(instanceId: string, content: string, auth: Headers, what: string): Promise<boolean> {
    const adv = await call("POST", `/v1/workflows/instances/${instanceId}/advance`, { stageId: "plan" }, auth);
    if (!ok(adv.status)) return (fail(`${what} advance`, adv), false);
    const art = await call("POST", `/v1/workflows/instances/${instanceId}/artifacts`, { stageId: "questionnaire", content }, auth);
    if (!ok(art.status)) return (fail(`${what} questionnaire`, art), false);
    return true;
  }
  async function decide(instanceId: string, decision: "approved" | "denied", reason: string, auth: Headers, what: string): Promise<boolean> {
    const pending: Json[] = (await call("GET", "/v1/approvals?status=pending", undefined, auth)).body.approvals ?? [];
    const signoff = pending.find((a) => a.instanceId === instanceId && a.stageId === "signoff");
    if (!signoff) return (report.failed.push(`${what}: no pending sign-off found`), false);
    const r = await call("POST", `/v1/approvals/${signoff.id}/decide`, { decision, reason }, auth);
    if (!ok(r.status)) return (fail(`${what} decide`, r), false);
    return true;
  }

  // --- vendors ---------------------------------------------------------------------------
  const vendorList: Json[] = (await call("GET", "/v1/vendors", undefined, ada.auth)).body.vendors ?? [];
  const vendorId = new Map<string, string>();
  for (const v of fixtures.vendors) {
    const existing = vendorList.find((x) => x.name === v.name);
    if (existing) {
      vendorId.set(v.key, existing.id);
      report.skipped.push(`vendor ${v.name}`);
      continue;
    }
    const r = await call("POST", "/v1/vendors", {
      name: v.name, description: v.description, category: v.category, linkedAgentProviders: v.linkedAgentProviders,
    }, ada.auth);
    if (!ok(r.status)) {
      fail(`vendor ${v.name}`, r);
      continue;
    }
    const id = (r.body.vendor?.id ?? r.body.id) as string;
    vendorId.set(v.key, id);
    report.created.push(`vendor ${v.name}`);
    const instanceId = (r.body.instance?.id ?? r.body.workflowInstanceId) as string | undefined;
    if (v.targetStatus === "proposed" || !instanceId) continue;
    const answers = VENDOR_QUESTIONNAIRE_TEMPLATE + `\n\n> Seeded demo answers for ${v.name}: ${v.description}\n`;
    if (!(await driveToReview(instanceId, answers, ada.auth, `vendor ${v.name}`))) continue;
    if (v.targetStatus === "approved" || v.targetStatus === "rejected") {
      await decide(instanceId, v.targetStatus === "approved" ? "approved" : "denied", SEED_REASON, ada.auth, `vendor ${v.name}`);
    }
  }

  // --- model cards ---------------------------------------------------------------------
  const cardList: Json[] = (await call("GET", "/v1/mrm/cards", undefined, ada.auth)).body.cards ?? [];
  for (const c of fixtures.modelCards) {
    const id = agentId.get(c.agentName);
    if (!id) {
      report.notes.push(`model card: agent '${c.agentName}' not found`);
      continue;
    }
    if (cardList.some((x) => x.agentId === id && x.intendedUse === c.intendedUse)) {
      report.skipped.push(`model card ${c.agentName}`);
      continue;
    }
    const r = await call("POST", "/v1/mrm/cards", {
      agentId: id, intendedUse: c.intendedUse, dataClaims: c.dataClaims, limitations: c.limitations,
      biasFairness: c.biasFairness, standardRefs: c.standardRefs,
    }, ada.auth);
    if (ok(r.status)) report.created.push(`model card ${c.agentName}`);
    else fail(`model card ${c.agentName}`, r);
  }

  // --- project (pack evidence is collected per project) ---------------------------------
  const projects: Json[] = (await call("GET", "/v1/projects")).body.projects ?? [];
  const demoProject = projects.find((p) => p.name === "demo-project");

  // --- use cases -------------------------------------------------------------------------
  const ucList: Json[] = (await call("GET", "/v1/use-cases", undefined, ada.auth)).body.useCases ?? [];
  const useCaseId = new Map<string, string>();
  async function seedUseCase(u: DemoUseCase) {
    const existing = ucList.find((x) => x.name === u.name);
    if (existing) {
      useCaseId.set(u.key, existing.id);
      report.skipped.push(`use case ${u.name}`);
      return;
    }
    const r = await call("POST", "/v1/use-cases", {
      name: u.name, description: u.description, businessContext: u.businessContext,
      dataSensitivity: u.dataSensitivity, complianceTags: u.complianceTags,
      intendedAgentIds: agentIdsFor(u.intendedAgentNames, `use case ${u.name}`),
      ...(demoProject ? { projectId: demoProject.id } : {}),
    }, dana.auth);
    if (!ok(r.status)) return fail(`use case ${u.name}`, r);
    const id = (r.body.id ?? r.body.useCase?.id) as string;
    const instanceId = (r.body.instance?.id ?? r.body.workflowInstanceId) as string;
    useCaseId.set(u.key, id);
    report.created.push(`use case ${u.name}`);
    if (u.targetStatus === "proposed") return;
    const s = suggestIntake(intakeAssistRequestSchema.parse(u.intake));
    const md = renderQuestionnaireMarkdown(s.questionnaire, s.euAiActBlock);
    if (!(await driveToReview(instanceId, md, dana.auth, `use case ${u.name}`))) return;
    if (u.targetStatus === "under_review") return;
    const decision = u.targetStatus === "rejected" ? "denied" : "approved";
    const reason = u.decisionReason ? `${u.decisionReason} — ${SEED_REASON_USE_CASE}` : SEED_REASON_USE_CASE;
    // Avery, the independent governance approver, decides (separation of duties)
    if (!(await decide(instanceId, decision, reason, avery.auth, `use case ${u.name}`))) return;
    if (u.targetStatus === "retired") {
      // retirement is an admin act (the default gate), not the proposer's
      const ret = await call("POST", `/v1/use-cases/${id}/retire`, { reason: u.decisionReason ?? "retired (seeded)" }, ada.auth);
      if (!ok(ret.status)) fail(`use case ${u.name} retire`, ret);
    }
  }
  for (const u of fixtures.useCases) await seedUseCase(u);

  // --- risks -----------------------------------------------------------------------------
  const riskList: Json[] = (await call("GET", "/v1/risks", undefined, ada.auth)).body.risks ?? [];
  for (const k of fixtures.risks) {
    const ucId = k.useCaseKey ? useCaseId.get(k.useCaseKey) : undefined;
    const vId = k.vendorKey ? vendorId.get(k.vendorKey) : undefined;
    if ((k.useCaseKey && !ucId) || (k.vendorKey && !vId) || (!ucId && !vId)) {
      report.notes.push(
        `risk '${k.title}': subject not seeded (use case '${k.useCaseKey ?? "-"}', vendor '${k.vendorKey ?? "-"}')`,
      );
      continue;
    }
    if (riskList.some((x) => x.title === k.title && (x.useCaseId ?? null) === (ucId ?? null) && (x.vendorId ?? null) === (vId ?? null))) {
      report.skipped.push(`risk ${k.title}`);
      continue;
    }
    const r = await call("POST", "/v1/risks", {
      title: k.title, description: k.description, category: k.category,
      likelihood: k.likelihood, impact: k.impact,
      ...(ucId ? { useCaseId: ucId } : {}),
      ...(k.mitigation ? { mitigation: k.mitigation } : {}),
      ...(vId ? { vendorId: vId } : {}),
      ...(demoProject ? { projectId: demoProject.id } : {}),
    }, dana.auth);
    if (!ok(r.status)) {
      fail(`risk ${k.title}`, r);
      continue;
    }
    const riskId = r.body.id as string;
    report.created.push(`risk ${k.title}`);
    for (const ref of k.controls) {
      const l = await call("POST", `/v1/risks/${riskId}/controls`, { controlRef: ref }, dana.auth);
      if (!ok(l.status)) fail(`risk ${k.title} control ${ref}`, l);
    }
    if (k.residual) {
      const res = await call("PUT", `/v1/risks/${riskId}/residual`, k.residual, dana.auth);
      if (!ok(res.status)) fail(`risk ${k.title} residual`, res);
    }
    if (k.targetStatus === "mitigating") {
      const t = await call("POST", `/v1/risks/${riskId}/transition`, { status: "mitigating", reason: "controls linked (seeded)" }, dana.auth);
      if (!ok(t.status)) fail(`risk ${k.title} transition`, t);
    } else if (k.targetStatus === "closed") {
      const t = await call("POST", `/v1/risks/${riskId}/transition`, { status: "closed", reason: k.closeReason ?? "closed (seeded)" }, dana.auth);
      if (!ok(t.status)) fail(`risk ${k.title} close`, t);
    } else if (k.targetStatus === "accepted") {
      const a = await call("POST", `/v1/risks/${riskId}/accept`, { note: k.acceptanceNote ?? "accepted (seeded)" }, ada.auth);
      if (!ok(a.status)) fail(`risk ${k.title} accept`, a);
    }
  }

  // --- shadow AI evidence (imported, never claimed as discovered) --------------------------
  if (fixtures.shadowAi.length > 0) {
    // the matcher holds no provider names — with an empty signature catalogue
    // every observation is "unmatched" and the Discover beat shows nothing
    const cat = await call("POST", "/v1/shadow-ai/catalogue/seed", {}, ada.auth);
    if (!ok(cat.status)) fail("shadow-AI catalogue seed", cat);
    const r = await call("POST", "/v1/shadow-ai/imports", {
      kind: "saas_export",
      mode: "apply",
      source: "demo-intake-seed (synthetic SaaS export)",
      rows: fixtures.shadowAi.map((s) => ({
        appName: s.appName, vendorHost: s.vendorHost, grantedBy: s.grantedBy, installCount: s.installCount,
      })),
    }, ada.auth);
    if (ok(r.status)) {
      report.created.push(`shadow-AI import (${fixtures.shadowAi.length} rows)`);
      const matched = Number(r.body.matched ?? r.body.summary?.matched ?? 0);
      if (matched === 0) {
        report.notes.push(
          "shadow-AI import matched 0 rows — use vendor hosts the signature catalogue knows " +
            "(GET /v1/shadow-ai/catalogue), e.g. api.openai.com, claude.ai",
        );
      }
    } else fail("shadow-AI import", r);
  }

  return report;
}
