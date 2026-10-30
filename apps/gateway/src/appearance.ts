/**
 * ADR-0218 (themes phase 2, migration 0238) — a person's palette and light/dark mode, saved to their account.
 *
 * - `appearanceFor` is what `/auth/me` carries, so the console repaints in the account's palette on any browser.
 * - `PUT /auth/appearance` writes the CALLER's own row. There is no user id in the path or body: the row is keyed by
 *   `req.authCtx.userId` alone, so nobody can write another person's choice. The bootstrap operator has no person to
 *   save to (403 `no_user_identity`, as the other self-service routes answer). Cookie writes carry the CSRF header
 *   (app.ts's wall, for every cookie-authenticated mutation).
 * - The palette and mode are validated against the shipped lists (`setAppearanceSchema`, 400), and again by the
 *   table's CHECKs.
 * - While the organisation has locked the theme (`org_settings.theme_locked`, admin-only through the audited
 *   `PUT /v1/org/settings`), a person may pick only the organisation default or High contrast (409 `palette_locked`,
 *   audited). High contrast is an accessibility palette and a lock never takes it away.
 * - The write and its audit row (old -> new) are one transaction.
 */
import type { FastifyInstance } from "fastify";
import { auditLog, eq, userAppearance, type Db, type OrgSettingsRow } from "@regulait/db";
import {
  effectivePalette,
  paletteAllowed,
  setAppearanceSchema,
  type AccountAppearance,
  type ThemeModeId,
  type ThemePaletteId,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

function orgPosture(org: Pick<OrgSettingsRow, "themeDefaultPalette" | "themeLocked">) {
  return { defaultPalette: org.themeDefaultPalette as ThemePaletteId, locked: org.themeLocked };
}

function shape(
  own: { palette: ThemePaletteId | null; mode: ThemeModeId | null } | null,
  org: Pick<OrgSettingsRow, "themeDefaultPalette" | "themeLocked">,
  saved: boolean,
): AccountAppearance {
  const posture = orgPosture(org);
  const palette = own?.palette ?? null;
  return { palette, mode: own?.mode ?? null, effectivePalette: effectivePalette(palette, posture), org: posture, saved };
}

/** the caller's appearance (null user = the bootstrap operator, who has nothing saved) */
export async function appearanceFor(
  db: Db,
  userId: string | null,
  org: Pick<OrgSettingsRow, "themeDefaultPalette" | "themeLocked">,
): Promise<AccountAppearance> {
  if (!userId) return shape(null, org, false);
  const [row] = await db
    .select({ palette: userAppearance.palette, mode: userAppearance.mode })
    .from(userAppearance)
    .where(eq(userAppearance.userId, userId));
  return shape(row ?? null, org, true);
}

export function registerAppearanceRoutes(app: FastifyInstance, db: Db) {
  app.put("/auth/appearance", async (req, reply) => {
    const parsed = setAppearanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_appearance",
        detail: "choose one of the listed themes and modes; nothing was saved",
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "no_user_identity",
        detail: "this sign-in has no account to save to; the choice stays in this browser",
      });
    }
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // the org row is read on this transaction: a lock an admin saves a moment earlier is the one that applies
      const org = await loadOrgSettings(tx);
      const posture = orgPosture(org);
      const [before] = await tx
        .select({ palette: userAppearance.palette, mode: userAppearance.mode })
        .from(userAppearance)
        .where(eq(userAppearance.userId, userId))
        .for("update");
      const prev = { palette: before?.palette ?? null, mode: before?.mode ?? null };
      if (body.palette && !paletteAllowed(body.palette, posture)) {
        await tx.insert(auditLog).values({
          userId,
          objectType: "user",
          objectId: userId,
          detail: { phase: "appearance", requested: { palette: body.palette }, org: posture },
          effect: "deny",
          ruleId: "user-appearance-locked",
          ruleChain: [],
          reason: `palette '${body.palette}' refused: the organisation has locked the theme to '${posture.defaultPalette}'`,
        });
        return { refused: posture } as const;
      }
      const next = {
        palette: body.palette !== undefined ? body.palette : prev.palette,
        mode: body.mode !== undefined ? body.mode : prev.mode,
      };
      await tx
        .insert(userAppearance)
        .values({ userId, palette: next.palette, mode: next.mode, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userAppearance.userId,
          set: { palette: next.palette, mode: next.mode, updatedAt: new Date() },
        });
      const transitions = Object.fromEntries(
        (["palette", "mode"] as const)
          .filter((k) => prev[k] !== next[k])
          .map((k) => [k, { from: prev[k], to: next[k] }]),
      );
      await tx.insert(auditLog).values({
        userId,
        objectType: "user",
        objectId: userId,
        detail: { phase: "appearance", via: req.authCtx.via, transitions },
        effect: "allow",
        ruleId: "user-appearance-updated",
        ruleChain: [],
        reason:
          Object.keys(transitions).length > 0
            ? `appearance updated: ${Object.keys(transitions).join(", ")}`
            : "appearance written with no effective change",
      });
      return { appearance: shape(next, org, true) } as const;
    });
    if ("refused" in out) {
      return reply.status(409).send({
        error: "palette_locked",
        detail: "Your organisation has set the theme for everyone. You can still choose High contrast.",
        org: out.refused,
      });
    }
    return reply.send({ appearance: out.appearance });
  });
}

