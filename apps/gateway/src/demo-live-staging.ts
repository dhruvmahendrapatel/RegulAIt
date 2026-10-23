/**
 * `demo:prepare --live` (owner decision on #453, finding #4 of the #522 deep scan): the live database's only seeded
 * deploy target is the seed's `demo-deploy` (production), and the dataset's `acme-staging` target comes only from
 * demo:shadow, which `--live` skips. The S3 remediation states `staging`, an environment a remediation may name only once
 * a deploy target or an assignment rule gives it a meaning (allowedRemediationEnvironments), so without this target the
 * scripted "Start and link" is refused with environment_not_allowed.
 *
 * The target is a MOCK (it never reaches a cloud), created through the real admin route, which audits the create
 * (`deploy-target-created`). Idempotent by name. A target of that name that is not the mock is refused, never reused.
 * `demo:check --live` asserts that `staging` is an accepted remediation environment.
 */
type Json = Record<string, any>;
type Call = (method: "GET" | "POST", url: string, payload?: unknown) => Promise<{ status: number; body: Json }>;

/** the environment the S3 remediation and the `demo:gate` beat name */
export const DEMO_REMEDIATION_ENVIRONMENT = "staging";

/** a name distinct from the dataset's `acme-staging`, which `demo:check --live` treats as a trace of the fictional dataset */
export const DEMO_LIVE_STAGING_TARGET = { name: "demo-staging", provider: "mock", mode: "hosted", environment: DEMO_REMEDIATION_ENVIRONMENT } as const;

export async function ensureLiveStagingTarget(call: Call): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  const t = DEMO_LIVE_STAGING_TARGET;
  const list = await call("GET", "/v1/deploy/targets");
  if (list.status !== 200) return { ok: false, error: `deploy targets answered ${list.status}` };
  const existing = ((list.body.targets ?? []) as Json[]).find((x) => x.name === t.name);
  if (existing) {
    if (existing.provider !== t.provider || existing.environment !== t.environment) {
      return {
        ok: false,
        error: `deploy target '${t.name}' exists as ${existing.provider} (${existing.environment ?? "no environment"}), not the ${t.provider} ${t.environment} target: remove it or rebuild with \`demo:prepare --live\` on an empty database`,
      };
    }
    return { ok: true, note: `deploy target '${t.name}' (${t.provider}, ${t.environment}) already present` };
  }
  const r = await call("POST", "/v1/deploy/targets", { ...t });
  if (r.status !== 201) return { ok: false, error: `deploy target '${t.name}': ${r.status} ${r.body.error ?? ""} ${r.body.detail ?? ""}`.trim() };
  return { ok: true, note: `deploy target '${t.name}' (${t.provider}, ${t.environment}) created` };
}
