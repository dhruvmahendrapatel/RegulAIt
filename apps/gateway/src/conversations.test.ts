import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  conversationMessages,
  costEvents,
  createDb,
  eq,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

/**
 * Multi-turn conversations end to end: create → dispatch twice with history →
 * persisted turns with dispatch facts → own-scoping (admins included) →
 * refusal/denial/failure persistence semantics → hard delete with cascade —
 * with every turn a NORMAL governed dispatch (usage ledger + project
 * attribution written per turn, exactly like a single-turn invoke).
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed convo- and ledger asserts filter by user id.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "convo-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);

const TURN_1 = "plan the payments migration to the new gateway with zero downtime";
const TURN_2 = "now make it shorter";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let miaId: string;
let miaAuth: { authorization: string };
let rexId: string;
let rexAuth: { authorization: string };
let admAuth: { authorization: string };
let agentId: string;
let openaiAgentId: string;
let umaAuth: { authorization: string };
let projectId: string;
let convoId: string;
let convo2Id: string;

function parseEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function makeUser(email: string, displayName: string, isAdmin = false) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName, isAdmin },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the org PII floor ships at block. This file pins behaviour unrelated to
  // PII handling, so it sets the floor off explicitly, and the injection and jailbreak
  // layers to warn (a block-mode output layer never streams live); restored in afterAll.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: { promptInjectionMode: "warn", jailbreakMode: "warn" } });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // the gateway resolves "mock" to the module-shared instance, so the test
  // can read the exact wire shape each governed dispatch produced
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  const mia = await makeUser("convo-mia@example.com", "Convo Mia");
  miaId = mia.id;
  miaAuth = mia.auth;
  const rex = await makeUser("convo-rex@example.com", "Convo Rex");
  rexId = rex.id;
  rexAuth = rex.auth;
  const adm = await makeUser("convo-admin@example.com", "Convo Admin", true);
  admAuth = adm.auth;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "convo-mock",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: miaId, agentId },
  });
  // rex may only use mode "chat" — the denial test invokes "deploy"
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: rexId, agentId, allowedModes: ["chat"] },
  });

  // a real-provider agent with NO stored credential, granted to a user whose
  // ONLY entitled agent it is (so routing cannot rescue the dispatch)
  const openaiAgent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "convo-openai", provider: "openai", tier: 1, model: "gpt-5" },
  });
  openaiAgentId = openaiAgent.json().id;
  const uma = await makeUser("convo-uma@example.com", "Convo Uma");
  umaAuth = uma.auth;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: uma.id, agentId: openaiAgentId },
  });

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "convo-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

describe("conversation CRUD (own-scoped)", () => {
  it("creates an empty conversation and lists it with messageCount 0", async () => {
    const created = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/conversations",
      payload: { agentId, projectId },
    });
    expect(created.statusCode).toBe(201);
    convoId = created.json().id;
    expect(created.json().title).toBeNull();
    expect(created.json().userId).toBe(miaId);
    expect(created.json().projectId).toBe(projectId);

    const list = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/conversations" });
    expect(list.statusCode).toBe(200);
    const row = list.json().conversations.find((c: { id: string }) => c.id === convoId);
    expect(row).toMatchObject({
      agentId,
      agentName: "convo-mock",
      projectId,
      projectName: "convo-project",
      messageCount: 0,
      title: null,
    });
  });

  it("rejects a dangling agent id and the identityless bootstrap token", async () => {
    const bad = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/conversations",
      payload: { agentId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(bad.statusCode).toBe(404);
    const boot = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/conversations",
      payload: { agentId },
    });
    expect(boot.statusCode).toBe(403);
  });
});

describe("multi-turn governed dispatch", () => {
  it("turn 1 dispatches with a single-message history and persists both turns", async () => {
    const res = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: TURN_1, dispatch: true, conversationId: convoId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.outputText).toContain("payments migration");

    const wire = mock.dispatches.at(-1)!;
    expect(wire.messages).toEqual([{ role: "user", content: TURN_1 }]);
  });

  it("turn 2's wire history contains turn 1, and the reply proves context flowed", async () => {
    const res = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: TURN_2, dispatch: true, conversationId: convoId },
    });
    expect(res.statusCode).toBe(200);

    // the FULL ordered history rode the wire: user, assistant, newest user
    const wire = mock.dispatches.at(-1)!;
    expect(wire.messages).toHaveLength(3);
    expect(wire.messages![0]).toEqual({ role: "user", content: TURN_1 });
    expect(wire.messages![1]!.role).toBe("assistant");
    expect(wire.messages![2]).toEqual({ role: "user", content: TURN_2 });

    // the mock's continuation behaviour: terse follow-up inherits the topic
    const out = res.json().dispatch.outputText as string;
    expect(out).toContain("Continuing from the previous 2 turns");
    expect(out).toContain("payments migration");
  });

  it("GET :id returns 4 ordered rows, assistant turns carrying the dispatch facts", async () => {
    const res = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/conversations/${convoId}`,
    });
    expect(res.statusCode).toBe(200);
    const msgs = res.json().messages;
    expect(msgs).toHaveLength(4);
    expect(msgs.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(msgs[0].content).toBe(TURN_1);
    expect(msgs[2].content).toBe(TURN_2);
    for (const assistant of [msgs[1], msgs[3]]) {
      expect(assistant.detail).toMatchObject({
        stopReason: "end_turn",
        refusal: false,
        servedAgentId: agentId,
        modelUsed: "mock-balanced",
        credentialSource: "none",
      });
      expect(typeof assistant.detail.costUsd).toBe("number");
      expect(assistant.detail.costUsd).toBeGreaterThan(0);
    }
    // auto-title: first ~60 chars of the first user turn
    expect(res.json().title).toBe(TURN_1.slice(0, 60));
  });

  it("every turn landed one MEASURED usage row with project attribution", async () => {
    const rows = await db.select().from(usageEvents).where(eq(usageEvents.userId, miaId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.projectId).toBe(projectId);
      expect(row.model).toBe("mock-balanced");
      expect(row.costUsd).toBeGreaterThan(0);
      expect((row.detail as { conversationId?: string }).conversationId).toBe(convoId);
    }
  });

  it("the routing estimate counts history size, so cost estimates grow with the thread", async () => {
    const rows = (
      await db.select().from(costEvents).where(eq(costEvents.userId, miaId))
    ).filter((r) => (r.detail as { conversationId?: string }).conversationId === convoId);
    expect(rows).toHaveLength(2);
    rows.sort((a, b) => a.at.getTime() - b.at.getTime());
    // turn 2's input text is tiny, but its estimate must exceed the bare
    // text estimate because the persisted history rides the same request
    const bareTurn2 = Math.ceil(TURN_2.length / 4) + 200;
    expect(rows[1]!.estimatedTokensIn).toBeGreaterThan(bareTurn2);
  });

  it("list orders by newest update and counts messages", async () => {
    const created = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: "/v1/conversations",
      payload: { agentId },
    });
    convo2Id = created.json().id;
    const res = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "explain how the audit trail works", dispatch: true, conversationId: convo2Id },
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/conversations" });
    const mine = list
      .json()
      .conversations.filter((c: { id: string }) => [convoId, convo2Id].includes(c.id));
    expect(mine[0].id).toBe(convo2Id); // updated most recently
    expect(mine[0].messageCount).toBe(2);
    expect(mine[1].id).toBe(convoId);
    expect(mine[1].messageCount).toBe(4);
  });

  it("a streaming turn persists exactly like the JSON path", async () => {
    const res = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        input: "now summarize that explanation",
        dispatch: true,
        stream: true,
        conversationId: convo2Id,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseEvents(res.body);
    const result = events.find((e) => e.event === "result")!.data;
    expect(result.dispatch.outputText).toContain("Continuing from the previous 2 turns");

    const detail = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/conversations/${convo2Id}`,
    });
    const msgs = detail.json().messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[3].role).toBe("assistant");
    expect(msgs[3].content).toBe(result.dispatch.outputText);
    expect(msgs[3].detail.modelUsed).toBe("mock-balanced");
  });
});

describe("own-scoping — conversations are personal, admins included", () => {
  it("another user gets 403 on read, invoke, and delete; unknown ids get 404", async () => {
    for (const [method, url] of [
      ["GET", `/v1/conversations/${convoId}`],
      ["DELETE", `/v1/conversations/${convoId}`],
    ] as const) {
      const res = await app.inject({ method, headers: rexAuth, url });
      expect(res.statusCode).toBe(403);
    }
    const invoked = await app.inject({
      method: "POST",
      headers: rexAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "hi", dispatch: true, conversationId: convoId },
    });
    expect(invoked.statusCode).toBe(403);
    expect(invoked.json().error).toBe("forbidden");

    const unknown = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: "/v1/conversations/00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("an admin is 403'd off another user's conversation too", async () => {
    const read = await app.inject({
      method: "GET",
      headers: admAuth,
      url: `/v1/conversations/${convoId}`,
    });
    expect(read.statusCode).toBe(403);
    const list = await app.inject({ method: "GET", headers: admAuth, url: "/v1/conversations" });
    expect(
      list.json().conversations.find((c: { id: string }) => c.id === convoId),
    ).toBeUndefined();
  });
});

describe("refusal / denial / failure persistence semantics", () => {
  it("a model refusal persists the assistant turn with detail.refusal", async () => {
    const res = await app.inject({
      method: "POST",
      headers: miaAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "please <<refuse>> this", dispatch: true, conversationId: convo2Id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dispatch.refusal).toBe(true);

    const detail = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/conversations/${convo2Id}`,
    });
    const last = detail.json().messages.at(-1);
    expect(last.role).toBe("assistant");
    expect(last.detail.refusal).toBe(true);
    expect(last.detail.stopReason).toBe("refusal");
    // outputText is empty on refusal, so a marker keeps the row honest
    expect(last.content).toContain("declined");
  });

  it("a governance DENIAL persists the user turn with detail.denied and no assistant turn", async () => {
    const created = await app.inject({
      method: "POST",
      headers: rexAuth,
      url: "/v1/conversations",
      payload: { agentId },
    });
    const rexConvoId = created.json().id;
    // rex's grant only allows mode "chat" — "deploy" is denied
    const denied = await app.inject({
      method: "POST",
      headers: rexAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "deploy", input: "deploy the thing", dispatch: true, conversationId: rexConvoId },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().decision.effect).toBe("deny");

    const detail = await app.inject({
      method: "GET",
      headers: rexAuth,
      url: `/v1/conversations/${rexConvoId}`,
    });
    const msgs = detail.json().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].detail.denied).toBe(true);
    expect(msgs[0].content).toBe("deploy the thing");

    // the denied turn shows in history but is NEVER replayed to a provider
    const ok = await app.inject({
      method: "POST",
      headers: rexAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input: "hello again", dispatch: true, conversationId: rexConvoId },
    });
    expect(ok.statusCode).toBe(200);
    const wire = mock.dispatches.at(-1)!;
    expect(wire.messages).toEqual([{ role: "user", content: "hello again" }]);
  });

  it("a dispatch failure (no_model_credential) leaves no half-written turn", async () => {
    // other suites (mcp-proxy) may have left a platform openai credential
    // behind under their own data key; this case needs the credential lookup
    // to come up empty, so clear it (404 = already absent, fine either way)
    await app.inject({ method: "DELETE", headers: AUTH, url: "/v1/model-credentials/openai" });
    const created = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: "/v1/conversations",
      payload: { agentId: openaiAgentId },
    });
    const umaConvoId = created.json().id;
    const res = await app.inject({
      method: "POST",
      headers: umaAuth,
      url: `/v1/agents/${openaiAgentId}/invoke`,
      payload: { mode: "chat", input: "hello", dispatch: true, conversationId: umaConvoId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_model_credential");

    const detail = await app.inject({
      method: "GET",
      headers: umaAuth,
      url: `/v1/conversations/${umaConvoId}`,
    });
    expect(detail.json().messages).toHaveLength(0);
    expect(detail.json().title).toBeNull();
  });
});

describe("hard delete", () => {
  it("deletes the conversation and cascades its messages", async () => {
    const before = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, convoId));
    expect(before.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: "DELETE",
      headers: miaAuth,
      url: `/v1/conversations/${convoId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(true);

    const gone = await app.inject({
      method: "GET",
      headers: miaAuth,
      url: `/v1/conversations/${convoId}`,
    });
    expect(gone.statusCode).toBe(404);
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, convoId));
    expect(rows).toHaveLength(0);
  });
});

/**
 * S21 — `?projectId=` on the conversations list.
 *
 * `conversations.projectId` is the pillar-5 default attribution for every turn
 * dispatched in a thread, so "my chats on project X" is the question an operator
 * actually asks. The list already carried `projectName`; it could not be asked
 * for one.
 *
 * The claim under test is deliberately TWO-SIDED, per M-035: the filter must
 * NARROW (a thread on another project disappears) and must never WIDEN (another
 * user's thread on the SAME project must still be invisible). A filter that only
 * proved the first half would pass while quietly serving somebody else's
 * conversations, which is the exact failure the ownership predicate exists to
 * prevent — so it is asserted, not assumed.
 */
describe("S21 — listing conversations filtered by project", () => {
  let projectB: string;
  let onA: string;
  let onB: string;
  let unattributed: string;
  let rexOnA: string;

  beforeAll(async () => {
    const pb = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/projects",
      payload: { name: `convo-s21-b-${Math.random().toString(36).slice(2, 8)}` },
    });
    expect(pb.statusCode).toBe(201);
    projectB = pb.json().id;

    const mk = async (auth: { authorization: string }, project?: string) => {
      const r = await app.inject({
        method: "POST",
        headers: auth,
        url: "/v1/conversations",
        payload: project ? { agentId, projectId: project } : { agentId },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    onA = await mk(miaAuth, projectId);
    onB = await mk(miaAuth, projectB);
    unattributed = await mk(miaAuth);
    rexOnA = await mk(rexAuth, projectId);
  });

  const idsFor = async (query: string) => {
    const r = await app.inject({ method: "GET", headers: miaAuth, url: `/v1/conversations${query}` });
    expect(r.statusCode).toBe(200);
    return (r.json().conversations as Array<{ id: string }>).map((c) => c.id);
  };

  it("NARROWS to the named project, and drops this user's threads on every other one", async () => {
    const ids = await idsFor(`?projectId=${projectB}`);
    expect(ids).toContain(onB);
    expect(ids).not.toContain(onA);
    expect(ids).not.toContain(unattributed);
    // positive pin so an empty list cannot satisfy the two negatives above
    expect(ids.length).toBeGreaterThan(0);
  });

  it("NEVER WIDENS — another user's thread on the same project stays invisible", async () => {
    const ids = await idsFor(`?projectId=${projectId}`);
    expect(ids).toContain(onA); // the filter really did return this project
    expect(ids).not.toContain(rexOnA); // ...and still only mine
    const rexIds = (await (async () => {
      const r = await app.inject({ method: "GET", headers: rexAuth, url: `/v1/conversations?projectId=${projectId}` });
      expect(r.statusCode).toBe(200);
      return (r.json().conversations as Array<{ id: string }>).map((c) => c.id);
    })())!;
    expect(rexIds).toContain(rexOnA); // rex sees his own
    expect(rexIds).not.toContain(onA); // ...and not mia's
  });

  it("`none` selects the UNATTRIBUTED threads — the ADR-0024 bucket, not an invented word", async () => {
    const ids = await idsFor("?projectId=none");
    expect(ids).toContain(unattributed);
    expect(ids).not.toContain(onA);
    expect(ids).not.toContain(onB);
  });

  it("omitting the filter is unchanged — every thread of mine, across projects", async () => {
    const ids = await idsFor("");
    expect(ids).toEqual(expect.arrayContaining([onA, onB, unattributed]));
    expect(ids).not.toContain(rexOnA);
  });

  it("a projectId that is neither a uuid nor `none` is refused, not silently ignored", async () => {
    const r = await app.inject({ method: "GET", headers: miaAuth, url: "/v1/conversations?projectId=not-a-uuid" });
    expect(r.statusCode).toBe(400);
  });
});

afterAll(async () => {
  await restoreSb1Posture?.();
});
