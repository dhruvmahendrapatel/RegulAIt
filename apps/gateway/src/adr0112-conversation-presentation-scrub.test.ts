/**
 * ADR-0112 e2e — THE OWNER'S OPTION (c), PINNED FROM BOTH ENDS.
 *
 * ADR-0111 proved that a credential pasted into a chat turn is stored verbatim
 * in `conversation_messages.content` (user turn AND assistant turn), in
 * `conversations.title` via `autoTitle`, and in the compaction summary. It left
 * the fix to the owner and listed four options. The owner chose (c): STORE
 * FAITHFULLY, SCRUB THE READ AND EXPORT SURFACES.
 *
 * That is two halves of one contract, and they are asserted TOGETHER — on the
 * same message, in the same test — because either half alone is a different
 * product:
 *   - presented content carries the marker, and
 *   - the stored row is byte-identical to what was sent in.
 *
 * AND THE THIRD THING, WHICH IS THE REGRESSION THAT WOULD OTHERWISE SLIP IN
 * SILENTLY: the MODEL-BOUND HISTORY still carries the ORIGINAL text. If a
 * future refactor "helpfully" moves the scrub onto the database read, the
 * provider starts receiving `[redacted:…]` where the user's prior question
 * belongs and multi-turn threads answer the wrong question. §3 must redden on
 * that day. It constrains the fix; it does not depend on it.
 *
 * SHAPES, NOT LIVE SECRETS. `AKIAIOSFODNN7EXAMPLE` is AWS's own published
 * documentation example id and is the one ADR-0111 used. No real credential
 * appears in this file, in any fixture it writes, or in any log it produces.
 *
 * NEGATIVE ASSERTIONS ARE PAIRED (M-033). Every `not.toContain(AWS_KEY)` sits
 * beside a positive assertion — the marker IS present, on the RIGHT message, of
 * the RIGHT role, from the RIGHT route — so a null field, a missing message or
 * an empty response FAILS rather than trivially satisfying the negative.
 *
 * SHARED-DB DISCIPLINE. Per-run uuid nonce on every fixture; every read is
 * filtered to rows this file created; deltas, never absolute counts; the
 * `org_settings` singleton is never touched.
 */
import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { scrubAuditText } from "@regulait/shared";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { PRESENTATION_SCRUB, scrubPresentedPayload } from "./conversation-presentation.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "adr0112-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const RUN = randomUUID().slice(0, 8);

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/**
 * The leaking turn. The credential is mid-sentence, exactly as a user would
 * paste it while asking for help — the prose around it must survive.
 *
 * DELIBERATELY SHORT (54 chars, 5 words). Two independent derivations of this
 * string are also under test and both truncate: `autoTitle` cuts
 * `conversations.title` at 60 chars, and the mock provider's completion echoes
 * only the first 8 words of the input. Keeping the whole credential inside both
 * windows is what makes the title and the assistant turn genuinely carry it —
 * a longer fixture would cut the key in half and the test would pass for the
 * wrong reason.
 */
const SECRET_TURN = `adr0112-${RUN} key ${AWS_KEY} fails deploy`;

/** The over-scrub fixture: full of what a naive detector eats — a ticket id, an
 * email, a uuid, a model name, numbers — and not one credential. */
const ORDINARY_TURN =
  `adr0112-${RUN} rotate the staging cert before 2026-10-01; ticket SEC-4412, ` +
  "owner ana@example.com, agent 7f1a5b2c-9d4e-4a10-b3c8-2e5f6a7b8c90, " +
  "model claude-opus-4, tokensIn 1200";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let userId: string;
let userAuth: { authorization: string };
let agentId: string;
let secretConvoId: string;
let ordinaryConvoId: string;
/** a SECOND identity, pinned to optimizer `passthrough`, so the OTHER
 * model-bound code path is exercised — see §3's second test */
let ptAuth: { authorization: string };
let ptConvoId: string;

async function makeUser(email: string, displayName: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName, isAdmin: false },
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

/** Raw SQL, never the ORM's return value: a scrub sited on the wrong side of
 * the boundary would be invisible to a read that goes back through it. */
async function storedMessages(conversationId: string) {
  const res = (await db.execute(sql`
    select role, content from conversation_messages
     where conversation_id = ${conversationId}
     order by created_at asc
  `)) as unknown as { rows: Array<{ role: string; content: string }> };
  return res.rows;
}

async function storedConversation(conversationId: string) {
  const res = (await db.execute(sql`
    select title, summary from conversations where id = ${conversationId}
  `)) as unknown as { rows: Array<{ title: string | null; summary: string | null }> };
  return res.rows[0];
}

const MARKER_RE = /\[redacted:aws_key:20:[0-9a-f]{12}\]/;

/**
 * The wire messages of one recorded mock dispatch, narrowed to the plain-text
 * turns. `ModelChatMessage.content` is `string | ModelContentBlock[]` because
 * an attachment dispatch sends blocks; a conversation turn is always text, and
 * narrowing here keeps the assertions below about CONTENT rather than about
 * type guards.
 */
function textTurns(wire: { messages?: ReadonlyArray<{ role: string; content: unknown }> }) {
  return (wire.messages ?? []).filter(
    (m): m is { role: string; content: string } => typeof m.content === "string",
  );
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: this file pins how a conversation PRESENTS scrubbed content, not the inline
  // controls: the org PII floor is set off and the injection/jailbreak layers to warn.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: { promptInjectionMode: "warn", jailbreakMode: "warn" } });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  const u = await makeUser(`adr0112-${RUN}@example.com`, `ADR0112 ${RUN}`);
  userId = u.id;
  userAuth = u.auth;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: `adr0112-mock-${RUN}`,
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  const grant = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId, agentId },
  });
  expect(grant.statusCode).toBe(201);

  // A second user whose optimizer mode is `passthrough`. This is not cosmetic:
  // the invoke path has TWO model-bound sources, and only one of them runs at a
  // time. With compaction eligible, `prepareConversationContext` builds the
  // wire from `ConversationContext.messages`; with the user on `passthrough`,
  // compaction is skipped entirely and the wire is `ConversationContext.history`
  // instead. A scrub mis-sited on either one corrupts replay, so §3 asserts
  // BOTH — a guard that only covered the compaction path would stay green while
  // `history` was quietly redacted.
  const pt = await makeUser(`adr0112-pt-${RUN}@example.com`, `ADR0112 PT ${RUN}`);
  ptAuth = pt.auth;
  expect(
    (
      await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/agents",
        payload: { userId: pt.id, agentId },
      })
    ).statusCode,
  ).toBe(201);
  const ptPolicy = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${pt.id}/agent-policy`,
    payload: { routingMode: "passthrough" },
  });
  expect(ptPolicy.statusCode).toBeLessThan(300);
  const ptConvo = await app.inject({
    method: "POST",
    headers: ptAuth,
    url: "/v1/conversations",
    payload: { agentId },
  });
  expect(ptConvo.statusCode).toBe(201);
  ptConvoId = ptConvo.json().id;
  expect(
    (
      await app.inject({
        method: "POST",
        headers: ptAuth,
        url: `/v1/agents/${agentId}/invoke`,
        payload: { mode: "chat", input: SECRET_TURN, dispatch: true, conversationId: ptConvoId },
      })
    ).statusCode,
  ).toBe(200);

  for (const target of ["secret", "ordinary"] as const) {
    const created = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/conversations",
      payload: { agentId },
    });
    expect(created.statusCode).toBe(201);
    if (target === "secret") secretConvoId = created.json().id;
    else ordinaryConvoId = created.json().id;
  }

  // ONE real governed dispatch per conversation. The mock provider echoes the
  // input into its completion, so a single turn puts the credential into BOTH
  // the user row and the assistant row, and `autoTitle` fills the title from
  // the first user turn — all three of ADR-0111's row-2 columns in one request.
  for (const [convo, input] of [
    [secretConvoId, SECRET_TURN],
    [ordinaryConvoId, ORDINARY_TURN],
  ] as const) {
    const res = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", input, dispatch: true, conversationId: convo },
    });
    expect(res.statusCode).toBe(200);
  }
});

// ===========================================================================
describe("ADR-0112 §1 — both halves of option (c), on the same message", () => {
  it("presents the marker while the stored row stays byte-identical to what was sent", async () => {
    const res = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/conversations/${secretConvoId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // --- positive first (M-033): the right message, of the right role, is there
    const presentedUser = body.messages.find((m: { role: string }) => m.role === "user");
    expect(presentedUser).toBeDefined();
    expect(presentedUser.content).toContain(`adr0112-${RUN}`);
    expect(presentedUser.content).toContain("fails deploy");
    expect(presentedUser.content).toMatch(MARKER_RE);
    // ...and only THEN the negative
    expect(presentedUser.content).not.toContain(AWS_KEY);

    // the assistant turn leaks the same way and is covered the same way
    const presentedAssistant = body.messages.find((m: { role: string }) => m.role === "assistant");
    expect(presentedAssistant).toBeDefined();
    expect(presentedAssistant.content.length).toBeGreaterThan(0);
    expect(presentedAssistant.content).toMatch(MARKER_RE);
    expect(presentedAssistant.content).not.toContain(AWS_KEY);

    // --- THE OTHER HALF. The record is faithful, read with raw SQL.
    const stored = await storedMessages(secretConvoId);
    const storedUser = stored.find((m) => m.role === "user");
    expect(storedUser).toBeDefined();
    // byte-for-byte what was sent in — not "contains", not "matches"
    expect(storedUser!.content).toBe(SECRET_TURN);
    expect(storedUser!.content).toContain(AWS_KEY);

    const storedAssistant = stored.find((m) => m.role === "assistant");
    expect(storedAssistant).toBeDefined();
    expect(storedAssistant!.content).toContain(AWS_KEY);
    expect(storedAssistant!.content).not.toMatch(MARKER_RE);
  });

  it("redacts the presented value EXACTLY as scrubAuditText would — no second detector", async () => {
    const res = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/conversations/${secretConvoId}`,
    });
    const presentedUser = res
      .json()
      .messages.find((m: { role: string }) => m.role === "user");
    expect(presentedUser).toBeDefined();
    // the whole presented string is the scrub of the whole stored string
    expect(presentedUser.content).toBe(scrubAuditText(SECRET_TURN));
    // and the marker is the identical function object ADR-0102 pins
    expect(PRESENTATION_SCRUB).toBe(scrubAuditText);
  });
});

// ===========================================================================
describe("ADR-0112 §2 — title and summary, as presented", () => {
  it("scrubs conversations.title on the detail route AND on the list route, stored verbatim", async () => {
    const stored = await storedConversation(secretConvoId);
    expect(stored?.title).toBeTruthy();
    // autoTitle takes the first 60 chars of the first user turn — the key is in it
    expect(stored!.title).toContain(AWS_KEY);

    const detail = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/conversations/${secretConvoId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title).toMatch(MARKER_RE);
    expect(detail.json().title).not.toContain(AWS_KEY);

    const list = await app.inject({ method: "GET", headers: userAuth, url: "/v1/conversations" });
    expect(list.statusCode).toBe(200);
    const row = list
      .json()
      .conversations.find((c: { id: string }) => c.id === secretConvoId);
    expect(row).toBeDefined();
    expect(row.title).toMatch(MARKER_RE);
    expect(row.title).not.toContain(AWS_KEY);
  });

  it("presents the passthrough user's own thread redacted too — a second identity, same contract", async () => {
    const shown = await app.inject({
      method: "GET",
      headers: ptAuth,
      url: `/v1/conversations/${ptConvoId}`,
    });
    expect(shown.statusCode).toBe(200);
    const shownUser = shown
      .json()
      .messages.find((m: { role: string; content: string }) => m.content.includes("fails deploy"));
    expect(shownUser).toBeDefined();
    expect(shownUser.content).toBe(scrubAuditText(SECRET_TURN));
    expect(shownUser.content).toMatch(MARKER_RE);
    expect(shownUser.content).not.toContain(AWS_KEY);

    const stored = await storedMessages(ptConvoId);
    expect(stored.find((m) => m.role === "user")!.content).toBe(SECRET_TURN);
  });

  it("scrubs conversations.summary as presented, and the stored summary stays faithful", async () => {
    // Seeded directly on the column rather than by driving a live compaction
    // dispatch: what is under test is the PRESENTATION boundary, and seeding
    // also demonstrates ADR-0112's at-rest limit — a direct write lands
    // verbatim, because nothing scrubs conversation columns at write time.
    const summary = `adr0112-${RUN} the user is debugging a deploy using key ${AWS_KEY} in staging`;
    await db.execute(
      sql`update conversations set summary = ${summary} where id = ${secretConvoId}`,
    );
    const stored = await storedConversation(secretConvoId);
    expect(stored!.summary).toBe(summary);
    expect(stored!.summary).toContain(AWS_KEY);

    const detail = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/conversations/${secretConvoId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().summary).toContain(`adr0112-${RUN}`);
    expect(detail.json().summary).toMatch(MARKER_RE);
    expect(detail.json().summary).not.toContain(AWS_KEY);
  });
});

// ===========================================================================
/**
 * §3 IS A PURE CONSTRAINT ON THE FIX, NOT A CONSUMER OF IT. Nothing in this
 * block asserts anything about a presented payload, deliberately: with the
 * scrub neutralised these two tests must STAY GREEN, which is what shows they
 * pin the replay path rather than ride on the redaction. The presentation half
 * of the passthrough thread is asserted in §2, where it belongs.
 */
describe("ADR-0112 §3 — THE MODEL-BOUND HISTORY IS UNCHANGED (the regression guard)", () => {
  it("replays the ORIGINAL text to the provider on the next turn, marker-free", async () => {
    const before = mock.dispatches.length;
    const second = await app.inject({
      method: "POST",
      headers: userAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        input: `adr0112-${RUN} now summarise that`,
        dispatch: true,
        conversationId: secretConvoId,
      },
    });
    expect(second.statusCode).toBe(200);
    // delta, not an absolute count — this database is shared
    expect(mock.dispatches.length).toBeGreaterThan(before);

    const turns = textTurns(mock.dispatches.at(-1)!);
    expect(turns.length).toBeGreaterThan(1);
    // positive: the prior user turn really is on the wire, in order
    const priorUser = turns.find((m) => m.role === "user" && m.content.includes("fails deploy"));
    expect(priorUser).toBeDefined();
    // THE ASSERTION THIS FILE EXISTS FOR: the provider gets what the user said
    expect(priorUser!.content).toBe(SECRET_TURN);
    expect(priorUser!.content).toContain(AWS_KEY);
    expect(priorUser!.content).not.toMatch(MARKER_RE);

    // the newest turn rides last and unscrubbed too
    expect(turns.at(-1)!.content).toBe(`adr0112-${RUN} now summarise that`);
  });

  it("replays the ORIGINAL text on the passthrough path too (ConversationContext.history)", async () => {
    const before = mock.dispatches.length;
    const second = await app.inject({
      method: "POST",
      headers: ptAuth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        input: `adr0112-pt-${RUN} and again`,
        dispatch: true,
        conversationId: ptConvoId,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(mock.dispatches.length).toBeGreaterThan(before);

    const turns = textTurns(mock.dispatches.at(-1)!);
    expect(turns.length).toBeGreaterThan(1);
    const priorUser = turns.find((m) => m.role === "user" && m.content.includes("fails deploy"));
    expect(priorUser).toBeDefined();
    expect(priorUser!.content).toBe(SECRET_TURN);
    expect(priorUser!.content).toContain(AWS_KEY);
    expect(priorUser!.content).not.toMatch(MARKER_RE);
    expect(turns.at(-1)!.content).toBe(`adr0112-pt-${RUN} and again`);
  });
});

// ===========================================================================
describe("ADR-0112 §4 — the over-scrub guard", () => {
  it("returns ordinary conversation content byte-identical on presentation", async () => {
    const res = await app.inject({
      method: "GET",
      headers: userAuth,
      url: `/v1/conversations/${ordinaryConvoId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const presentedUser = body.messages.find((m: { role: string }) => m.role === "user");
    expect(presentedUser).toBeDefined();
    // byte-for-byte, not "does not contain a marker"
    expect(presentedUser.content).toBe(ORDINARY_TURN);

    const stored = await storedMessages(ordinaryConvoId);
    expect(stored.find((m) => m.role === "user")!.content).toBe(ORDINARY_TURN);

    // the auto-title of ordinary content is untouched as well
    const storedConvo = await storedConversation(ordinaryConvoId);
    expect(storedConvo!.title).toBeTruthy();
    expect(body.title).toBe(storedConvo!.title);
  });

  it("leaves non-string payload leaves alone, Dates included", () => {
    const at = new Date("2026-09-19T00:00:00.000Z");
    const payload = {
      id: "7f1a5b2c-9d4e-4a10-b3c8-2e5f6a7b8c90",
      createdAt: at,
      messageCount: 4,
      title: null,
      nested: { deep: [{ content: ORDINARY_TURN }] },
    };
    const out = scrubPresentedPayload(payload);
    // identity return: nothing matched, so nothing was rebuilt
    expect(out).toBe(payload);
    expect(out.createdAt).toBe(at);
    expect(out.nested.deep[0]!.content).toBe(ORDINARY_TURN);
  });

  it("reaches a string leaf at any depth when there IS a credential", () => {
    const payload = { messages: [{ role: "user", content: SECRET_TURN }] };
    const out = scrubPresentedPayload(payload);
    expect(out).not.toBe(payload);
    expect(out.messages[0]!.role).toBe("user");
    expect(out.messages[0]!.content).toBe(scrubAuditText(SECRET_TURN));
    expect(out.messages[0]!.content).not.toContain(AWS_KEY);
    // the original object is NOT mutated — the stored/loaded row must survive
    expect(payload.messages[0]!.content).toBe(SECRET_TURN);
  });
});

afterAll(async () => {
  await restoreSb2Gates();
  await restoreSb1Posture?.();
});
