/**
 * Demo task C11 — `demo:check`: walk every storyline beat (AgentCoordination
 * §1) against a seeded database, through the real API, and say PASS / WARN /
 * FAIL per beat with what to fix.
 *
 *   FAIL  the beat cannot be shown (endpoint errors, required data missing)
 *   WARN  the beat works but will look thin or skips a planned moment
 *   PASS  the beat shows what the script says it shows
 *
 * It is the M4 dry-run tool and the morning-of smoke test. Read-only except
 * for one thing it must do to check the Monitor beat: a monitor evaluation
 * pass (which is itself idempotent and audited). It never decides an approval
 * or proposes a remediation — those are live demo moments.
 */
import type { FastifyInstance } from "fastify";
import type { DemoIntakeFixtures } from "@regulait/shared";

export type CheckLevel = "PASS" | "WARN" | "FAIL";
export interface DemoCheck {
  beat: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

type Json = Record<string, any>;

export async function runDemoCheck(
  app: FastifyInstance,
  opts: { bootstrapToken: string; fixtures?: DemoIntakeFixtures | null },
): Promise<DemoCheck[]> {
  const out: DemoCheck[] = [];
  const add = (beat: string, level: CheckLevel, detail: string, fix?: string) =>
    out.push({ beat, level, detail, ...(fix ? { fix } : {}) });
  const boot = { authorization: `Bearer ${opts.bootstrapToken}` };
  const call = async (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) => {
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Json = {};
    try {
      body = res.json() as Json;
    } catch {
      /* empty */
    }
    return { status: res.statusCode, body };
  };

  // --- personas: the people the script logs in as ------------------------------------------
  const users: Json[] = (await call("GET", "/v1/users", boot)).body.users ?? [];
  const byEmail = (e: string) => users.find((u) => u.email === e);
  const ada = byEmail("admin@regulait.local");
  for (const [email, role] of [
    ["admin@regulait.local", "admin / reviewer (Ada)"],
    ["dana@regulait.local", "proposer (Dana)"],
    ["avery@regulait.local", "approver (Avery)"],
  ] as const) {
    const u = byEmail(email);
    if (!u) add("0 Personas", "FAIL", `${email} missing`, "run `seed` then `demo:intake`");
    else if (u.disabledAt) add("0 Personas", "FAIL", `${email} is deactivated`);
    else add("0 Personas", "PASS", `${role}: ${email}`);
  }
  if (!ada) return out;
  const key = await call("POST", `/v1/users/${ada.id}/keys`, boot, { name: "demo-check" });
  const auth = { authorization: `Bearer ${key.body.token}` };

  // --- 1 Discover: shadow AI ---------------------------------------------------------------
  const shadow = await call("GET", "/v1/shadow-ai/findings", auth);
  const findings: Json[] = shadow.body.findings ?? [];
  if (shadow.status !== 200) add("1 Shadow AI", "FAIL", `findings endpoint ${shadow.status}`);
  else if (findings.length === 0) add("1 Shadow AI", "FAIL", "no shadow-AI findings", "run `demo:intake` (it imports a synthetic export)");
  else add("1 Shadow AI", "PASS", `${findings.length} finding(s) to open the story with`);

  // --- 1 Intake assistant: the hero's answers must land on HIGH -----------------------------
  if (opts.fixtures) {
    const a = await call("POST", "/v1/use-cases/intake/assist", auth, opts.fixtures.hero.intake);
    if (a.status !== 200) add("1 Intake assistant", "FAIL", `assist ${a.status} ${a.body.error ?? ""}`);
    else {
      const tier = a.body.tier?.value;
      add(
        "1 Intake assistant",
        tier === "high" ? "PASS" : "WARN",
        `hero tier = ${JSON.stringify(tier)}; ${(a.body.frameworks ?? []).length} framework(s), ${(a.body.risks ?? []).length} risk(s) suggested`,
        tier === "high" ? undefined : "the script says HIGH — fix the hero's intake answers (G1)",
      );
    }
  } else {
    add("1 Intake assistant", "WARN", "no fixtures loaded — hero answers not checked");
  }

  // --- 1/2 Register: use cases, 360, agent card ---------------------------------------------
  const ucs: Json[] = (await call("GET", "/v1/use-cases", auth)).body.useCases ?? [];
  const approved = ucs.filter((u) => u.status === "approved");
  const tiers = new Set(ucs.map((u) => u.euAiActTier).filter(Boolean));
  if (approved.length === 0) add("2 Register", "FAIL", "no approved use cases", "run `demo:intake`");
  else add("2 Register", tiers.size >= 3 ? "PASS" : "WARN", `${ucs.length} use cases, ${approved.length} approved, tiers: ${[...tiers].join(", ")}`);
  const showcase = approved.find((u) => u.euAiActTier === "high") ?? approved[0];
  if (showcase) {
    const ov = await call("GET", `/v1/use-cases/${showcase.id}/overview`, auth);
    add("2 Use-case 360", ov.status === 200 ? "PASS" : "FAIL", `overview of "${showcase.name}": ${ov.status}`);
    const agentId = (showcase.intendedAgentIds ?? [])[0];
    if (agentId) {
      const card = await call("GET", `/v1/agents/${agentId}/card`, auth);
      add("2 Agent card", card.status === 200 ? "PASS" : "FAIL", `card for its first agent: ${card.status}`);
    } else add("2 Agent card", "WARN", `"${showcase.name}" names no agents`);
  }

  // --- 2 Risks: inherent → residual with controls --------------------------------------------
  const risks: Json[] = (await call("GET", "/v1/risks", auth)).body.risks ?? [];
  const withResidual = risks.filter((r) => (r.controls ?? []).length > 0 && r.residualLikelihood);
  const placeholder = risks.filter((r) => /^Risk \d+$/.test(String(r.title)));
  if (risks.length === 0) add("2 Risks", "FAIL", "risk register is empty", "run `demo:intake`");
  else
    add(
      "2 Risks",
      withResidual.length && !placeholder.length ? "PASS" : "WARN",
      `${risks.length} risks; ${withResidual.length} with controls + residual; ${placeholder.length} placeholder titles`,
      placeholder.length ? "G1: replace 'Risk N' titles with real ones" : withResidual.length ? undefined : "G1: give mitigated risks controls and a residual",
    );

  // --- 3 Trust dashboard ----------------------------------------------------------------------
  const trust = await call("GET", "/v1/reports/trust", auth);
  if (trust.status !== 200) add("3 Trust dashboard", "FAIL", `trust ${trust.status}`);
  else {
    const dims: Json[] = trust.body.dimensions ?? [];
    const measured = dims.filter((d) => d.measured);
    add(
      "3 Trust dashboard",
      measured.length >= 4 ? "PASS" : "WARN",
      `${measured.length}/6 dimensions measured: ${dims.map((d) => `${d.key} ${d.evidenceCoveragePct ?? "–"}%`).join(", ")}`,
      measured.length >= 4 ? undefined : "activate the demo packs (`demo:setup` installs the licence)",
    );
  }

  // --- 3 Dependency graph: inherited exposure ---------------------------------------------------
  const graph = await call("GET", "/v1/inventory/graph", auth);
  if (graph.status !== 200) add("3 Dependency graph", "FAIL", `graph ${graph.status}`);
  else {
    const inherited = (graph.body.nodes as Json[]).filter(
      (n) => n.type === "use_case" && n.propagatedRisk?.sourceNodeKey && n.propagatedRisk.sourceNodeKey !== n.key,
    );
    add(
      "3 Dependency graph",
      inherited.length ? "PASS" : "WARN",
      inherited.length
        ? `${inherited.length} use case(s) inherit their rating, e.g. "${inherited[0]!.label}" (${inherited[0]!.propagatedRisk.band})`
        : `${graph.body.summary?.nodes} nodes, but no use case inherits a rating from a dependency`,
      inherited.length ? undefined : "G5: a vendor-only high risk on the hero's vendor",
    );
  }

  // --- 3 Monitor + remediation ------------------------------------------------------------------
  const ev = await call("POST", "/v1/governance/monitor/evaluate", auth);
  if (ev.status !== 200) add("3 Monitor", "FAIL", `evaluate ${ev.status}`);
  const alerts: Json[] = (await call("GET", "/v1/governance/alerts", auth)).body.alerts ?? [];
  if (!alerts.length) add("3 Monitor", "WARN", "no active alerts — the Monitor beat has nothing to show");
  else {
    const byRule: Record<string, number> = {};
    for (const a of alerts) byRule[a.ruleId] = (byRule[a.ruleId] ?? 0) + 1;
    add(
      "3 Monitor",
      alerts.length <= 15 ? "PASS" : "WARN",
      `${alerts.length} active: ${Object.entries(byRule).map(([k, n]) => `${k}×${n}`).join(", ")}`,
      alerts.length <= 15 ? undefined : "too many alerts for a clean story — give demo agents owners/model cards (G5)",
    );
    let executable = 0;
    for (const a of alerts.slice(0, 20)) {
      const r = await call("GET", `/v1/governance/alerts/${a.id}/remediation`, auth);
      executable += (r.body.candidates ?? []).filter((c: Json) => c.executable).length;
    }
    add(
      "3 Remediation",
      executable ? "PASS" : "WARN",
      `${executable} executable remediation candidate(s) across active alerts`,
      executable ? undefined : "no alert offers an approvable fix — the Respond beat needs one",
    );
  }

  // --- 3 Continuous trace evaluation ----------------------------------------------------------------
  await call("POST", "/v1/governance/trace-evaluations/run", auth);
  const te = await call("GET", "/v1/governance/trace-evaluations", auth);
  if (te.status !== 200) add("3 Trace evaluation", "FAIL", `trace evaluations ${te.status}`);
  else
    add(
      "3 Trace evaluation",
      te.body.totals?.evaluated ? "PASS" : "WARN",
      `${te.body.totals?.evaluated ?? 0} response(s) evaluated, ${te.body.totals?.flagged ?? 0} flagged, across ${(te.body.agents ?? []).length} agent(s)`,
      te.body.totals?.evaluated ? undefined : "no model traffic yet — run a few mock dispatches before the demo",
    );

  // --- 3 Regulatory intelligence -----------------------------------------------------------------
  const reg = await call("GET", "/v1/regulatory/updates", auth);
  if (reg.status !== 200) add("3 Regulatory", "FAIL", `regulatory ${reg.status}`);
  else
    add(
      "3 Regulatory",
      reg.body.summary?.total ? "PASS" : "WARN",
      reg.body.summary?.total
        ? `${reg.body.summary.total} entries, ${reg.body.summary.withControlGaps} with control gaps`
        : "feed not loaded",
      reg.body.summary?.total ? undefined : "G4 (and the index export)",
    );

  // --- 2 Deploy gate (ADR-0161): a pipeline asks before shipping ----------------------------------
  if (showcase) {
    const g = await call("POST", "/v1/gates/deploy", auth, { useCaseId: showcase.id, environment: "demo-check", ref: "demo-check" });
    if (g.status !== 200) add("2 Deploy gate", "FAIL", `gate ${g.status} ${g.body.error ?? ""}`);
    else {
      const blocks = (g.body.reasons ?? []).filter((r: Json) => r.severity === "block");
      add(
        "2 Deploy gate",
        "PASS",
        `"${showcase.name}": ${g.body.decision}` +
          (blocks.length ? ` — ${blocks.map((r: Json) => r.code).join(", ")}` : "") +
          ` (${(g.body.reasons ?? []).length - blocks.length} warning(s))`,
      );
    }
  }

  // --- approvals queue (the gate beat) ------------------------------------------------------------
  const inbox = await call("GET", "/v1/approvals?status=pending", auth);
  add("2 Approval gate", inbox.status === 200 ? "PASS" : "FAIL", `approvals queue reachable (${inbox.status})`);

  return out;
}

export function formatDemoCheck(checks: DemoCheck[]): string {
  const lines = checks.map((c) => `${c.level.padEnd(4)}  ${c.beat.padEnd(20)} ${c.detail}${c.fix ? `\n${" ".repeat(27)}→ ${c.fix}` : ""}`);
  const n = (l: CheckLevel) => checks.filter((c) => c.level === l).length;
  lines.push("", `${n("PASS")} pass, ${n("WARN")} warn, ${n("FAIL")} fail`);
  return lines.join("\n");
}
