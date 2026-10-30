/**
 * Beat E's demo-data relaxation (owner, #453 c6521685462; demo-path QA PR #607 open item 1).
 *
 * On a clean demo stack Dana's `write_file` is REFUSED at queue time (`approval-quorum-unsatisfiable`) instead of being
 * queued for Avery, because two strict defaults meet the demo data:
 *  1. Dana is a member of `hipaa-project`, whose in-app-only classification makes every call of hers SENSITIVE
 *     (B4S-03 `caller_membership`), so it needs `tool_approval_sensitive_quorum` = 2 approvers, and the seeded rule
 *     names one (Avery);
 *  2. `approval_signature_mode` = passkey counts only approvers who already hold a passkey, and no seeded persona does.
 *
 * The owner's decision: fix the demo data, not the product defaults. This step relaxes exactly those two settings on a
 * demo gateway, THROUGH THE ADMIN API (`PUT /v1/org/settings`), so it gets what an admin's change gets: the
 * `settings_relax` step-up and the `org-settings-updated` audit row naming both keys under `relaxed`, old -> new. It
 * never writes the database.
 *
 * SCOPE. Both settings exist only org-wide today: the sensitive quorum is `max(rule quorum, org sensitive quorum)`
 * (an approval rule can raise it, never lower it), and the signature mode has no per-project or per-rule column. So
 * the narrowest scope the product allows is the demo stack's one org. Product defaults (BATCH4_STRICT_DEFAULTS) are
 * untouched; a fresh non-demo install stays strict.
 *
 * GUARD. It refuses unless the gateway shows it is a demo one, the same check `demo:enforce` makes
 * (demo-beat-switch.ts): lane L's `GET /v1/demo/beats` is deployed and the demo seed's personas exist.
 *
 * IDEMPOTENT. It reads the settings first and writes only the keys that differ; a second run writes nothing and
 * leaves no audit row.
 */
import { STEP_UP_HEADER } from "@regulait/shared";
import { DEMO_BEATS_ROUTE, ENFORCE_IT_BEAT_ID, demoTargetRefusal } from "./demo-beat-switch.js";
import type { DemoCheck } from "./demo-check-lib.js";

type Json = Record<string, any>;

/** the two org settings this step relaxes, and the values it sets */
export const DEMO_E_RELAXATIONS = Object.freeze({
  toolApprovalSensitiveQuorum: 1,
  approvalSignatureMode: "off",
} as const);
export type DemoERelaxationKey = keyof typeof DEMO_E_RELAXATIONS;

/** the audit rule id the relaxation is written under (org-settings.ts), with both keys in `detail.relaxed` */
export const DEMO_E_RELAX_AUDIT_RULE_ID = "org-settings-updated";

/** the demo:check beat label for E's prerequisites */
export const ENFORCE_BEAT = "E Enforce it";

export const ORG_SETTINGS_PATH = "/v1/org/settings";

/** one HTTP call to the gateway: the CLI binds it to fetch, the seed and the tests to `app.inject` */
export type GatewayCall = (
  method: "GET" | "PUT",
  url: string,
  headers: Record<string, string>,
  body?: unknown,
) => Promise<{ status: number; body: Json }>;

/** the keys whose stored value differs from the relaxation, with the value to set */
export function pendingDemoERelaxations(settings: Json | undefined): Partial<Record<DemoERelaxationKey, unknown>> {
  const out: Partial<Record<DemoERelaxationKey, unknown>> = {};
  for (const [k, v] of Object.entries(DEMO_E_RELAXATIONS) as Array<[DemoERelaxationKey, unknown]>) {
    if (settings?.[k] !== v) out[k] = v;
  }
  return out;
}

export type DemoERelaxResult =
  | { status: "already"; lines: string[] }
  | { status: "relaxed"; changed: DemoERelaxationKey[]; lines: string[] }
  /** not a demo gateway: nothing was written */
  | { status: "refused"; lines: string[] }
  /** the bootstrap credential cannot give the step-up (an admin can step up): an admin must make the change */
  | { status: "needs_admin"; lines: string[] }
  | { status: "failed"; lines: string[] };

export interface DemoERelaxOptions {
  /** the credential the calls carry: the bootstrap token, or a signed-in admin's session */
  headers: Record<string, string>;
  /**
   * Given the 403's `action`, prove the person and return a step-up token for it (the admin-session path), or null to
   * give up. Absent: a step-up refusal is reported, never retried.
   */
  stepUp?: (action: Json) => Promise<string | null>;
}

const isBootstrapStepUpRefusal = (status: number, body: Json) =>
  status === 403 &&
  body.error === "step_up_required" &&
  body.actionKind === "settings_relax" &&
  body.credential === "bootstrap" &&
  Array.isArray(body.methods) &&
  body.methods.length === 0;

/** apply the two relaxations through the admin API; see the header */
export async function applyDemoERelaxation(call: GatewayCall, opts: DemoERelaxOptions): Promise<DemoERelaxResult> {
  const h = opts.headers;
  const beats = await call("GET", DEMO_BEATS_ROUTE, h);
  if (beats.status !== 200 && beats.status !== 404) {
    return { status: "refused", lines: [`REFUSED  GET ${DEMO_BEATS_ROUTE} -> ${beats.status}: cannot show this is a demo gateway. Nothing was changed.`] };
  }
  const users = await call("GET", "/v1/users", h);
  const emails = ((users.body.users ?? []) as Json[]).map((u) => String(u.email ?? ""));
  const refusal = demoTargetRefusal({ routeDeployed: beats.status === 200, simulated: false }, emails);
  if (refusal) return { status: "refused", lines: [`REFUSED  ${refusal}. Nothing was changed.`] };

  const read = await call("GET", ORG_SETTINGS_PATH, h);
  if (read.status !== 200) return { status: "failed", lines: [`GET ${ORG_SETTINGS_PATH} -> ${read.status}`] };
  const pending = pendingDemoERelaxations(read.body.settings as Json | undefined);
  const keys = Object.keys(pending) as DemoERelaxationKey[];
  if (keys.length === 0) {
    return { status: "already", lines: [`beat E: already relaxed (${describeRelaxations()}); nothing written`] };
  }

  let res = await call("PUT", ORG_SETTINGS_PATH, h, pending);
  if (res.status === 403 && res.body.error === "step_up_required" && opts.stepUp && res.body.action) {
    const token = await opts.stepUp(res.body.action as Json);
    if (!token) return { status: "failed", lines: ["the step-up was not completed. Nothing was changed."] };
    res = await call("PUT", ORG_SETTINGS_PATH, { ...h, [STEP_UP_HEADER]: token }, pending);
  }
  if (isBootstrapStepUpRefusal(res.status, res.body)) {
    return {
      status: "needs_admin",
      lines: [
        "beat E: NOT relaxed. An admin on this stack can step up, so the bootstrap credential may not relax a setting.",
        "  Run `demo:relax-e` with REGULAIT_DEMO_ADMIN_PASSWORD set (it signs in as Ada and asks for two authenticator codes),",
        "  or, signed in as Ada on /ui/admin/organization: 'Approvers for calls on sensitive data' 1 and 'Tool-call approval",
        "  signature' off, then confirm the step-up (DEMO_RUNBOOK §7.3, row E).",
      ],
    };
  }
  if (res.status !== 200) {
    return { status: "failed", lines: [`PUT ${ORG_SETTINGS_PATH} -> ${res.status} ${String(res.body.error ?? "")}. Nothing was changed.`] };
  }
  const after = pendingDemoERelaxations(res.body.settings as Json | undefined);
  if (Object.keys(after).length > 0) {
    return { status: "failed", lines: [`PUT ${ORG_SETTINGS_PATH} answered 200 but ${Object.keys(after).join(", ")} still differ`] };
  }
  return {
    status: "relaxed",
    changed: keys,
    lines: [
      `RELAXED for beat E (demo data, owner #453): ${keys.map((k) => `${k} -> ${String(DEMO_E_RELAXATIONS[k])}`).join(", ")}. ` +
        `Org-wide (the product has no narrower scope); audited in /admin -> Audit (${DEMO_E_RELAX_AUDIT_RULE_ID}, "RELAXED from the strict default").`,
    ],
  };
}

function describeRelaxations(): string {
  return "sensitive-data approval quorum 1 and approval signing off (plain sign-off)";
}

/**
 * demo:check: can beat E queue Dana's write for Avery? Read-only. On the simulated fallback the queue never happens,
 * so the row only notes it; live, a strict quorum or passkey signing FAILs with the fix.
 */
export async function checkEnforceBeatPrereqs(get: (url: string) => Promise<{ status: number; body: Json }>): Promise<DemoCheck[]> {
  const fix = "run `pnpm --filter @regulait/gateway demo:relax-e` on this stack (DEMO_RUNBOOK §7.3, row E), then re-run demo:check";
  const beats = await get(DEMO_BEATS_ROUTE);
  const simulated = ((beats.body.beats ?? []) as Json[]).find((b) => b.beatId === ENFORCE_IT_BEAT_ID)?.mode === "simulated";
  const settings = await get(ORG_SETTINGS_PATH);
  if (settings.status !== 200) return [{ beat: ENFORCE_BEAT, level: "FAIL", detail: `org settings ${settings.status}` }];
  const s = (settings.body.settings ?? {}) as Json;
  const problems: string[] = [];
  if (s.toolApprovalSensitiveQuorum !== DEMO_E_RELAXATIONS.toolApprovalSensitiveQuorum) {
    problems.push(`sensitive-data approval quorum is ${String(s.toolApprovalSensitiveQuorum)} (Dana is on hipaa-project, the rule names one approver)`);
  }
  if (s.approvalSignatureMode === "passkey") problems.push("approval signing is passkey (no persona holds a passkey)");
  else if (s.approvalSignatureMode !== DEMO_E_RELAXATIONS.approvalSignatureMode) {
    problems.push(`approval signing is ${String(s.approvalSignatureMode)} (Avery would have to step up to decide; the owner chose plain sign-off)`);
  }
  if (problems.length === 0) {
    return [{ beat: ENFORCE_BEAT, level: "PASS", detail: "Dana's write_file can queue for Avery: quorum 1, plain sign-off (audited demo relaxation)" }];
  }
  if (simulated) {
    return [{ beat: ENFORCE_BEAT, level: "WARN", detail: `on its simulated fallback, so nothing queues; live it would be refused at queue time: ${problems.join("; ")}`, fix }];
  }
  return [{ beat: ENFORCE_BEAT, level: "FAIL", detail: `Dana's write_file would be REFUSED at queue time, not queued: ${problems.join("; ")}`, fix }];
}

