/**
 * ADR-0361 — the connector contract and the pure helpers, without a database: the Graph Copilot export connector
 * against a fake Entra + Graph, the normaliser and text extraction, the run window, and scope widening.
 */
import { describe, expect, it } from "vitest";
import {
  adaptiveCardText,
  AI_SAAS_MONITOR_MAX_TEXT_CHARS,
  AI_SAAS_MONITOR_MAX_WINDOW_MS,
  AI_SAAS_MONITOR_MIN_WINDOW_MS,
  AI_SAAS_MONITOR_RUN_MACHINE,
  AI_SAAS_REMEDIATION_MACHINE,
  STATE_MACHINES,
  htmlToScanText,
  normalizeGraphInteraction,
  type GraphAiInteraction,
} from "@regulait/shared";
import { AI_SAAS_CONNECTORS, ConnectorError, M365_COPILOT_CONNECTOR, chatGptConfigWidens, claudeConfigWidens, m365ConfigWidens, m365InteractionsUrl, sameOriginNext, type ConnectorContext } from "./ai-saas-connectors.js";
import { cascadeLoosens, m365SetupGuide, monitorWindow, windowSpanMs } from "./ai-saas-monitor.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const USER_A = "9fcefe95-9677-483e-a3c1-22c5d501d737";
const USER_B = "4db02e4b-d144-400e-b194-53253a34c5be";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const prompt = (id: string, user: string, content: string): GraphAiInteraction => ({
  id,
  sessionId: "19:session@thread.v2",
  requestId: "req-1",
  appClass: "IPM.SkypeTeams.Message.Copilot.BizChat",
  interactionType: "userPrompt",
  conversationType: "bizchat",
  createdDateTime: "2026-11-16T10:00:00.000Z",
  from: { user: { id: user }, application: null },
  body: { contentType: "text", content },
  attachments: [],
});

/** a fake Entra (instance discovery, OIDC metadata, token) and Graph; `graph` answers graph.microsoft.com */
function fakeMicrosoft(roles: string[], graph: (url: URL) => Response) {
  const token = jwt({ roles, tid: TENANT });
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url.toString());
    if (url.hostname === "login.microsoftonline.com") {
      if (url.pathname.endsWith("/discovery/instance")) {
        return json({
          tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
          "api-version": "1.1",
          metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
        });
      }
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        return json({
          token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
          authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
          issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
          jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
        });
      }
      if (url.pathname.endsWith("/oauth2/v2.0/token")) return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: token });
    }
    if (url.hostname === "graph.microsoft.com") return graph(url);
    return json({ error: "unexpected host" }, 599);
  }) as typeof fetch;
  return { fetch: f, urls, token };
}

function ctxFor(fetchImpl: typeof fetch, config: Record<string, unknown>) {
  const secrets: string[] = [];
  const ctx: ConnectorContext = {
    config,
    credential: { secret: "client-secret-value" },
    fetch: fetchImpl,
    throttle: async () => undefined,
    backoff: async () => false,
    registerSecret: (v) => secrets.push(v),
    signal: new AbortController().signal,
  };
  return { ctx, secrets };
}

const listed = (ids: string[]) => ({ tenantId: TENANT, clientId: CLIENT, users: { mode: "listed", ids }, appClasses: [], backfillDays: 7 });
const window = { start: new Date("2026-11-16T00:00:00Z"), end: new Date("2026-11-17T00:00:00Z") };

async function collect(it: AsyncIterable<{ interactions: unknown[]; unit: string }>) {
  const pages: Array<{ interactions: unknown[]; unit: string }> = [];
  for await (const p of it) pages.push(p);
  return pages;
}

describe("ADR-0361 Graph Copilot connector", () => {
  it("authorises read-only with the documented permission and registers the token for scrubbing", async () => {
    const ms = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], () => json({ value: [] }));
    const { ctx, secrets } = ctxFor(ms.fetch, listed([USER_A]));
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    expect(auth.scope).toBe("read_only");
    expect(auth.permissions).toEqual(["AiEnterpriseInteraction.Read.All"]);
    expect(secrets).toContain(ms.token);
    expect(auth.headers.authorization).toBe(`Bearer ${ms.token}`);
  });

  it("refuses a credential that can write, before any Graph read", async () => {
    const ms = fakeMicrosoft(["AiEnterpriseInteraction.Read.All", "User.ReadWrite.All"], () => json({ value: [] }));
    const { ctx } = ctxFor(ms.fetch, listed([USER_A]));
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    expect(auth.scope).toBe("write");
    expect(auth.headers).toEqual({});
    expect(ms.urls.some((u) => new URL(u).hostname === "graph.microsoft.com")).toBe(false);
  });

  it("names a missing permission instead of reading", async () => {
    const ms = fakeMicrosoft(["User.Read.All"], () => json({ value: [] }));
    await expect(M365_COPILOT_CONNECTOR.authorise(ctxFor(ms.fetch, listed([USER_A])).ctx)).rejects.toMatchObject({ code: "missing_permission" });
    const all = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], () => json({ value: [] }));
    await expect(
      M365_COPILOT_CONNECTOR.authorise(ctxFor(all.fetch, { tenantId: TENANT, clientId: CLIENT, users: { mode: "all" }, appClasses: [], backfillDays: 7 }).ctx),
    ).rejects.toMatchObject({ code: "missing_permission", detail: expect.stringContaining("User.Read.All") });
  });

  it("reads each listed user's window with both createdDateTime bounds, following same-origin nextLinks", async () => {
    const seen: URL[] = [];
    const ms = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], (url) => {
      seen.push(url);
      if (url.pathname.includes(USER_A)) {
        if (url.searchParams.get("$skiptoken")) return json({ value: [prompt("2", USER_A, "second")] });
        return json({
          value: [prompt("1", USER_A, "first")],
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/copilot/users/${USER_A}/interactionHistory/getAllEnterpriseInteractions?$skiptoken=x`,
        });
      }
      return json({ value: [prompt("3", USER_B, "third")] });
    });
    const { ctx } = ctxFor(ms.fetch, listed([USER_A, USER_B]));
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    const pages = await collect(M365_COPILOT_CONNECTOR.listInteractions(ctx, auth, window));
    expect(pages.map((p) => [p.unit, p.interactions.length])).toEqual([[USER_A, 1], [USER_A, 1], [USER_B, 1]]);
    const first = seen[0]!;
    expect(first.pathname).toBe(`/v1.0/copilot/users/${USER_A}/interactionHistory/getAllEnterpriseInteractions`);
    expect(first.searchParams.get("$filter")).toBe("createdDateTime gt 2026-11-16T00:00:00.000Z and createdDateTime lt 2026-11-17T00:00:00.000Z");
    expect(first.searchParams.get("$top")).toBe("100");
  });

  it("refuses a nextLink to another origin and a repeated one", async () => {
    expect(() => sameOriginNext("https://graph.microsoft.com", "https://evil.example/v1.0/x")).toThrow(ConnectorError);
    expect(() => sameOriginNext("https://graph.microsoft.com", "http://graph.microsoft.com/v1.0/x")).toThrow(ConnectorError);
    expect(sameOriginNext("https://graph.microsoft.com", null)).toBeNull();
    const loop = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], () =>
      json({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/users/x/interactionHistory/getAllEnterpriseInteractions?$skiptoken=same" }),
    );
    const { ctx } = ctxFor(loop.fetch, listed([USER_A]));
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    await expect(collect(M365_COPILOT_CONNECTOR.listInteractions(ctx, auth, window))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("maps vendor errors to fixed codes with our own sentences, never the vendor's body", async () => {
    const ms = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], () => json({ error: { message: "SECRET-ECHO client-secret-value" } }, 403));
    const { ctx } = ctxFor(ms.fetch, listed([USER_A]));
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    const err = await collect(M365_COPILOT_CONNECTOR.listInteractions(ctx, auth, window)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("forbidden");
    expect((err as ConnectorError).detail).not.toContain("SECRET-ECHO");
    const shape = fakeMicrosoft(["AiEnterpriseInteraction.Read.All"], () => json({ value: [{ id: 5 }] }));
    const c2 = ctxFor(shape.fetch, listed([USER_A])).ctx;
    await expect(collect(M365_COPILOT_CONNECTOR.listInteractions(c2, await M365_COPILOT_CONNECTOR.authorise(c2), window))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("lists every user through /users only when configured to, and bounds it", async () => {
    const ms = fakeMicrosoft(["AiEnterpriseInteraction.Read.All", "User.Read.All"], (url) => {
      if (url.pathname === "/v1.0/users") return json({ value: [{ id: USER_A }, { id: USER_B }] });
      return json({ value: [] });
    });
    const { ctx } = ctxFor(ms.fetch, { tenantId: TENANT, clientId: CLIENT, users: { mode: "all" }, appClasses: [], backfillDays: 7 });
    const auth = await M365_COPILOT_CONNECTOR.authorise(ctx);
    const pages = await collect(M365_COPILOT_CONNECTOR.listInteractions(ctx, auth, window));
    expect(pages.map((p) => p.unit)).toEqual([USER_A, USER_B]);
  });

  it("validates configuration: GUIDs, a user list, documented app classes", () => {
    expect(M365_COPILOT_CONNECTOR.validateConfig(listed([USER_A]))).toBeNull();
    expect(M365_COPILOT_CONNECTOR.validateConfig({ ...listed([USER_A]), tenantId: "contoso" })).not.toBeNull();
    expect(M365_COPILOT_CONNECTOR.validateConfig({ ...listed([]) })).not.toBeNull();
    expect(M365_COPILOT_CONNECTOR.validateConfig({ ...listed([USER_A]), appClasses: ["IPM.Note"] })).not.toBeNull();
    expect(M365_COPILOT_CONNECTOR.validateConfig({ ...listed([USER_A]), extra: 1 })).not.toBeNull();
    expect(M365_COPILOT_CONNECTOR.validateConfig({ ...listed([USER_A]), backfillDays: 31 })).not.toBeNull();
  });

  it("adds app-class filters as OData literals", () => {
    const u = new URL(m365InteractionsUrl(USER_A, window, ["IPM.SkypeTeams.Message.Copilot.Teams"]));
    expect(u.searchParams.get("$filter")).toContain("(appClass eq 'IPM.SkypeTeams.Message.Copilot.Teams')");
  });
});

describe("ADR-0361 normaliser and text extraction", () => {
  it("normalises a prompt and a response", () => {
    const p = normalizeGraphInteraction(prompt("1", USER_A, "What is on my radar?"));
    expect(p).toMatchObject({ vendorInteractionId: "1", kind: "prompt", actorRef: USER_A, text: "What is on my radar?", truncated: false });
    const r = normalizeGraphInteraction({
      ...prompt("2", USER_A, '<attachment id="x"></attachment>'),
      interactionType: "aiResponse",
      from: { user: null, application: { id: "app-1", displayName: "Microsoft 365 Chat" } },
      body: { contentType: "html", content: '<attachment id="x"></attachment>' },
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: JSON.stringify({ body: [{ type: "TextBlock", text: "Card text" }, { type: "TextBlock", text: "Card text" }] }), name: null }],
    });
    expect(r).toMatchObject({ kind: "response", actorRef: "app-1", text: "Card text" });
  });

  it("strips markup linearly, decodes entities, and bounds the text", () => {
    expect(htmlToScanText("<p>a &amp; b</p><br/>c&nbsp;d &unknown; <")).toBe("a & b c d &unknown;");
    const huge = "<".repeat(200_000) + "x";
    const t0 = Date.now();
    htmlToScanText(huge);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(adaptiveCardText("not json")).toBe("");
    const long = normalizeGraphInteraction(prompt("3", USER_A, "x".repeat(AI_SAAS_MONITOR_MAX_TEXT_CHARS + 5)));
    expect(long.text).toHaveLength(AI_SAAS_MONITOR_MAX_TEXT_CHARS);
    expect(long.truncated).toBe(true);
  });
});

describe("ADR-0361 run window, lifecycle and widening", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("resumes exactly where the last success ended, never skipping a gap, and settles behind now", () => {
    // a 7-day backfill starts 7 days back and reads one day per run
    const w = monitorWindow(null, 7, now);
    expect(w.start.toISOString()).toBe("2026-11-10T11:55:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-11T11:55:00.000Z");
    const old = new Date("2026-08-01T00:00:00Z");
    const caught = monitorWindow(old, 7, now);
    expect(caught.start).toEqual(old);
    expect(caught.end.toISOString()).toBe("2026-08-02T00:00:00.000Z");
    // caught up: the window ends at the settle point
    const live = monitorWindow(new Date("2026-11-17T09:00:00Z"), 7, now);
    expect(live.end.toISOString()).toBe("2026-11-17T11:55:00.000Z");
  });

  it("declares the run lifecycle on ADR-0348: running closes once, and an in-progress refusal is born refused", () => {
    const m = AI_SAAS_MONITOR_RUN_MACHINE;
    expect(STATE_MACHINES[m.def.id]).toBe(m);
    expect(m.def.stored).toBe("ai_saas_monitor_runs.status");
    expect([...m.def.initial]).toEqual(["running", "refused"]);
    for (const e of ["succeed", "fail", "refuse"] as const) expect(m.sourcesOf(e)).toEqual(["running"]);
    for (const t of ["succeeded", "failed", "refused"] as const) expect(m.isTerminal(t)).toBe(true);
  });

  it("declares the remediation lifecycle: approve before execute, unknown settles by a read, terminals stay terminal", () => {
    const m = AI_SAAS_REMEDIATION_MACHINE;
    expect(m.can("requested", "execute")).toBe(false);
    expect(m.next("approved", "execute")).toBe("executing");
    expect(m.sourcesOf("succeed")).toEqual(["executing", "unknown"]);
    expect(m.can("unknown", "execute")).toBe(false);
    for (const t of ["succeeded", "failed", "denied", "cancelled"] as const) expect(m.isTerminal(t)).toBe(true);
    expect(() => m.next("succeeded", "execute")).toThrow();
  });

  it("halves the window after each bounded failure since the last success, down to the floor (review R7 [1])", () => {
    expect(windowSpanMs(0)).toBe(AI_SAAS_MONITOR_MAX_WINDOW_MS);
    expect(windowSpanMs(1)).toBe(AI_SAAS_MONITOR_MAX_WINDOW_MS / 2);
    expect(windowSpanMs(3)).toBe(AI_SAAS_MONITOR_MAX_WINDOW_MS / 8);
    expect(windowSpanMs(7)).toBe(AI_SAAS_MONITOR_MIN_WINDOW_MS);
    expect(windowSpanMs(1000)).toBe(AI_SAAS_MONITOR_MIN_WINDOW_MS);
    const now = new Date("2026-11-17T12:00:00Z");
    const w = monitorWindow(new Date("2026-11-10T00:00:00Z"), 7, now, windowSpanMs(2));
    expect(w.end.getTime() - w.start.getTime()).toBe(6 * 3600_000);
  });

  it("builds the guided M365 setup from what RegulAIt can see, never claiming a step it cannot check (D-2026-11-22-06)", () => {
    const base = {
      config: listed([USER_A]),
      publicUrl: "https://regulait.example.com",
      allowedHosts: new Set<string>(),
      policyEnabled: false,
      connectorEnabled: false,
      credential: null,
      lastRun: null,
    };
    const fresh = m365SetupGuide(base);
    const state = (g: ReturnType<typeof m365SetupGuide>) => Object.fromEntries(g.steps.map((st) => [st.id, st.state]));
    expect(state(fresh)).toEqual({
      register_app: "done",
      api_permissions: "unknown",
      redirect_uri: "unknown",
      admin_consent: "unknown",
      client_secret: "to_do",
      egress: "to_do",
      turn_on: "to_do",
      data_flowing: "unknown",
    });
    expect(fresh.next).toBe("api_permissions");
    const url = new URL(fresh.adminConsentUrl!);
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/v2.0/adminconsent`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT, scope: "https://graph.microsoft.com/.default", redirect_uri: "https://regulait.example.com" });
    const live = m365SetupGuide({
      ...base,
      allowedHosts: new Set(["graph.microsoft.com", "login.microsoftonline.com"]),
      policyEnabled: true,
      connectorEnabled: true,
      credential: { scopePosture: "read_only" },
      lastRun: { status: "succeeded", errorCode: null },
    });
    expect(live.steps.every((st) => st.state === "done")).toBe(true);
    expect(live.next).toBeNull();
    // a write-capable credential, or a run that hit a missing permission, fails the permission steps
    expect(state(m365SetupGuide({ ...base, credential: { scopePosture: "refused" } })).api_permissions).toBe("failed");
    expect(state(m365SetupGuide({ ...base, credential: { scopePosture: "unverified" }, lastRun: { status: "failed", errorCode: "missing_permission" } })).admin_consent).toBe("failed");
    // with no public URL there is no consent link to return to: the step names the portal button, and no redirect step
    const noUrl = m365SetupGuide({ ...base, publicUrl: null });
    expect(noUrl.adminConsentUrl).toBeNull();
    expect(noUrl.steps.map((st) => st.id)).not.toContain("redirect_uri");
    // every user in scope also needs User.Read.All
    const all = m365SetupGuide({ ...base, config: { ...listed([USER_A]), users: { mode: "all" } } });
    expect(all.steps.find((st) => st.id === "api_permissions")!.detail).toContain("User.Read.All");
  });

  it("knows when a tag change loosens the cascade (review R7 [3])", () => {
    const c = (auditRetentionDays: number | null, piiMode: "block" | "warn" | "log" | "redact" | null) => ({ tags: [], auditRetentionDays, piiMode });
    expect(cascadeLoosens(c(400, "warn"), c(null, "warn"))).toEqual(["retention"]); // the tag's days are gone: evidence goes at the org floor
    expect(cascadeLoosens(c(null, "warn"), c(400, "warn"))).toBeNull(); // gaining tag days keeps evidence longer
    expect(cascadeLoosens(c(400, "block"), c(30, "log"))).toEqual(["retention", "pii_mode"]);
    expect(cascadeLoosens(c(30, "log"), c(400, "block"))).toBeNull();
    expect(cascadeLoosens(c(400, "redact"), c(400, "warn"))).toEqual(["pii_mode"]);
  });

  it("knows when an M365 configuration reads more than before", () => {
    const base = listed([USER_A]);
    expect(m365ConfigWidens(base, listed([USER_A, USER_B]))).toBe(true);
    expect(m365ConfigWidens(base, { ...base, users: { mode: "all" } })).toBe(true);
    expect(m365ConfigWidens(listed([USER_A, USER_B]), base)).toBe(false);
    expect(m365ConfigWidens({ ...base, appClasses: ["IPM.SkypeTeams.Message.Copilot.Teams"] }, base)).toBe(true);
    expect(m365ConfigWidens(base, { ...base, backfillDays: 14 })).toBe(true);
    expect(m365ConfigWidens(base, base)).toBe(false);
  });

  it("knows when a ChatGPT configuration reads more than before (review #985 S4 [1])", () => {
    const ws1 = { principal: "workspace", principalId: "ws-1", backfillDays: 7 };
    expect(chatGptConfigWidens(ws1, { ...ws1, principalId: "ws-2" })).toBe(true); // another workspace's people
    expect(chatGptConfigWidens(ws1, { ...ws1, principal: "organization", principalId: "org-1" })).toBe(true); // the whole organization
    expect(chatGptConfigWidens(ws1, { ...ws1, principal: "organization" })).toBe(true); // same id, wider principal
    expect(chatGptConfigWidens({ principalId: "ws-1" }, { principal: "organization", principalId: "ws-1" })).toBe(true); // the default is a workspace
    expect(chatGptConfigWidens(ws1, { ...ws1, backfillDays: 14 })).toBe(true);
    expect(chatGptConfigWidens(ws1, { ...ws1, backfillDays: 3 })).toBe(false);
    expect(chatGptConfigWidens(ws1, { principalId: "ws-1" })).toBe(false); // the default principal is unchanged
  });

  it("knows when a Claude configuration reads more than before (review #985 S4 [1])", () => {
    const one = { organizationIds: ["org-a"], backfillDays: 7 };
    expect(claudeConfigWidens(one, { ...one, organizationIds: [] })).toBe(true); // one child organization becomes org-wide
    expect(claudeConfigWidens(one, { ...one, organizationIds: ["org-a", "org-b"] })).toBe(true); // an added organization
    expect(claudeConfigWidens(one, { ...one, organizationIds: ["org-b"] })).toBe(true); // a different organization
    expect(claudeConfigWidens({ ...one, organizationIds: [] }, one)).toBe(false); // org-wide narrowed to one
    expect(claudeConfigWidens({ ...one, organizationIds: ["org-a", "org-b"] }, one)).toBe(false);
    expect(claudeConfigWidens(one, { ...one, backfillDays: 30 })).toBe(true);
    expect(claudeConfigWidens(one, one)).toBe(false);
  });

  it("every registered connector declares its own widening check and only ChatGPT gets the redirect-returning fetch", () => {
    for (const c of AI_SAAS_CONNECTORS.values()) expect(typeof c.configWidens).toBe("function");
    expect([...AI_SAAS_CONNECTORS.values()].filter((c) => c.signedRedirectDownload).map((c) => c.vendor)).toEqual(["chatgpt_enterprise"]);
  });
});

describe("#991 S3 [3]: a stored vendor id is sent only as one exact path segment", () => {
  it("refuses an id at the stored length (it may be truncated), a path-collapsing id and odd characters", async () => {
    const { isUsableVendorRef, REMEDIATION_REF_MAX } = await import("./ai-saas-remediation-contract.js");
    expect(isUsableVendorRef("claude_chat_01abc", "conversation")).toBe(true);
    expect(isUsableVendorRef("user-1@example.test", "actor")).toBe(true);
    expect(isUsableVendorRef(null, "actor")).toBe(true);
    expect(isUsableVendorRef(null, "conversation")).toBe(false);
    expect(isUsableVendorRef("x".repeat(REMEDIATION_REF_MAX.conversation), "conversation")).toBe(false);
    expect(isUsableVendorRef("x".repeat(REMEDIATION_REF_MAX.actor), "actor")).toBe(false);
    expect(isUsableVendorRef("x".repeat(REMEDIATION_REF_MAX.conversation - 1), "conversation")).toBe(true);
    for (const bad of ["..", ".", "", "a/b", "a%2Fb", "a b", "a?b", "a#b", "\\x"]) expect(isUsableVendorRef(bad, "conversation"), bad).toBe(false);
  });
});
