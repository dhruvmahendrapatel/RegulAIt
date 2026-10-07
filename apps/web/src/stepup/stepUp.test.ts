/**
 * ADR-0186 A — the browser half of step-up: `withStepUp` retries the SAME call
 * with the grant, collects one grant per action for a write that needs two,
 * and never loops; the prompt store; the header-carrying request helper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, STEP_UP_HEADER } from "../api/client";
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
