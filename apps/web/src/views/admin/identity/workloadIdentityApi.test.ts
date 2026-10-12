import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../../api/client";
import { subscribeStepUpPrompt } from "../../../stepup/stepUp";
import {
  addIdentityCredential,
  createWorkloadIdentity,
  listRunDelegationTree,
  listWorkloadIdentities,
  replaceIdentityGrants,
  revokeDelegationGrant,
  revokeIdentityCredential,
  revokeWorkloadIdentity,
  updateWorkloadIdentity,
} from "./workloadIdentityApi";
import type { PutAgentGrants } from "./workloadIdentityModel";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stepUpRefusal = () =>
  new ApiError(403, { error: "step_up_required", actionKind: "identity_manage", methods: ["totp"], action: { kind: "identity_manage", body: { op: "x" } } });

let unsubscribe: (() => void) | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  unsubscribe?.();
  unsubscribe = null;
});
/** a mounted dialog that answers every prompt with one grant */
const answerStepUp = (token = "rgsu_1") => {
  unsubscribe = subscribeStepUpPrompt((p) => p?.finish(token));
};

describe("reads", () => {
  it("lists identities a page at a time, passing the cursor back verbatim", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ items: [], nextCursor: null });
    await listWorkloadIdentities(null);
    await listWorkloadIdentities("abc+/=");
    expect(get.mock.calls.map((c) => c[0])).toEqual(["/v1/workload-identities?limit=100", "/v1/workload-identities?limit=100&cursor=abc%2B%2F%3D"]);
  });
  it("reads every page of a run's tree, and says when the bound was reached", async () => {
    const page = (n: number, next: string | null) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `g${i}` })), edges: [], nextCursor: next });
    const get = vi.spyOn(api, "get").mockResolvedValueOnce(page(2, "c1")).mockResolvedValueOnce(page(1, null));
    const out = await listRunDelegationTree(U(7));
    expect(out.items).toHaveLength(3);
    expect(out.truncated).toBe(false);
    expect(get.mock.calls[0]![0]).toBe(`/v1/delegation-grants?runId=${U(7)}&limit=200`);
    expect(get.mock.calls[1]![0]).toBe(`/v1/delegation-grants?runId=${U(7)}&limit=200&cursor=c1`);

    get.mockReset().mockResolvedValue(page(200, "more"));
    expect((await listRunDelegationTree(U(7))).truncated).toBe(true);
    expect(get).toHaveBeenCalledTimes(5);
  });
  it("refuses a run id that is not a UUID before any request", async () => {
    const get = vi.spyOn(api, "get");
    await expect(listRunDelegationTree("../users")).rejects.toThrow(/could not be read/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("writes go through the identity_manage step-up and resend the same body", () => {
  it("PATCH: refused, confirmed, resent once with the grant", async () => {
    answerStepUp();
    const patch = vi.spyOn(api, "patchWithHeaders").mockRejectedValueOnce(stepUpRefusal()).mockResolvedValueOnce({ id: U(1) });
    await updateWorkloadIdentity(U(1), { status: "suspended" });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[0]).toEqual([`/v1/workload-identities/${U(1)}`, { status: "suspended" }, {}]);
    expect(patch.mock.calls[1]).toEqual([`/v1/workload-identities/${U(1)}`, { status: "suspended" }, { "x-regulait-step-up": "rgsu_1" }]);
    expect(Object.isFrozen(patch.mock.calls[1]![1])).toBe(true);
  });
  it("a cancelled step-up ends with the refusal, never a success", async () => {
    unsubscribe = subscribeStepUpPrompt((p) => p?.finish(null));
    const patch = vi.spyOn(api, "patchWithHeaders").mockRejectedValue(stepUpRefusal());
    await expect(updateWorkloadIdentity(U(1), { status: "active" })).rejects.toBeInstanceOf(ApiError);
    expect(patch).toHaveBeenCalledTimes(1);
  });
  it("PUT grants carries the revision read, in the body and If-Match", async () => {
    answerStepUp();
    const set: PutAgentGrants = { tools: [], servers: [], agents: [], connectors: [], roleIds: [U(5)], revision: 3 };
    const put = vi.spyOn(api, "putWithHeaders").mockResolvedValue({});
    await replaceIdentityGrants(U(1), set);
    expect(put).toHaveBeenCalledWith(`/v1/workload-identities/${U(1)}/grants`, set, { "if-match": '"3"' });
  });
  it("PUT grants refuses a set with no revision rather than replacing blind", async () => {
    const put = vi.spyOn(api, "putWithHeaders");
    await expect(replaceIdentityGrants(U(1), { tools: [], servers: [], agents: [], connectors: [], roleIds: [], revision: -1 })).rejects.toThrow(/Reload/);
    expect(put).not.toHaveBeenCalled();
  });
  it("S6 writes: create, revoke, bind and revoke a credential, each resent once with the same frozen body", async () => {
    answerStepUp();
    const post = vi
      .spyOn(api, "postWithHeaders")
      .mockRejectedValueOnce(stepUpRefusal())
      .mockResolvedValue({ body: {}, headers: new Headers() } as never);
    await createWorkloadIdentity({ kind: "worker_runtime", sponsorUserIds: [U(1)], environments: ["dev"] });
    expect(post.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ["/v1/workload-identities", {}],
      ["/v1/workload-identities", { "x-regulait-step-up": "rgsu_1" }],
    ]);
    expect(Object.isFrozen(post.mock.calls[1]![1])).toBe(true);
    post.mockClear();
    await revokeWorkloadIdentity(U(2));
    await addIdentityCredential(U(2), { kind: "spiffe_id", spiffeId: "spiffe://example.org/w" });
    expect(post.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [`/v1/workload-identities/${U(2)}/revoke`, {}],
      [`/v1/workload-identities/${U(2)}/credentials`, { kind: "spiffe_id", spiffeId: "spiffe://example.org/w" }],
    ]);
    const del = vi.spyOn(api, "delWithHeaders").mockResolvedValue({});
    await revokeIdentityCredential(U(2), U(3));
    expect(del).toHaveBeenCalledWith(`/v1/workload-identities/${U(2)}/credentials/${U(3)}`, {}, undefined);
    await expect(revokeIdentityCredential(U(2), "../x")).rejects.toThrow(/could not be read/);
  });
  it("cascade revoke posts an empty body to the grant's revoke route", async () => {
    const post = vi.spyOn(api, "postWithHeaders").mockResolvedValue({ body: {}, headers: new Headers() } as never);
    await revokeDelegationGrant(U(9));
    expect(post).toHaveBeenCalledWith(`/v1/delegation-grants/${U(9)}/revoke`, {}, {});
  });
});
