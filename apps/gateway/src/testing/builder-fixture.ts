/**
 * ADR-0172 test kit: one app per builder test file, people with API keys, and
 * mock model bindings. Every name carries a per-run suffix so the files can
 * share a database with each other and with earlier runs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LightMyRequestResponse } from "fastify";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "../app.js";

export interface Person {
  id: string;
  auth: { authorization: string };
}

export interface BuilderKit {
  db: Db;
  app: ReturnType<typeof buildApp>;
  RUN: string;
  BOOT: { authorization: string };
  req: (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => Promise<LightMyRequestResponse>;
  person: (label: string, opts?: { admin?: boolean }) => Promise<Person>;
  model: (label: string, opts?: { model?: string | null; price?: number }) => Promise<string>;
  grantModel: (userId: string, agentId: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function builderKit(prefix: string): Promise<BuilderKit> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/migrations");
  const RUN = Math.random().toString(36).slice(2, 8);
  const bootToken = `${prefix}-boot-${RUN}`;
  const BOOT = { authorization: `Bearer ${bootToken}` };
  const db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const app = buildApp(db, { bootstrapToken: bootToken, dataKey: "a".repeat(64) });
  const req: BuilderKit["req"] = (method, url, headers, payload) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

  const person = async (label: string, opts: { admin?: boolean } = {}): Promise<Person> => {
    const u = await req("POST", "/v1/users", BOOT, { email: `${prefix}-${label}-${RUN}@example.com`, displayName: `${label} ${RUN}` });
    if (u.statusCode >= 300) throw new Error(`user create failed: ${u.body}`);
    const id = u.json().id as string;
    if (opts.admin) {
      const a = await req("POST", `/v1/users/${id}/admin`, BOOT, { isAdmin: true });
      if (a.statusCode >= 300) throw new Error(`admin promote failed: ${a.body}`);
    }
    const k = await req("POST", `/v1/users/${id}/keys`, BOOT, { name: "k" });
    return { id, auth: { authorization: `Bearer ${k.json().token}` } };
  };

  const model = async (label: string, opts: { model?: string | null; price?: number } = {}) => {
    const r = await req("POST", "/v1/agents", BOOT, {
      name: `${prefix}-${label}-${RUN}`,
      provider: "mock",
      tier: 1,
      modes: ["chat"],
      model: opts.model === undefined ? "mock-balanced" : opts.model,
      ...(opts.price !== undefined ? { costPerMTokIn: opts.price, costPerMTokOut: opts.price } : {}),
    });
    if (r.statusCode !== 201) throw new Error(`agent create failed: ${r.body}`);
    return r.json().id as string;
  };

  const grantModel = async (userId: string, agentId: string) => {
    const r = await req("POST", "/v1/grants/agents", BOOT, { userId, agentId });
    if (r.statusCode >= 300) throw new Error(`grant failed: ${r.body}`);
    return r.json().id as string;
  };

  const close = async () => {
    app.server.closeAllConnections();
    await app.close();
  };
  return { db, app, RUN, BOOT, req, person, model, grantModel, close };
}
