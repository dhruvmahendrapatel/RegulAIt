import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, STEP_UP_HEADER } from "../../../api/client";
import { catalogueQuery, fetchCatalogue, setPieceEnablement } from "./connectorCatalogueApi";

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stepUpRequired = () =>
  res({ error: "step_up_required", actionKind: "settings_relax", methods: ["totp"], action: { kind: "settings_relax", body: { connectorPiece: "slack" } } }, 403);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalogueQuery", () => {
  it("sends only what the strict query schema accepts", () => {
    expect(catalogueQuery({ q: "", offset: 0 })).toBe("limit=50&offset=0");
    expect(catalogueQuery({ q: "  sheets ", offset: 50.7 })).toBe("limit=50&offset=50&q=sheets");
    expect(catalogueQuery({ q: "a&b=c", offset: -1, limit: 10 })).toBe("limit=10&offset=0&q=a%26b%3Dc");
  });
});

describe("fetchCatalogue", () => {
  it("reads GET /v1/connector-catalogue with the filter and normalises the body", async () => {
    const fetchMock = vi.fn(async () => res({ runnable: true, curated: [], available: { total: 1, limit: 50, offset: 0, items: [{ key: "airtable" }] } }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchCatalogue({ q: "air", offset: 0 });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/v1/connector-catalogue?limit=50&offset=0&q=air");
    expect(out.available.items).toEqual([{ key: "airtable" }]);
    expect(out.available.source).toBeNull();
  });

  it("a failed read is an ApiError, not an empty catalogue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "forbidden" }, 403)));
    await expect(fetchCatalogue({ q: "", offset: 0 })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("setPieceEnablement", () => {
  it("enabling: refused for a step-up, asks, and resends the same body once with the grant", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const h = init.headers as Record<string, string>;
        return h[STEP_UP_HEADER] ? res({ piece: { key: "slack", status: "enabled" } }) : stepUpRequired();
      }),
    );
    const onStepUp = vi.fn();
    const ask = vi.fn(async () => "rgsu_1");
    const out = await setPieceEnablement("slack", { enabled: true, reason: "  Team alerts  " }, onStepUp, ask);
    expect(out).toEqual({ key: "slack", status: "enabled" });
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({ kind: "settings_relax", body: { connectorPiece: "slack" } }, ["totp"]);
    expect(calls.map((c) => c.url)).toEqual(["/v1/connector-catalogue/slack/enablement", "/v1/connector-catalogue/slack/enablement"]);
    expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([
      { enabled: true, reason: "Team alerts" },
      { enabled: true, reason: "Team alerts" },
    ]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[1]!.init.headers).toMatchObject({ "x-regulait-csrf": "1", [STEP_UP_HEADER]: "rgsu_1" });
  });

  it("a declined step-up rejects with the server's refusal and sends nothing more", async () => {
    const fetchMock = vi.fn(async () => stepUpRequired());
    vi.stubGlobal("fetch", fetchMock);
    const err = await setPieceEnablement("slack", { enabled: true, reason: "abc" }, () => undefined, async () => null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).payload.error).toBe("step_up_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disabling takes no step-up when the server asks none, and the key is path-encoded", async () => {
    const fetchMock = vi.fn(async () => res({ piece: { key: "a/b", status: "not_enabled" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onStepUp = vi.fn();
    await setPieceEnablement("a/b", { enabled: false, reason: "No longer used" }, onStepUp);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/v1/connector-catalogue/a%2Fb/enablement");
    expect(onStepUp).not.toHaveBeenCalled();
  });
});
