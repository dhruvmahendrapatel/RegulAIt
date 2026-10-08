/**
 * ADR-0172 test kit: one app per builder test file, people with API keys, and
 * mock model bindings. Every name carries a per-run suffix so the files can
 * share a database with each other and with earlier runs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LightMyRequestResponse } from "fastify";
import { createDb, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "../app.js";
import { enrolAdminTotpForTest } from "./identity-posture.js";
import { forgetStepUpMethodsForTest } from "./step-up-posture.js";
import { closeAll, dropScratchDatabase } from "./scratch-db.js";

export interface Person {
  id: string;
  auth: { authorization: string };
  /** a project this person is a member of — every builder agent must bill to
   * one (owner rule, 2026-10-04) */
  projectId: string;
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

/**
 * `scratch: true` runs the kit on its OWN database, created here and dropped by
 * `close()` — for a file that writes append-only rows (an approval decision)
 * which must not outlive the run in the shared database.
 */
export async function builderKit(prefix: string, opts: { scratch?: boolean } = {}): Promise<BuilderKit> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/migrations");
  const RUN = Math.random().toString(36).slice(2, 8);
  const bootToken = `${prefix}-boot-${RUN}`;
  const BOOT = { authorization: `Bearer ${bootToken}` };
  const scratchName = opts.scratch ? `${prefix.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${process.pid}_${RUN}` : null;
  const scratchAdmin = scratchName ? createDb(DATABASE_URL) : null;
  let dbUrl = DATABASE_URL;
  if (scratchAdmin && scratchName) {
    await scratchAdmin.execute(sql.raw(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`));
    await scratchAdmin.execute(sql.raw(`CREATE DATABASE ${scratchName}`));
    const u = new URL(DATABASE_URL);
    u.pathname = "/" + scratchName;
    dbUrl = u.toString();
  }
  const db = createDb(dbUrl);
  await runMigrations(db, migrationsFolder);
  const app = buildApp(db, { bootstrapToken: bootToken, dataKey: "a".repeat(64) });
  const req: BuilderKit["req"] = (method, url, headers, payload) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

  /** B4S-06: the admins this kit enrolled, whose methods close() forgets (M-068) */
  const admins: string[] = [];
  const person = async (label: string, opts: { admin?: boolean } = {}): Promise<Person> => {
    const u = await req("POST", "/v1/users", BOOT, { email: `${prefix}-${label}-${RUN}@example.com`, displayName: `${label} ${RUN}` });
    if (u.statusCode >= 300) throw new Error(`user create failed: ${u.body}`);
    const id = u.json().id as string;
    if (opts.admin) {
      const a = await req("POST", `/v1/users/${id}/admin`, BOOT, { isAdmin: true });
      if (a.statusCode >= 300) throw new Error(`admin promote failed: ${a.body}`);
      // ADR-0181 (FX2): an admin's key answers to the org MFA requirement, so
      // an admin person enrols TOTP (real routes) before their key is minted
      await enrolAdminTotpForTest(app, bootToken, id);
      admins.push(id);
    }
    const k = await req("POST", `/v1/users/${id}/keys`, BOOT, { name: "k" });
    const p = await req("POST", "/v1/projects", BOOT, { name: `${prefix}-${label}-${RUN}` });
    if (p.statusCode >= 300) throw new Error(`project create failed: ${p.body}`);
    const projectId = p.json().id as string;
    const m = await req("POST", `/v1/projects/${projectId}/members`, BOOT, { userId: id, role: "contributor" });
    if (m.statusCode >= 300) throw new Error(`project member add failed: ${m.body}`);
    return { id, auth: { authorization: `Bearer ${k.json().token}` }, projectId };
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
    // B4S-06: an admin left with an authenticator would end first-admin setup
    // for every suite after this one (the bootstrap credential would stop passing step-up)
    await forgetStepUpMethodsForTest(db, admins);
    app.server.closeAllConnections();
    await app.close();
    if (scratchAdmin && scratchName) {
      await closeAll([
        async () => db.$client.end(),
        async () => dropScratchDatabase(scratchAdmin, scratchName),
        async () => scratchAdmin.$client.end(),
      ]);
    }
  };
  return { db, app, RUN, BOOT, req, person, model, grantModel, close };
}
