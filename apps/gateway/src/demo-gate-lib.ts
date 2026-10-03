/**
 * `demo:gate` — the deploy-gate beat (ADR-0161) as a pipeline step: ask
 * `POST /v1/gates/deploy` whether a use case may ship, print the decision and
 * every reason the way a CI log shows them, and exit 1 on DENY. It goes
 * through the same route a pipeline calls, as Ada (an admin; a pipeline would
 * use the use case owner's service account) — nothing here decides anything.
 */
import type { FastifyInstance } from "fastify";

type Json = Record<string, any>;

export interface DemoGateResult {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  lines: string[];
}

export async function runDemoGate(
  app: FastifyInstance,
  opts: { bootstrapToken: string; useCase: string; environment?: string; ref?: string },
): Promise<DemoGateResult> {
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
  const users: Json[] = (await call("GET", "/v1/users", boot)).body.users ?? [];
  const ada = users.find((u) => u.email === "admin@regulait.local");
  if (!ada) return { ok: false, exitCode: 2, lines: ["admin@regulait.local not found — run demo:prepare first"] };
  const token = (await call("POST", `/v1/users/${ada.id}/keys`, boot, { name: "demo-gate pipeline" })).body.token as string;
  const auth = { authorization: `Bearer ${token}` };

  const ucs: Json[] = (await call("GET", "/v1/use-cases", auth)).body.useCases ?? [];
  const needle = opts.useCase.toLowerCase();
  const uc = ucs.find((u) => String(u.name).toLowerCase() === needle) ?? ucs.find((u) => String(u.name).toLowerCase().includes(needle));
  if (!uc) {
    return { ok: false, exitCode: 2, lines: [`no use case matches "${opts.useCase}" — known: ${ucs.map((u) => u.name).join(", ")}`] };
  }
  const environment = opts.environment ?? "production";
  const ref = opts.ref ?? `demo-build-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  const r = await call("POST", "/v1/gates/deploy", auth, { useCaseId: uc.id, environment, ref });
  if (r.status !== 200) {
    return { ok: false, exitCode: 2, lines: [`deploy gate answered ${r.status}: ${r.body.error ?? ""} ${r.body.detail ?? ""}`.trim()] };
  }
  const reasons: Json[] = r.body.reasons ?? [];
  const lines = [
    `$ regulait gate deploy --use-case "${uc.name}" --env ${environment} --ref ${ref}`,
    "",
    `${r.body.decision === "allow" ? "ALLOW" : "DENY"}  "${uc.name}" (${uc.status}, EU AI Act tier ${uc.euAiActTier ?? "unscreened"}) → ${environment}`,
    ...reasons.map((x) => `  ${String(x.severity).toUpperCase().padEnd(5)} ${String(x.code).padEnd(24)} ${x.message}`),
    ...(reasons.length === 0 ? ["  (no reasons — every check clear)"] : []),
    "",
    r.body.decision === "allow"
      ? "pipeline continues (warnings do not fail the gate)"
      : "pipeline STOPPED — fix or acknowledge the blocking reasons, then re-run",
    `audited as deploy-gate-${r.body.decision === "allow" ? "allowed" : "denied"} (ref ${ref})`,
  ];
  return { ok: r.body.decision === "allow", exitCode: r.body.decision === "allow" ? 0 : 1, lines };
}
