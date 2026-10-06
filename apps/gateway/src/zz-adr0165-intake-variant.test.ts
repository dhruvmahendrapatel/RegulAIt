/**
 * ADR-0165 — use-case sign-offs can be routed to a governance owner at any
 * time, through a named intake VARIANT (`ai-use-case-intake/<label>`).
 *
 * Template names are unique even once retired, so before this the built-in
 * self-review shape — minted on the first use case — could never be
 * superseded. Pinned: the built-in shape still routes a sign-off to its
 * requester; a variant created from the gallery with a concrete approver routes
 * every NEW use case to that approver (the earlier one keeps its snapshot);
 * retiring the variant falls back to the built-in shape. Shared database: the
 * variant is retired in afterAll so later files see the default (M-040).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, runMigrations, workflowTemplates, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { regressionAcceptance } from "./testing/decision-regression.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g165-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const VARIANT = `ai-use-case-intake/g165-${RUN}`;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "proposer" | "owner", { id: string; auth: { authorization: string } }>;
let variantId = "";

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** create a use case as the proposer, drive it to sign-off, return the sign-off's approver */
async function signoffApproverFor(name: string): Promise<string> {
  const r = await call("POST", "/v1/use-cases", users.proposer.auth, {
    name, description: "synthetic", businessContext: "ADR-0165 routing", dataSensitivity: "internal",
  });
  expect(r.statusCode, r.body).toBe(201);
  const instanceId = r.json().instance.id as string;
  expect((await call("POST", `/v1/workflows/instances/${instanceId}/advance`, users.proposer.auth, { stageId: "plan" })).statusCode).toBe(200);
  const art = await call("POST", `/v1/workflows/instances/${instanceId}/artifacts`, users.proposer.auth, { stageId: "questionnaire", content: "## Purpose\n\nsynthetic" });
  expect([200, 201]).toContain(art.statusCode);
  const pending = (await call("GET", "/v1/approvals?status=pending", AUTH)).json().approvals as Array<{ instanceId: string; stageId: string; approverUserId: string }>;
  const signoff = pending.find((a) => a.instanceId === instanceId && a.stageId === "signoff");
  expect(signoff, "a pending sign-off for the new use case").toBeDefined();
  return signoff!.approverUserId;
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  for (const [k, isAdmin] of [["admin", true], ["proposer", false], ["owner", false]] as const) {
    const u = await call("POST", "/v1/users", AUTH, { email: `g165-${k}-${RUN}@example.com`, displayName: k, isAdmin });
    const id = u.json().id as string;
    users[k] = { id, auth: { authorization: `Bearer ${(await call("POST", `/v1/users/${id}/keys`, AUTH, { name: "k" })).json().token}` } };
  }
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  if (variantId) await db.update(workflowTemplates).set({ retiredAt: new Date(), retiredReason: "g165 cleanup" }).where(eq(workflowTemplates.id, variantId));
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0165 intake template variants", () => {
  it("the built-in shape routes a sign-off back to its requester", async () => {
    expect(await signoffApproverFor(`g165 default ${RUN}`)).toBe(users.proposer.id);
  });

  it("a variant with a concrete approver routes every new use case to that approver", async () => {
    // ADR-0182 A11: an intake variant decides every new sign-off, so it is
    // previewed first under the strict decision-regression gate
    const acceptance = await regressionAcceptance(app, users.admin.auth, "intake_template", {
      galleryId: "ai-use-case-intake", name: VARIANT, approverUserId: users.owner.id,
    });
    const created = await call("POST", "/v1/workflows/template-gallery/ai-use-case-intake/create", users.admin.auth, {
      name: VARIANT, approverUserId: users.owner.id, ...acceptance,
    });
    expect(created.statusCode, created.body).toBe(201);
    variantId = created.json().id;
    expect(await signoffApproverFor(`g165 routed ${RUN}`)).toBe(users.owner.id);
  });

  it("retiring the variant falls back to the built-in shape", async () => {
    const r = await call("POST", `/v1/workflows/templates/${variantId}/retire`, users.admin.auth, { reason: "g165 fallback check" });
    expect(r.statusCode, r.body).toBe(200);
    expect(await signoffApproverFor(`g165 fallback ${RUN}`)).toBe(users.proposer.id);
  });
});
