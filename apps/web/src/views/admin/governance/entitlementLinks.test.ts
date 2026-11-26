import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { declareIdentifier, fetchApps, linkApp, pageQuery, removeIdentifier, unlinkApp } from "./entitlementLinksApi";
import { LINK_COPY, LINK_STATES, can, changeProblem, initialScreen, linksReducer, normaliseApps, normaliseIdentifiers, screenReducer, type EntitlementApp, type Flow } from "./entitlementLinksModel";

const res = (body: unknown, status = 200) => (status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const SRC = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const lifecycle = (state: string) => ({
  machine: "saas_app_agent_link",
  state,
  terminal: false,
  transitions: [
    { event: "auto_link", to: "auto", allowed: state === "none", by: ["system"], summary: "", ...(state === "none" ? {} : { reason: "only from none" }) },
    { event: "link", to: "admin", allowed: true, by: ["admin"], summary: "" },
    { event: "unlink", to: "unlinked", allowed: state === "auto" || state === "admin", by: ["admin"], summary: "", ...(state === "auto" || state === "admin" ? {} : { reason: "nothing is linked" }) },
  ],
});
const rawApp = (state = "none", over: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333", sourceId: SRC, externalId: "app-1", appKind: "service_principal", displayName: "Sample app", publisher: null, publisherVerified: null,
  agentId: state === "none" || state === "unlinked" ? null : AGENT, agentLinkState: state, firstSeenAt: "2026-11-20T00:00:00Z", lastSeenAt: "2026-11-22T00:00:00Z", grants: 3, lifecycle: lifecycle(state), ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("normalisers", () => {
  it("reads apps with their link and the transitions the server allows", () => {
    const out = normaliseApps({ items: [rawApp("auto")], nextAfter: "x", machine: {} });
    expect(out.nextAfter).toBe("x");
    const a = out.items[0]!;
    expect(a).toMatchObject({ agentLinkState: "auto", agentId: AGENT, grants: 3, publisher: null });
    expect(can(a, "unlink")).toEqual({ ok: true });
    expect(can(a, "auto_link")).toEqual({ ok: false, why: "only from none" });
  });

  it("a malformed answer is a failed read", () => {
    expect(() => normaliseApps({ items: [rawApp("manual")], nextAfter: null })).toThrow(/agentLinkState/);
    expect(() => normaliseApps({ items: [{ ...rawApp(), lifecycle: { transitions: [{ event: "link" }] } }], nextAfter: null })).toThrow(/allowed/);
    expect(() => normaliseApps({ nextAfter: null })).toThrow(/items/);
    expect(() => normaliseIdentifiers({ items: [{ id: "i", agentId: AGENT, platform: "okta", externalId: "x", createdAt: "t" }], nextAfter: null })).toThrow(/platform/);
  });

  it("only an exact identifier match is described as automatic, and an unlinked app says it is not relinked", () => {
    for (const s of LINK_STATES) expect(LINK_COPY[s].label.length).toBeGreaterThan(0);
    expect(LINK_COPY.auto.detail).toMatch(/exactly/);
    expect(LINK_COPY.unlinked.detail).toMatch(/not linked automatically again/);
  });
});

describe("linksReducer", () => {
  const app = normaliseApps({ items: [rawApp()], nextAfter: null }).items[0] as EntitlementApp;
  const idle: Flow = { phase: "idle" };

  it("will not send a link without an agent, or an identifier that is not a vendor app id", () => {
    expect(changeProblem({ kind: "link", app, agentId: "" })).toBe("Choose an agent.");
    expect(changeProblem({ kind: "declare", agentId: AGENT, externalId: "has space" })).toMatch(/no spaces/);
    expect(changeProblem({ kind: "declare", agentId: AGENT, externalId: "x".repeat(256) })).toMatch(/255/);
    const editing = linksReducer(idle, { type: "open", change: { kind: "link", app, agentId: "" } });
    expect(linksReducer(editing, { type: "submit" })).toBe(editing);
  });

  it("one change at a time; a failure keeps the form and can be tried again", () => {
    const e = linksReducer(idle, { type: "open", change: { kind: "link", app, agentId: AGENT } });
    const s = linksReducer(e, { type: "submit" });
    expect(s.phase).toBe("submitting");
    expect(linksReducer(s, { type: "open", change: { kind: "unlink", app } })).toBe(s);
    expect(linksReducer(s, { type: "cancel" })).toBe(s);
    const failed = linksReducer(s, { type: "failed", message: "boom" });
    expect(failed).toMatchObject({ phase: "failed", message: "boom" });
    expect(linksReducer(failed, { type: "submit" }).phase).toBe("submitting");
    const done = linksReducer(linksReducer(failed, { type: "submit" }), { type: "succeeded", autoLinked: 2 });
    expect(done).toMatchObject({ phase: "done", autoLinked: 2 });
    expect(linksReducer(idle, { type: "succeeded" })).toBe(idle);
  });
});

describe("screenReducer", () => {
  it("adds each list's next cursor once, and leaves the other list and the flow alone", () => {
    const s1 = screenReducer(initialScreen, { type: "more", list: "apps", after: "c1" });
    expect(s1.cursors).toEqual({ apps: [null, "c1"], ids: [null] });
    expect(screenReducer(s1, { type: "more", list: "apps", after: "c1" })).toBe(s1);
    expect(s1.flow).toBe(initialScreen.flow);
    expect(screenReducer(s1, { type: "dismiss" })).toBe(s1);
  });
});

describe("the calls", () => {
  it("lists one source's apps with only the params the strict query accepts", async () => {
    expect(pageQuery({ sourceId: SRC, after: null })).toBe(`sourceId=${SRC}&limit=50`);
    expect(pageQuery({ after: "a" })).toBe("after=a&limit=50");
    const fetchMock = vi.fn(async (_u: string) => res({ items: [], nextAfter: null, machine: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchApps(SRC, "c");
    expect(fetchMock.mock.calls[0]![0]).toBe(`/v1/discovery/entitlements/apps?sourceId=${SRC}&after=c&limit=50`);
  });

  it("links with the agent, unlinks with no body, and a refusal is an ApiError", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => res({}));
    vi.stubGlobal("fetch", fetchMock);
    await linkApp("app", AGENT);
    expect(fetchMock.mock.calls[0]![1].method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual({ agentId: AGENT });
    await unlinkApp("app");
    expect(fetchMock.mock.calls[1]![0]).toBe("/v1/discovery/entitlements/apps/app/agent-link");
    expect(fetchMock.mock.calls[1]![1].method).toBe("DELETE");
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "agent_retired", detail: "retired" }, 409)));
    await expect(linkApp("app", AGENT)).rejects.toBeInstanceOf(ApiError);
  });

  it("declaring answers how many apps it linked; removing takes a 204", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ identifier: { id: "i", agentId: AGENT, platform: "slack", externalId: "A1", createdByUserId: null, createdAt: "t" }, autoLinked: ["a", "b"], autoLinkedSources: [SRC] }, 201)));
    expect(await declareIdentifier({ agentId: AGENT, platform: "slack", externalId: "A1" })).toBe(2);
    vi.stubGlobal("fetch", vi.fn(async () => res(null, 204)));
    await expect(removeIdentifier("i")).resolves.toBeUndefined();
  });
});
