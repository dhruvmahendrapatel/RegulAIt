/**
 * ADR-0225 (security review M1 of #631) — turning the trust pages OFF ends every auditor's access for good.
 *
 * Off is a kill switch, not a pause. When `trust_pages_enabled` goes true -> false, `PUT /v1/org/settings` calls
 * `revokeAuditorAccessOnDisable` inside its own transaction (after it has locked the org row), so every open auditor
 * session and every unused sign-in link is revoked in the same commit as the setting. Turning the pages back on
 * revives nothing: each auditor needs a new link, which needs a step-up.
 *
 * `trustPagesStillOn` is the other half: the writers that create access (redeeming a link, creating a grant, issuing a
 * link) re-read the setting `FOR SHARE` inside their transaction. The settings writer holds the row `FOR UPDATE`, so a
 * redeem cannot commit a session after a disable that it raced.
 *
 * Its own module, importing only @regulait/db: org-settings.ts calls it and trust-pages.ts reads the setting through
 * org-settings.ts, so putting it in either would make an import cycle.
 */
import { and, auditLog, auditorLinks, auditorSessions, eq, isNull, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** revoke every open auditor session and unused link, audited; call only inside the settings write's transaction */
export async function revokeAuditorAccessOnDisable(tx: Db, userId: string | null, now = new Date()): Promise<{ sessions: number; links: number }> {
  const sessions = await tx
    .update(auditorSessions)
    .set({ revokedAt: now })
    .where(isNull(auditorSessions.revokedAt))
    .returning({ id: auditorSessions.id });
  const links = await tx
    .update(auditorLinks)
    .set({ revokedAt: now })
    .where(and(isNull(auditorLinks.usedAt), isNull(auditorLinks.revokedAt)))
    .returning({ id: auditorLinks.id });
  await tx.insert(auditLog).values({
    userId: userId ?? NO_IDENTITY,
    objectType: "auditor_grant",
    objectId: null,
    detail: { sessionsRevoked: sessions.length, linksRevoked: links.length },
    effect: "allow",
    ruleId: "auditor-access-revoked-pages-off",
    ruleChain: [],
    reason:
      `trust pages turned off: ${sessions.length} auditor session(s) and ${links.length} unused sign-in link(s) revoked; ` +
      "turning the pages on again restores none of them",
  });
  return { sessions: sessions.length, links: links.length };
}

/** is the setting still on, read under a share lock on the org row (inside a transaction that creates access) */
export async function trustPagesStillOn(tx: Db): Promise<boolean> {
  const [row] = await tx
    .select({ on: orgSettings.trustPagesEnabled })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID))
    .for("share");
  return row?.on === true;
}
