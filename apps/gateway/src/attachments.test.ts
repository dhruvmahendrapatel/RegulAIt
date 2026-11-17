import { beforeAll, describe, expect, it, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * MULTIMODAL ATTACHMENTS end to end (mimics Claude's native attach): a chat
 * dispatch may carry base64 images/PDFs on its newest user turn. The turn goes
 * to the provider as a block array (text + image/document blocks); a
 * vision-capable provider sees the bytes, the mock sees a named placeholder.
 * Conversation HISTORY keeps only a named marker, never the base64 — so a later
 * turn does not re-send (or re-bill) the file. Count/size bounds are enforced by
 * the shared schema (400, never a silent truncation). Attachments never widen
 * entitlement: the same governed dispatch runs around them.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed att- and wire asserts locate this suite's dispatch
 * by a unique input marker on the process-wide mock.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "att-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);

// tiny base64 stand-ins — never sent to a network (mock provider)
const IMG64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PDF64 = "JVBERi0xLjQKJcOkw7zDtsOfCg==";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;
let agentId: string;

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

const grant = (userId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "att-agent", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(res.statusCode).toBe(201);
  agentId = res.json().id;
});

describe("multimodal attachments on a governed chat dispatch", () => {
  it("a single-turn dispatch with an image sends a block-array user turn (text + image block), never a bare string", async () => {
    const u = await makeUser("att-img@example.com");
    await grant(u.id);
    const marker = "att-img-marker-xyz please describe";
    const res = await app.inject({
      method: "POST",
      headers: u.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        dispatch: true,
        input: marker,
        attachments: [{ kind: "image", name: "square.png", mediaType: "image/png", dataBase64: IMG64 }],
      },
    });
    expect(res.statusCode).toBe(200);

    // the mock recorded a messages array whose newest turn is a block array
    const wire = mock.dispatches.filter((d) =>
      Array.isArray(d.messages) &&
      d.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.startsWith(marker))),
    ).at(-1);
    expect(wire).toBeDefined();
    const turn = wire!.messages!.at(-1)!;
    expect(Array.isArray(turn.content)).toBe(true);
    const blocks = turn.content as { type: string; dataBase64?: string; mediaType?: string }[];
    expect(blocks[0]).toMatchObject({ type: "text" });
    const img = blocks.find((b) => b.type === "image");
    expect(img).toMatchObject({ type: "image", mediaType: "image/png", dataBase64: IMG64 });
  });

  it("a document (PDF) attachment rides as a document block", async () => {
    const u = await makeUser("att-pdf@example.com");
    await grant(u.id);
    const marker = "att-pdf-marker-xyz read this";
    const res = await app.inject({
      method: "POST",
      headers: u.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        dispatch: true,
        input: marker,
        attachments: [{ kind: "document", name: "spec.pdf", mediaType: "application/pdf", dataBase64: PDF64 }],
      },
    });
    expect(res.statusCode).toBe(200);
    const wire = mock.dispatches.filter((d) =>
      Array.isArray(d.messages) &&
      d.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text.startsWith(marker))),
    ).at(-1);
    const blocks = wire!.messages!.at(-1)!.content as { type: string; dataBase64?: string }[];
    expect(blocks.find((b) => b.type === "document")).toMatchObject({ type: "document", dataBase64: PDF64 });
  });

  it("conversation history keeps a NAMED marker, never the base64 — a later turn does not re-send the file", async () => {
    const u = await makeUser("att-convo@example.com");
    await grant(u.id);
    const convo = await app.inject({
      method: "POST",
      headers: u.auth,
      url: "/v1/conversations",
      payload: { agentId },
    });
    expect(convo.statusCode).toBe(201);
    const conversationId = convo.json().id;

    const res = await app.inject({
      method: "POST",
      headers: u.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: {
        mode: "chat",
        dispatch: true,
        input: "att-convo-marker look",
        conversationId,
        attachments: [{ kind: "image", name: "chart.png", mediaType: "image/png", dataBase64: IMG64 }],
      },
    });
    expect(res.statusCode).toBe(200);

    const view = await app.inject({
      method: "GET",
      headers: u.auth,
      url: `/v1/conversations/${conversationId}`,
    });
    const userMsg = (view.json().messages as { role: string; content: string }[]).find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("att-convo-marker look");
    expect(userMsg.content).toContain("[attached image: chart.png]");
    // the base64 bytes are NOT persisted into history
    expect(userMsg.content).not.toContain(IMG64);
  });

  it("rejects more than 8 attachments (schema bound, not a silent truncation)", async () => {
    const u = await makeUser("att-many@example.com");
    await grant(u.id);
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "image" as const, name: `f${i}.png`, mediaType: "image/png", dataBase64: IMG64,
    }));
    const res = await app.inject({
      method: "POST",
      headers: u.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", dispatch: true, input: "too many", attachments: many },
    });
    expect(res.statusCode).toBe(400);
  });

  it("a plain dispatch with no attachments still rides a bare string turn (byte-identical to before)", async () => {
    const u = await makeUser("att-none@example.com");
    await grant(u.id);
    const marker = "att-none-marker plain request";
    const res = await app.inject({
      method: "POST",
      headers: u.auth,
      url: `/v1/agents/${agentId}/invoke`,
      payload: { mode: "chat", dispatch: true, input: marker },
    });
    expect(res.statusCode).toBe(200);
    // no messages array was synthesized for a plain single-turn dispatch — it
    // rode `input` as a string, exactly as it did before attachments existed
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1);
    expect(wire).toBeDefined();
    expect(wire!.messages).toBeUndefined();
  });
});

afterAll(async () => {
  await restoreSb2Gates();
});
