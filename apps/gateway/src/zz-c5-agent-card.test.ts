/**
 * Demo task C5 — `GET /v1/agents/:id/card`.
 *
 * Pinned: declared purpose/data come from model cards and are labelled as
 * declarations; guardrails reflect an agent override when one exists (and the
 * org baseline otherwise); use cases that name the agent are listed; tools are
 * a LINK to the inventory, not a second copy; unowned is a flag, never a
 * default; admin-only. Scoped to ids this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, guardrailConfigs, modelCards, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `c5-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;

const call = (method: "GET" | "POST", url: string, headers = AUTH, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

describe("the agent card", () => {
  it("composes declared purpose, effective guardrails and use cases, and links tools", async () => {
    const a = await call("POST", "/v1/agents", AUTH, {
      name: `c5-agent-${RUN}`, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced",
    });
    expect(a.statusCode).toBe(201);
    const agentId = a.json().id as string;

    // before any card or override: honest emptiness, never a default owner
    const bare = await call("GET", `/v1/agents/${agentId}/card`);
    expect(bare.statusCode, bare.body).toBe(200);
    expect(bare.json().owner.state).toBe("unowned");
    expect(bare.json().purpose.intendedUses).toEqual([]);
    expect(bare.json().oversight.modelCardApproved).toBe(false);
    const baselineToxicity = bare.json().guardrails.modes.toxicity;

    await db.insert(modelCards).values({
      agentId,
      intendedUse: `Credit-limit recommendations ${RUN}`,
      dataClaims: { categories: ["personal", "financial"] },
      limitations: "Not for adverse-action notices",
    });
    // an agent-scoped override replaces the org default for this agent
    await db.insert(guardrailConfigs).values({ scope: "agent", scopeId: agentId, toxicityMode: "block" });

    const u = await call("POST", "/v1/users", AUTH, { email: `c5-${RUN}@example.com`, displayName: "P" });
    const key = (await call("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" })).json().token;
    const uc = await call("POST", "/v1/use-cases", { authorization: `Bearer ${key}` }, {
      name: `c5-use-case-${RUN}`, description: "synthetic", businessContext: "demo",
      dataSensitivity: "confidential", intendedAgentIds: [agentId],
    });
    expect(uc.statusCode, uc.body).toBe(201);

    const card = await call("GET", `/v1/agents/${agentId}/card`);
    expect(card.statusCode).toBe(200);
    const b = card.json();
    expect(b.purpose.intendedUses).toEqual([`Credit-limit recommendations ${RUN}`]);
    expect(b.purpose.limitations).toEqual(["Not for adverse-action notices"]);
    expect(b.dataSources.declared[0].claims).toEqual({ categories: ["personal", "financial"] });
    expect(b.dataSources.note).toContain("not observed");
    expect(b.guardrails.modes.toxicity).toBe("block");
    // POSITIVE CONTROL: the override changed something — toxicity was not
    // already 'block' before it existed, or this assertion would prove nothing
    expect(baselineToxicity).not.toBe("block");
    expect(b.oversight.modelCards).toBe(1);
    expect(b.oversight.modelCardApproved).toBe(false); // a card is not an approval
    expect(b.useCases.map((x: { name: string }) => x.name)).toEqual([`c5-use-case-${RUN}`]);
    expect(b.links.tools).toBe(`/v1/inventory/agents/${agentId}`);

    // admin-only, like the inventory it links to
    expect((await call("GET", `/v1/agents/${agentId}/card`, { authorization: `Bearer ${key}` })).statusCode).toBe(403);
    expect((await call("GET", "/v1/agents/00000000-0000-0000-0000-000000000000/card")).statusCode).toBe(404);
  });
});
