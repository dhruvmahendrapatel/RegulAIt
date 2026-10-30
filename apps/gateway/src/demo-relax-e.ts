/**
 * `pnpm --filter @regulait/gateway demo:relax-e`
 *
 * Beat E's audited demo-data relaxation (owner, #453 c6521685462; see demo-relax-e-lib.ts): on a demo gateway, the
 * sensitive-data approval quorum goes to 1 and approval signing to off, through `PUT /v1/org/settings`, with the
 * admin's step-up and the `org-settings-updated` audit row. Idempotent; refuses a gateway that is not a demo one.
 *
 * The seed applies it while the bootstrap credential can still give a step-up (first-admin setup). On a stack where an
 * admin can already step up (LIVE, prepared on 10-29), the bootstrap token is refused, so this command signs in as Ada
 * the way a person does, password then authenticator code, and steps up with a SECOND, newer authenticator code (the
 * gateway never accepts one code twice). It signs out at the end.
 *
 * Environment: REGULAIT_DEMO_RELAX_URL (default http://127.0.0.1:3000), REGULAIT_BOOTSTRAP_TOKEN, and, for the admin
 * path, REGULAIT_DEMO_ADMIN_PASSWORD (Ada's password; the codes are asked for on the terminal, never read from the
 * environment). Exits 0 when relaxed or already relaxed, 1 when it failed, 2 on a refusal or a missing admin.
 */
import { createInterface } from "node:readline/promises";
import { applyDemoERelaxation, type DemoERelaxResult, type GatewayCall } from "./demo-relax-e-lib.js";

const ADMIN_EMAIL = "admin@regulait.local";
const base = (process.env.REGULAIT_DEMO_RELAX_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const bootstrapToken = process.env.REGULAIT_BOOTSTRAP_TOKEN;
if (!bootstrapToken) {
  console.error("demo:relax-e: REGULAIT_BOOTSTRAP_TOKEN is not set");
  process.exit(2);
}

type Json = Record<string, any>;
const raw = async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    /* the status is the fact */
  }
  return { status: res.status, body: json, setCookie: res.headers.getSetCookie() };
};
const call: GatewayCall = async (method, url, headers, body) => {
  const { status, body: json } = await raw(method, url, headers, body);
  return { status, body: json };
};

const print = (r: DemoERelaxResult) => r.lines.forEach((l) => console.log(l));
const exitFor = (r: DemoERelaxResult) => (r.status === "relaxed" || r.status === "already" ? 0 : r.status === "failed" ? 1 : 2);

const first = await applyDemoERelaxation(call, { headers: { authorization: `Bearer ${bootstrapToken}` } });
if (first.status !== "needs_admin") {
  print(first);
  process.exit(exitFor(first));
}
const password = process.env.REGULAIT_DEMO_ADMIN_PASSWORD;
if (!password) {
  print(first);
  process.exit(2);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim();
// the browser sign-in's CSRF header (auth.ts CSRF_HEADER), as demo-identity.ts sends it
const csrf = { "x-regulait-csrf": "1" };
let session: Record<string, string> | null = null;
let exitCode = 2;
try {
  exitCode = await asAdmin();
} finally {
  rl.close();
  if (session) await raw("POST", "/auth/logout", session).catch(() => undefined);
}
process.exit(exitCode);

/** sign in as Ada (password, then a code), relax with a step-up (a second, newer code) */
async function asAdmin(): Promise<number> {
  const login = await raw("POST", "/auth/login", csrf, { identifier: ADMIN_EMAIL, password });
  if (login.status !== 200 || login.body.mfaRequired !== true || typeof login.body.pendingToken !== "string") {
    console.error(`demo:relax-e: sign-in as ${ADMIN_EMAIL} -> ${login.status}${login.body.mfaRequired ? "" : " (expected an authenticator step)"}`);
    return 2;
  }
  const code = await ask(`Authenticator code for ${ADMIN_EMAIL} (sign-in): `);
  const mfa = await raw("POST", "/auth/mfa/verify", csrf, { pendingToken: login.body.pendingToken, code });
  const cookie = mfa.setCookie.map((c) => /^regulait_session=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (mfa.status !== 200 || !cookie) {
    console.error(`demo:relax-e: authenticator code -> ${mfa.status} ${String(mfa.body.error ?? "")}`);
    return 2;
  }
  const asAda = { ...csrf, cookie: `regulait_session=${cookie}` };
  session = asAda;
  const result = await applyDemoERelaxation(call, {
    headers: asAda,
    stepUp: async (action) => {
      const options = await raw("POST", "/v1/auth/step-up/options", asAda, { action });
      if (options.status !== 200 || typeof options.body.stepUpId !== "string") {
        console.error(`demo:relax-e: step-up options -> ${options.status} ${String(options.body.error ?? "")}`);
        return null;
      }
      const next = await ask("Step-up: wait for your authenticator to show a NEW code (it never accepts one twice), then enter it: ");
      const verified = await raw("POST", "/v1/auth/step-up/verify", asAda, { stepUpId: options.body.stepUpId, method: "totp", code: next });
      if (verified.status !== 200 || typeof verified.body.stepUpToken !== "string") {
        console.error(`demo:relax-e: step-up -> ${verified.status} ${String(verified.body.error ?? "")}`);
        return null;
      }
      return verified.body.stepUpToken;
    },
  });
  print(result);
  return exitFor(result);
}
