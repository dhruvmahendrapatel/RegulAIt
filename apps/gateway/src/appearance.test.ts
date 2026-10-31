/**
 * ADR-0218 (themes phase 2, migration 0256) — a person's palette saved to the account, the organisation default and
 * the admin lock.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *  1. `/auth/me` carries the appearance: nothing saved = the org default palette, mode null.
 *  2. `PUT /auth/appearance` saves the CALLER's own palette and mode; another person's row is untouched; a body naming
 *     a user id is refused (400), as is a palette or mode the app does not ship. Each write has an audit row with
 *     old -> new.
 *  3. A cookie session must carry the CSRF header to write; the bootstrap operator has no account (403).
 *  4. Only an admin sets the org default and the lock (`PUT /v1/org/settings`): a member gets 403 and nothing moves;
 *     an admin's change is audited old -> new, and asks for no step-up.
 *  5. Locked: the effective palette is the org default; a member may save only the default or High contrast (409
 *     `palette_locked`, audited, otherwise); High contrast always stays theirs.
 *  6. The database refuses a palette outside the list too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  userAppearance,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "appearance-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ada: { id: string; auth: { authorization: string } };
let avery: { id: string; auth: { authorization: string } };
let before: { themeDefaultPalette: string; themeLocked: boolean };

async function member(email: string, displayName: string) {
  const u = await app.inject({ method: "POST", headers: ADMIN, url: "/v1/users", payload: { email, displayName } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  const k = await app.inject({ method: "POST", headers: ADMIN, url: `/v1/users/${id}/keys`, payload: { name: "appearance" } });
  expect(k.statusCode, k.body).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token as string}` } };
}

const me = async (auth: Record<string, string>) => (await app.inject({ method: "GET", url: "/auth/me", headers: auth })).json();
const put = (auth: Record<string, string>, payload: unknown) =>
  app.inject({ method: "PUT", url: "/auth/appearance", headers: auth, payload: payload as Record<string, unknown> });
const setOrg = (auth: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/v1/org/settings", headers: auth, payload });
const lastAudit = async (ruleId: string, objectId: string | null) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId))
      .orderBy(desc(auditLog.at))
      .limit(1)
  )[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const stamp = Date.now();
  ada = await member(`ada-admin-appearance-${stamp}@example.com`, "Ada Admin");
  avery = await member(`avery-approver-appearance-${stamp}@example.com`, "Avery Approver");
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  before = { themeDefaultPalette: row!.themeDefaultPalette, themeLocked: row!.themeLocked };
  // every case starts unlocked on the shipped default
  expect((await setOrg(ADMIN, { themeDefaultPalette: "aurora", themeLocked: false })).statusCode).toBe(200);
});

afterAll(async () => {
  await setOrg(ADMIN, before);
  await app.close();
});

describe("saving my own appearance", () => {
  it("nothing saved: the org default, no mode", async () => {
    const a = (await me(avery.auth)).appearance;
    expect(a).toEqual({
      palette: null,
      mode: null,
      effectivePalette: "aurora",
      org: { defaultPalette: "aurora", locked: false },
      saved: true,
    });
  });

  it("saves my palette and mode, audited old -> new, and leaves another person's row alone", async () => {
    const r = await put(avery.auth, { palette: "evergreen", mode: "dark" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().appearance).toMatchObject({ palette: "evergreen", mode: "dark", effectivePalette: "evergreen" });
    expect((await me(avery.auth)).appearance).toMatchObject({ palette: "evergreen", mode: "dark" });
    expect((await me(ada.auth)).appearance).toMatchObject({ palette: null, mode: null });
    const [adaRow] = await db.select().from(userAppearance).where(eq(userAppearance.userId, ada.id));
    expect(adaRow).toBeUndefined();
    const audit = await lastAudit("user-appearance-updated", avery.id);
    expect(audit).toMatchObject({ userId: avery.id, objectType: "user", objectId: avery.id, effect: "allow" });
    expect((audit!.detail as { transitions: unknown }).transitions).toEqual({
      palette: { from: null, to: "evergreen" },
      mode: { from: null, to: "dark" },
    });
    // a mode-only write keeps the palette
    const m = await put(avery.auth, { mode: "system" });
    expect(m.json().appearance).toMatchObject({ palette: "evergreen", mode: "system" });
    expect(((await lastAudit("user-appearance-updated", avery.id))!.detail as { transitions: unknown }).transitions).toEqual({
      mode: { from: "dark", to: "system" },
    });
  });

  it("cannot name another person: a user id in the body is refused and nothing is written", async () => {
    const r = await put(avery.auth, { palette: "orchid", userId: ada.id });
    expect(r.statusCode).toBe(400);
    const [adaRow] = await db.select().from(userAppearance).where(eq(userAppearance.userId, ada.id));
    expect(adaRow).toBeUndefined();
    expect((await me(avery.auth)).appearance.palette).toBe("evergreen");
  });

  it("refuses a palette or mode the app does not ship, and an empty body", async () => {
    for (const body of [{ palette: "neon" }, { palette: "AURORA" }, { mode: "sepia" }, {}, { palette: 3 }]) {
      const r = await put(avery.auth, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error).toBe("invalid_appearance");
    }
    expect((await me(avery.auth)).appearance.palette).toBe("evergreen");
  });

  it("a cookie session needs the CSRF header; the bootstrap operator has no account to save to", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login-with-key",
      headers: CSRF,
      payload: { apiKey: avery.auth.authorization.slice("Bearer ".length) },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "regulait_session")!.value;
    const noCsrf = await app.inject({
      method: "PUT",
      url: "/auth/appearance",
      cookies: { regulait_session: cookie },
      payload: { palette: "graphite" },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe("csrf_header_required");
    expect((await me(avery.auth)).appearance.palette).toBe("evergreen");
    const ok = await app.inject({
      method: "PUT",
      url: "/auth/appearance",
      headers: CSRF,
      cookies: { regulait_session: cookie },
      payload: { palette: "graphite" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().appearance.palette).toBe("graphite");

    const boot = await put(ADMIN, { palette: "orchid" });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("no_user_identity");
    expect((await me(ADMIN)).appearance).toMatchObject({ saved: false, palette: null, effectivePalette: "aurora" });
  });
});

describe("the organisation default and lock", () => {
  it("a member cannot set the org default or the lock", async () => {
    for (const body of [{ themeDefaultPalette: "harbor" }, { themeLocked: true }]) {
      const r = await setOrg(avery.auth, body);
      expect(r.statusCode).toBe(403);
    }
    const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(row).toMatchObject({ themeDefaultPalette: "aurora", themeLocked: false });
  });

  it("an admin refuses an unknown palette with 400", async () => {
    const r = await setOrg(ADMIN, { themeDefaultPalette: "neon" });
    expect(r.statusCode).toBe(400);
  });

  it("an admin sets the default and the lock: audited old -> new, no step-up", async () => {
    const r = await setOrg(ADMIN, { themeDefaultPalette: "harbor", themeLocked: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().settings).toMatchObject({ themeDefaultPalette: "harbor", themeLocked: true });
    const audit = await lastAudit("org-settings-updated", null);
    const detail = audit!.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
    expect(detail.transitions).toMatchObject({
      themeDefaultPalette: { from: "aurora", to: "harbor" },
      themeLocked: { from: false, to: true },
    });
    expect(detail.relaxed).toBeUndefined();
    // unlocking is not a security relaxation either
    const un = await setOrg(ADMIN, { themeLocked: false });
    expect(un.statusCode, un.body).toBe(200);
    const again = await setOrg(ADMIN, { themeLocked: true });
    expect(again.statusCode, again.body).toBe(200);
  });

  it("locked: everyone sees the default; a member may save only the default or High contrast", async () => {
    // Avery saved Graphite before the lock: it is kept, but the lock wins on screen
    expect((await me(avery.auth)).appearance).toMatchObject({
      palette: "graphite",
      effectivePalette: "harbor",
      org: { defaultPalette: "harbor", locked: true },
    });
    const refused = await put(avery.auth, { palette: "orchid" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "palette_locked", org: { defaultPalette: "harbor", locked: true } });
    expect(refused.json().detail).toMatch(/High contrast/);
    expect(await lastAudit("user-appearance-locked", avery.id)).toMatchObject({ effect: "deny", objectId: avery.id });

    const contrast = await put(avery.auth, { palette: "contrast" });
    expect(contrast.statusCode, contrast.body).toBe(200);
    expect(contrast.json().appearance).toMatchObject({ palette: "contrast", effectivePalette: "contrast" });

    const def = await put(ada.auth, { palette: "harbor" });
    expect(def.statusCode, def.body).toBe(200);
    // the mode is never locked
    const mode = await put(ada.auth, { mode: "light" });
    expect(mode.statusCode, mode.body).toBe(200);
    expect(mode.json().appearance).toMatchObject({ palette: "harbor", mode: "light", effectivePalette: "harbor" });
  });

  it("unlocked again: each person's own choice comes back", async () => {
    expect((await setOrg(ADMIN, { themeLocked: false })).statusCode).toBe(200);
    expect((await me(avery.auth)).appearance).toMatchObject({ palette: "contrast", effectivePalette: "contrast" });
    expect((await put(avery.auth, { palette: "orchid" })).statusCode).toBe(200);
    expect((await me(avery.auth)).appearance.effectivePalette).toBe("orchid");
  });
});

describe("the database repeats the palette list", () => {
  it("refuses a palette outside the list on both tables", async () => {
    await expect(
      db.execute(sql`UPDATE org_settings SET theme_default_palette = 'neon' WHERE id = ${ORG_SETTINGS_ID}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE user_appearance SET palette = 'neon' WHERE user_id = ${avery.id}`),
    ).rejects.toThrow();
    await expect(db.execute(sql`UPDATE user_appearance SET mode = 'sepia' WHERE user_id = ${avery.id}`)).rejects.toThrow();
  });
});
