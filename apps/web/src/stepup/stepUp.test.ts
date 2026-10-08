/**
 * ADR-0186 A — the browser half of step-up: `withStepUp` retries the SAME call
 * with the grant, collects one grant per action for a write that needs two,
 * and never loops; the prompt store; the header-carrying request helper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, STEP_UP_HEADER, setUnauthorizedHandler } from "../api/client";
import { api, promptStepUp, stepUpRefusalOf, subscribeStepUpPrompt, withStepUp, type StepUpAction } from "./stepUp";

const refusal = (action: StepUpAction, methods = ["passkey"]) =>
  new ApiError(403, { error: "step_up_required", actionKind: action.kind, methods, action });
const OWNER: StepUpAction = { kind: "owner_change", body: { objectType: "mcp_server", objectId: "s1", ownerUserId: "u2" } };
const RELAX: StepUpAction = { kind: "settings_relax", body: { values: { stepUpMaxAgeSeconds: 300 } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("withStepUp", () => {
  it("steps up once and resends the same call with the grant", async () => {
    const seen: Array<Record<string, string>> = [];
    const ask = vi.fn(async () => "rgsu_one");
    const out = await withStepUp(async (h) => {
      seen.push(h);
      if (!h[STEP_UP_HEADER]) throw refusal(OWNER);
      return "done";
    }, ask);
    expect(out).toBe("done");
    expect(seen).toEqual([{}, { [STEP_UP_HEADER]: "rgsu_one" }]);
    expect(ask).toHaveBeenCalledWith(OWNER, ["passkey"]);
  });

  it("a write needing two step-ups carries both grants", async () => {
    const ask = vi.fn(async (a: StepUpAction) => (a.kind === "break_glass" ? "rgsu_bg" : "rgsu_relax"));
    const BG: StepUpAction = { kind: "break_glass", body: { breakGlassUserIds: ["u1"] } };
    const seen: string[] = [];
    await withStepUp(async (h) => {
      const sent = h[STEP_UP_HEADER] ?? "";
      seen.push(sent);
      if (!sent.includes("rgsu_bg")) throw refusal(BG);
      if (!sent.includes("rgsu_relax")) throw refusal(RELAX);
      return null;
    }, ask);
    expect(seen).toEqual(["", "rgsu_bg", "rgsu_bg, rgsu_relax"]);
  });

  it("never loops: the same action refused again after its grant ends with the refusal", async () => {
    const ask = vi.fn(async () => "rgsu_x");
    const call = vi.fn(async () => {
      throw refusal(OWNER);
    });
    await expect(withStepUp(call, ask)).rejects.toMatchObject({ status: 403 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("no methods (an API key), a cancelled prompt, or any other error ends at once", async () => {
    const ask = vi.fn(async () => null);
    await expect(withStepUp(async () => { throw refusal(OWNER, []); }, ask)).rejects.toMatchObject({ status: 403 });
    expect(ask).not.toHaveBeenCalled();
    await expect(withStepUp(async () => { throw refusal(OWNER); }, ask)).rejects.toMatchObject({ status: 403 });
    expect(ask).toHaveBeenCalledTimes(1);
    await expect(withStepUp(async () => { throw new ApiError(409, { error: "conflict" }); }, ask)).rejects.toMatchObject({ status: 409 });
    expect(stepUpRefusalOf(new ApiError(422, { error: "step_up_unavailable" }))).toBeNull();
  });
});

describe("the prompt store", () => {
  it("with no dialog mounted a prompt resolves null; with one, the dialog settles it", async () => {
    expect(await promptStepUp(OWNER, ["totp"])).toBeNull();
    const seen: Array<string | null> = [];
    const off = subscribeStepUpPrompt((p) => {
      seen.push(p ? p.actionKind : null);
      if (p) queueMicrotask(() => p.finish("rgsu_from_dialog"));
    });
    try {
      expect(await promptStepUp(OWNER, ["totp"])).toBe("rgsu_from_dialog");
      expect(seen).toEqual([null, "owner_change", null]);
    } finally {
      off();
    }
  });
});

describe("the header-carrying request helper", () => {
  it("a PATCH that finds the session gone hands it to the shared session-loss handler (PR #198 round 7)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 })));
    const lost = vi.fn();
    setUnauthorizedHandler(lost);
    try {
      const err = await api.patch("/v1/rules/approvals/r1", { quorum: 1 }, { [STEP_UP_HEADER]: "rgsu_t" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect(lost).toHaveBeenCalledTimes(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it("sends the CSRF and step-up headers and reports a refusal as ApiError", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "step_up_required" }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.del("/v1/auth/passkeys/p1", undefined, { [STEP_UP_HEADER]: "rgsu_t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ "x-regulait-csrf": "1", [STEP_UP_HEADER]: "rgsu_t" });
  });
});

describe("every step-up-protected write in the app goes through withStepUp (ADR-0186 A)", () => {
  it("no screen writes org settings (the settings PUT or a dedicated setting route) unwrapped; no screen calls an owner change or the hold override unwrapped; no screen edits an approval rule or removes a rule unwrapped; no screen changes agent stewardship or pads an approver pool unwrapped; no screen lifts or narrows a revocation unwrapped", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith(path.join("stepup", "stepUp.ts"))) continue;
      const src = readFileSync(f, "utf8");
      // the shared client's settings PUT would be refused for any relaxation, and nothing would resend it
      if (/api\.put(?:WithHeaders)?(?:<[^>]*>)?\(\s*["'`]\/v1\/org\/settings["'`]/.test(src)) offenders.push(`${f}: PUT /v1/org/settings`);
      // the dedicated setting routes that also need a settings_relax step-up for a relaxation
      const dedicated = src.match(
        /(?<![A-Za-z])api\.(?:put|post)(?:WithHeaders)?(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:org\/settings\/assurance-gate-mode|mrm\/enforcement|interception\/settings|policy-simulations\/settings|guardrails\/config)["'`]/g,
      );
      for (const m of dedicated ?? []) offenders.push(`${f}: ${m}`);
      // per-scope and halt-lifting relaxations: the execution mode, a per-object guardrail
      // override, a rule's deploy-mode scope, and releasing held evidence
      const scoped = src.match(
        /(?<![A-Za-z])api\.(?:put|post|patch)(?:WithHeaders)?(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:execution\/mode["'`]|guardrails\/config\/|rules\/[^"'`]*\/deploy-mode|retention-holds\/release|agents\/[^"'`]*\/unhalt|servers\/[^"'`]*\/tools\/[^"'`]*\/unhalt)/g,
      );
      for (const m of scoped ?? []) offenders.push(`${f}: ${m}`);
      // an approval rule's edit (a lower quorum, a wider pool) and a rule's removal loosen dual control (ADR-0180)
      const ruleWrites = src.match(/(?<![A-Za-z])api\.(?:patch|del)(?:<[^>]*>)?\(\s*["'`]\/v1\/rules\/(?:approvals\/|\$\{)/g);
      for (const m of ruleWrites ?? []) offenders.push(`${f}: ${m}`);
      // the Outlook recipient allow-list (adding a recipient widens where cards go)
      if (src.includes("outlookRecipientAllowList") && /api\.patch/.test(src) && !src.includes("withStepUp(")) {
        offenders.push(`${f}: outlookRecipientAllowList written without withStepUp`);
      }
      // B4S-01: the stewardship PATCH changes the accountable owner (owner_change) and can lift a suspension
      // (settings_relax), as can the agent lifecycle route
      const stewardship = src.match(
        /(?<![A-Za-z])api\.(?:patch|post)(?:<[^>]*>)?\(\s*["'`]\/v1\/agents\/\$\{[^}]+\}\/(?:stewardship["'`]|lifecycle)/g,
      );
      for (const m of stewardship ?? []) offenders.push(`${f}: ${m}`);
      // B4S-02 (owner principle): the writes that can pad an approver pool or take over an approver's identity —
      // a role assignment, admin grant, initial password, MFA clear, delegation, routing rule, SLA escalation and
      // group-to-role mapping
      const poolWrites = src.match(
        /(?<![A-Za-z])api\.post(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:users\/\$\{[^}]+\}\/(?:roles|admin|set-initial-password|mfa\/clear)["'`]|delegations["'`]|approvals\/(?:assignment-rules|sla-policies)["'`]|group-role-mappings["'`])/g,
      );
      for (const m of poolWrites ?? []) offenders.push(`${f}: ${m}`);
      // B4S-05: lifting a revocation (delete) or narrowing it to read_only gives an entitlement back
      const revocationWrites = src.match(
        /(?<![A-Za-z])api\.(?:del|patch)(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:revocations\/|users\/\$\{[^}]+\}\/revocations\/)/g,
      );
      for (const m of revocationWrites ?? []) offenders.push(`${f}: ${m}`);
      // G2: a team member added to a team that routes or claims approvals joins an approver pool
      const teamWrites = src.match(/(?<![A-Za-z])api\.post(?:<[^>]*>)?\(\s*["'`]\/v1\/teams\/\$\{[^}]+\}\/members/g);
      for (const m of teamWrites ?? []) offenders.push(`${f}: ${m}`);
      // B4S round 3: creating a user can create an admin (settings_relax, as the admin grant above)
      const userCreates = src.match(/(?<![A-Za-z])api\.post(?:<[^>]*>)?\(\s*["'`]\/v1\/users["'`]/g);
      for (const m of userCreates ?? []) offenders.push(`${f}: ${m}`);
      // PR #198 review round 4: lifting a stop or a quarantine asks for the same step-up as the grant
      const unStops = src.match(
        /(?<![A-Za-z])api\.(?:post|patch|del)(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:users\/\$\{[^}]+\}\/reactivate|agents\/\$\{[^}]+\}\/enabled|custom-model-providers\/\$\{[^}]+\}\/enabled|admission\/skills\/\$\{[^}]+\}\/admit|servers\/\$\{[^}]+\}\/admission\/clear|release-quarantine\/override|sod\/rules\/\$\{|abac\/policies\/\$\{[^}]+\}\/deactivate)/g,
      );
      for (const m of unStops ?? []) offenders.push(`${f}: ${m}`);
      const abacDeletes = src.match(/(?<![A-Za-z])api\.del(?:<[^>]*>)?\(\s*["'`]\/v1\/abac\/policies\/\$\{[^}]+\}["'`]/g);
      for (const m of abacDeletes ?? []) offenders.push(`${f}: ${m}`);
      // PR #198 review round 5: an SSO provider may name an approver role as its JIT default role, and ending a
      // live delegation can split one principal into two — both ask for settings_relax
      const round5 = src.match(
        /(?<![A-Za-z])api\.(?:post|del)(?:<[^>]*>)?\(\s*["'`]\/v1\/(?:auth\/(?:oidc|saml)-providers["'`]|delegations\/\$\{)/g,
      );
      for (const m of round5 ?? []) offenders.push(`${f}: ${m}`);
      // PR #198 review round 6: adding an authenticator app (like a passkey) needs passkey_manage once a method exists
      const credentialAdds = src.match(
        /(?<![A-Za-z])api\.post(?:<[^>]*>)?\(\s*["'`]\/auth\/totp\/enroll["'`]/g,
      );
      for (const m of credentialAdds ?? []) offenders.push(`${f}: ${m}`);
      // round 6 (finding 36 sweep): removing a guardrail override stricter than the org mode lowers it
      const overrideRemovals = src.match(/(?<![A-Za-z])api\.del(?:<[^>]*>)?\(\s*["'`]\/v1\/guardrails\/config\//g);
      for (const m of overrideRemovals ?? []) offenders.push(`${f}: ${m}`);
      // owner changes and the evidence-hold override have no screen today; one added later must use withStepUp
      for (const re of [/\/v1\/(?:servers|connectors|agents)\/\$\{[^}]+\}\/owner/, /x-regulait-evidence-hold-override/]) {
        if (re.test(src) && !src.includes("withStepUp(")) offenders.push(`${f}: ${re.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
