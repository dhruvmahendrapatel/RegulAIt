/**
 * Strict-Transport-Security — ONE owner, and it is the gateway (ADR-0029
 * amendment 2026-08-01; introduced unconditionally by ADR-0031 item 5).
 *
 * ## Why the gateway owns it rather than the edge
 *
 * `infra/caddy/Caddyfile` deliberately does not set this header, and for a
 * while its comment claimed that meant HSTS was OFF. It was not: the gateway
 * had been setting `max-age=31536000; includeSubDomains` on every secure
 * response since ADR-0031, so the deployed box announced a one-year pin while
 * the ADR argued at length that it must not. Two layers disagreeing about a
 * non-revocable browser commitment is the defect; which layer wins is the
 * lesser question.
 *
 * The gateway wins for the same reason ADR-0031 put CSP here: Caddy is *our
 * dev stack*, not the product. The gateway is what ships — into BYOC and
 * air-gapped installs (ADR-0015) that terminate TLS on somebody else's
 * nginx/ALB/Ingress, or on a real domain where HSTS is plainly correct. A
 * security posture that lives only in a Caddyfile we happen to run is a
 * posture those deployments silently do not get.
 *
 * ## Why an env var and NOT org_settings
 *
 * The standing mandate is "admins get options wherever a choice is feasible"
 * (ADR-0021), and this looked like a candidate. It is not, for three reasons:
 *
 *  1. **It is a deployment-shape fact, not an org policy.** Whether HSTS is
 *     safe here depends on whether the hostname is stable, whether a
 *     plain-HTTP recovery path is still needed, and who terminates TLS. An
 *     admin clicking a toggle in the portal cannot know whether the box's
 *     address is elastic. `REGULAIT_TRUSTED_PROXIES` (ADR-0031) is the exact
 *     precedent: same category, same home.
 *  2. **Every other org_settings toggle is reversible next request; this one
 *     is not.** HSTS is stored *in the visitor's browser*. A mis-click cannot
 *     be undone from the server — it can only be shortened for visitors who
 *     come back over HTTPS. Putting a non-revocable client-side commitment
 *     behind a self-service toggle is a footgun the mandate does not ask for.
 *  3. **It would depend on the database.** `loadOrgSettings` is a select per
 *     consultation; this header is set in the `onSend` hook that runs on every
 *     response, including `/health` and error responses that must still work
 *     when Postgres is down. A security header that disappears during an
 *     outage is worse than one that is simply configured.
 *
 * ## The setting
 *
 *   REGULAIT_HSTS unset        -> `max-age=31536000` — one year, no
 *                                 includeSubDomains, no preload (ADR-0181).
 *   REGULAIT_HSTS=off|none|""  -> no header at all.
 *   REGULAIT_HSTS=<value>      -> that exact value, e.g. a host whose name may
 *                                 change hands relaxes to `max-age=86400`.
 *
 * A malformed value throws at boot rather than being silently dropped. A
 * browser ignores a malformed HSTS header, so the quiet failure mode is
 * "operator believes they have HSTS and does not" — precisely the confusion
 * this module exists to end. `max-age=0` is valid and is the documented way to
 * actively *unpin* visitors, so there is a valid string for every intent.
 *
 * ## Why one year by default (ADR-0181), and no includeSubDomains
 *
 * ADR-0181 makes every default the strict one, relaxable by the operator. A
 * year is the conventional full-strength value: it defends a returning user's
 * session cookie against an active downgrade for as long as they keep coming
 * back. The earlier one-day default took the conservative rung of a ramp; an
 * operator now takes that rung explicitly where it is needed.
 *
 * Where it is needed is a host whose name can change hands. The dev stack is
 * the example: ADR-0032 attached an Elastic IP, so `<dashed-ip>.sslip.io` is
 * stable across the nightly power cycle, but `terraform destroy` releases the
 * EIP, and a re-created one is a *different* address, so `3.229.246.126` can
 * return to the AWS pool and land with an unrelated customer, who would
 * inherit our hostname *and* our pin. Such a host sets
 * `REGULAIT_HSTS=max-age=86400` (one day) or `off`; the boot log prints the
 * effective value either way.
 *
 * `includeSubDomains` is off by default because we serve no subdomains — it
 * buys this deployment exactly nothing — and because sslip.io resolves *any*
 * label prefix (`anything.3-229-246-126.sslip.io` -> 3.229.246.126), so the
 * flag claims a whole namespace that follows the IP to its next owner. Note
 * what it does NOT do, since ADR-0029 overstated this: HSTS is scoped to the
 * exact host, so `includeSubDomains` here covers subdomains *of this name* and
 * has no effect whatsoever on `sslip.io` itself or on any other
 * `a-b-c-d.sslip.io`. The externality is real but narrow.
 *
 * `preload` is never set by default and would additionally require manual
 * submission to the browser preload list — a commitment measured in months of
 * browser release trains and effectively irreversible. An operator on a domain
 * they own can ask for it; nothing here does it for them.
 */

export const HSTS_ENV = "REGULAIT_HSTS";

/** One year, host-scoped, no preload (ADR-0181). See the module header. */
export const DEFAULT_HSTS = "max-age=31536000";

const OFF = new Set(["", "off", "none", "false", "0", "no", "disabled"]);

/** `max-age=<digits>` followed by any number of `; includeSubDomains|preload` */
const HSTS_SYNTAX = /^max-age=\d+(\s*;\s*(includesubdomains|preload))*$/i;

/**
 * The Strict-Transport-Security value this process will send on genuinely
 * secure responses, or `null` for "send nothing".
 *
 * @throws if the configured value is not a syntactically valid HSTS header.
 */
export function resolveHsts(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[HSTS_ENV];
  if (raw === undefined) return DEFAULT_HSTS;
  const trimmed = raw.trim();
  if (OFF.has(trimmed.toLowerCase())) return null;
  if (!HSTS_SYNTAX.test(trimmed)) {
    throw new Error(
      `${HSTS_ENV}=${JSON.stringify(raw)} is not a valid Strict-Transport-Security value. ` +
        `Expected "max-age=<seconds>" with optional "; includeSubDomains" and/or "; preload", ` +
        `or "off" to send no header. A browser silently ignores a malformed value, so this ` +
        `fails loudly instead of pretending HSTS is on.`,
    );
  }
  return trimmed;
}

/** one line an operator can read in the boot log to know what browsers get pinned to */
export function describeHsts(value: string | null): string {
  if (value === null) {
    return `HSTS is OFF (${HSTS_ENV}=off). Browsers will not be pinned to HTTPS for this host.`;
  }
  const notes: string[] = [];
  if (/preload/i.test(value)) {
    notes.push(
      "PRELOAD is requested — this is effectively irreversible once submitted; only do this on a domain you will keep",
    );
  }
  if (/includesubdomains/i.test(value)) {
    notes.push("includeSubDomains extends the pin to every subdomain of this exact host");
  }
  const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1] ?? "0");
  if (maxAge > 86400) {
    notes.push(
      `max-age is ${maxAge}s (~${Math.round(maxAge / 86400)}d) — non-revocable from the server; only visitors who return over HTTPS can be shortened`,
    );
  }
  const suffix = notes.length > 0 ? ` [${notes.join("; ")}]` : "";
  return `HSTS on secure responses: ${value}${suffix}`;
}
