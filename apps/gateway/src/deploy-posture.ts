/**
 * ADR-0062 — THE DEPLOYMENT-WIDE EGRESS POSTURE.
 *
 * ## The hole this closes
 *
 * The ADR-0034/0043 egress guard adjudicates **URLs a human typed**. Two call
 * sites say so outright, in the same words: *"NO OVERRIDE MEANS NO CHECK: with
 * baseUrl null the adapter uses its compiled vendor default, which no human can
 * type, so there is nothing to decide."* That is a complete answer to SSRF —
 * you cannot smuggle `169.254.169.254` into a constant — and it is the wrong
 * answer for an air-gapped deployment, where the question is not "could an
 * attacker choose this destination" but **"may this installation talk to that
 * vendor at all"**.
 *
 * Concretely (and this is recorded as a finding in
 * `docs/deployment/DATA_BOUNDARY.md` §4): on an air-gapped box, storing a
 * credential for a built-in provider — or merely exporting `ANTHROPIC_API_KEY`
 * — makes an agent invocation attempt the vendor's public API **carrying the
 * prompt**. Nothing in the application refuses it. Only the absence of a
 * network route stops it.
 *
 * ## Why the deployment mode is an ENV VAR and not an org_settings toggle
 *
 * `deployMode` exists in the schema today only on *deploy-target rows* — a
 * property of a thing a user creates. "Is this installation air-gapped" is not
 * that. It is a fact about the box, and it follows the
 * [ADR-0029 HSTS precedent](../../../docs/decisions/0029-zero-cost-tls-caddy-sslip-letsencrypt.md)
 * exactly, for the same three reasons HSTS was deliberately kept out of
 * `org_settings`:
 *
 *  1. **It is a deployment-shape fact, not an org policy.** Whether this box
 *     has a default route, sits in a disconnected enclave, or runs in the
 *     customer's own VPC is something the operator who installed it knows and
 *     an admin clicking a portal toggle does not. `REGULAIT_HSTS` and
 *     `REGULAIT_TRUSTED_PROXIES` are the exact precedent: same category, same
 *     home.
 *  2. **An admin must not be able to UNDO it from the portal.** An air-gapped
 *     posture that a compromised or merely mistaken admin account can switch
 *     off from a web form is not an air-gapped posture. The env var is the
 *     floor; `org_settings` may only build on top of it (see below).
 *  3. **It must not depend on the database being right.** The mode is read from
 *     the environment on every consultation and printed at boot, so an operator
 *     can see what this box will refuse without querying anything.
 *
 * ## The ceiling model (ADR-0021), applied
 *
 *   effective posture = STRICTEST( env-derived mode posture, org tightening )
 *
 * `org_settings.egressCompiledDefaultPolicy` is `strict` (DEFAULT since
 * ADR-0181, migration 0159) or `inherit`. So a fresh hosted or BYOC box is
 * strict, and an admin may relax it to `inherit` (audited old -> new on
 * PUT /v1/org/settings). An admin **cannot** make an air-gapped box permissive
 * — there is no value that loosens, by construction rather than by validation.
 *
 * ADR-0181 and the deploy mode: the mode is the env FLOOR and stays
 * `hosted` when unset. Making the floor strict for hosted/BYOC would put the
 * strict posture beyond an admin's reach (the floor cannot be loosened from
 * the portal), and ADR-0181 requires every strict default to stay relaxable.
 * So the security half of the mode default lives in the org default above: a
 * fresh install of any mode adjudicates compiled vendor endpoints.
 *
 * ## The posture per mode, and why `byoc` is permissive by default
 *
 *   hosted      permissive   the default for every existing deployment, so an
 *                            upgrade changes nothing anywhere.
 *   byoc        permissive   BYOC has internet ON PURPOSE. DATA_BOUNDARY §5
 *                            says so in as many words: "configured
 *                            connectors/models/MCP/PM reach their real
 *                            endpoints. That is the point of the mode." Making
 *                            it strict by default would break every existing
 *                            BYOC install's built-in providers on upgrade, to
 *                            enforce a claim that mode never made. A BYOC
 *                            operator who wants the stricter posture sets
 *                            `egressCompiledDefaultPolicy: "strict"`, or the
 *                            env var — both are one line.
 *   air_gapped  STRICT       the mode whose entire promise is that nothing
 *                            leaves. This is the change.
 *
 * A malformed `REGULAIT_DEPLOY_MODE` throws at boot rather than falling back to
 * `hosted`. The quiet failure mode of a typo'd mode is an operator who believes
 * their box is air-gapped and is running the permissive posture — precisely the
 * confusion this module exists to end. (Same reasoning, same shape, as
 * `resolveHsts` throwing on a malformed HSTS value.)
 */

export const DEPLOY_MODE_ENV = "REGULAIT_DEPLOY_MODE";

export const DEPLOY_MODES = ["hosted", "byoc", "air_gapped"] as const;
export type DeployMode = (typeof DEPLOY_MODES)[number];

/** The default is `hosted` so an upgrade is byte-identical everywhere. */
export const DEFAULT_DEPLOY_MODE: DeployMode = "hosted";

/**
 * `permissive` — today's behaviour: a compiled vendor default is not
 * adjudicated at all, and the adapter keeps the global fetch.
 * `strict` — a dispatch whose adapter would use its compiled vendor default is
 * REFUSED unless that host is in the `egress_allow_hosts` table.
 */
export type EgressPosture = "permissive" | "strict";

/** The `org_settings` tightening dial. It can only ever raise the floor. */
export const EGRESS_COMPILED_DEFAULT_POLICIES = ["inherit", "strict"] as const;
export type EgressCompiledDefaultPolicy = (typeof EGRESS_COMPILED_DEFAULT_POLICIES)[number];

export function isDeployMode(value: string): value is DeployMode {
  return (DEPLOY_MODES as readonly string[]).includes(value);
}

/**
 * The deployment mode this process is running as.
 *
 * @throws if the variable is set to something that is not a mode. See the
 * module header: a typo must not silently degrade to `hosted`.
 */
export function resolveDeployMode(env: NodeJS.ProcessEnv = process.env): DeployMode {
  const raw = env[DEPLOY_MODE_ENV];
  if (raw === undefined) return DEFAULT_DEPLOY_MODE;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return DEFAULT_DEPLOY_MODE;
  // accept the hyphenated spelling an operator is likely to type
  const normalized = trimmed === "air-gapped" ? "air_gapped" : trimmed;
  if (!isDeployMode(normalized)) {
    throw new Error(
      `${DEPLOY_MODE_ENV}=${JSON.stringify(raw)} is not a deployment mode. ` +
        `Expected one of ${DEPLOY_MODES.join(" | ")}. This fails loudly rather than ` +
        `defaulting to '${DEFAULT_DEPLOY_MODE}', because the quiet failure mode is an ` +
        `operator who believes this box is air-gapped while it is running the permissive posture.`,
    );
  }
  return normalized;
}

/** The posture a mode implies on its own, before any org tightening. */
export function modeEgressPosture(mode: DeployMode): EgressPosture {
  return mode === "air_gapped" ? "strict" : "permissive";
}

/** MAX over the posture lattice: `strict` beats `permissive`, always. */
export function strictestPosture(a: EgressPosture, b: EgressPosture): EgressPosture {
  return a === "strict" || b === "strict" ? "strict" : "permissive";
}

/**
 * THE ONE COMPOSITION RULE — effective = strictest(env mode, org tightening).
 *
 * Note what is NOT here: there is no branch by which `orgPolicy` can produce
 * `permissive` from a `strict` mode. The ceiling holds because the lattice has
 * no downward edge, not because some validation refuses the write.
 */
export function resolveEgressPosture(args: {
  mode: DeployMode;
  orgPolicy?: EgressCompiledDefaultPolicy | null;
}): EgressPosture {
  const fromOrg: EgressPosture = args.orgPolicy === "strict" ? "strict" : "permissive";
  return strictestPosture(modeEgressPosture(args.mode), fromOrg);
}

/** One line an operator can read in the boot log to know what this box refuses.
 * With `orgPolicy` it describes the EFFECTIVE posture (mode floor + org
 * tightening), which is what the boot line prints since ADR-0181. */
export function describeEgressPosture(mode: DeployMode, orgPolicy?: EgressCompiledDefaultPolicy | null): string {
  if (orgPolicy !== undefined && modeEgressPosture(mode) === "permissive") {
    return resolveEgressPosture({ mode, orgPolicy }) === "strict"
      ? `deploy mode '${mode}', org egressCompiledDefaultPolicy='strict' (the default) — STRICT egress: a ` +
          `built-in provider/connector/git/PM adapter running on its COMPILED vendor endpoint is refused unless ` +
          `that host is in the egress allow-list`
      : `deploy mode '${mode}', org egressCompiledDefaultPolicy='inherit' — RELAXED: compiled vendor endpoints ` +
          `are NOT adjudicated (an admin relaxed the strict default; set it back to 'strict' to refuse them)`;
  }
  const posture = modeEgressPosture(mode);
  return posture === "strict"
    ? `deploy mode '${mode}' — STRICT egress: a built-in provider/connector/git/PM adapter running on its ` +
        `COMPILED vendor endpoint is refused unless that host is in the egress allow-list. ` +
        `org_settings cannot loosen this.`
    : `deploy mode '${mode}' — compiled vendor endpoints are NOT adjudicated (set ${DEPLOY_MODE_ENV}=air_gapped, ` +
        `or org_settings.egressCompiledDefaultPolicy='strict', to refuse them by default)`;
}
