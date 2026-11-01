# ADR-0218: Themes saved to the account, an organisation default palette and an admin lock

- **Status**: Accepted
- **Date**: 2026-10-30
- **Builds on**: T1 phase 1 (owner decision on #453, 2026-10-21: six palettes and the Appearance card, browser only),
  ADR-0169 (theme), ADR-0021 (org settings), ADR-0180 (secure by default), ADR-0196 (size budgets)

## Context

Phase 1 shipped six palettes (Aurora, Harbor, Evergreen with a teal accent, Graphite, Orchid, High contrast) and Light,
Dark or Match my device, kept in the browser only (`regulait.palette`, `regulait.theme`). A person who signs in on a
second browser starts again from Aurora, and an organisation cannot choose a house palette or hold everyone to it. The
owner approved phase 2: save the choice to the account, add an organisation default set by an admin, and an admin lock,
with High contrast always selectable by anyone (accessibility).

## Decision

1. **Saved to the account.** A new table `user_appearance` (migration 0259, hand-written) holds one row per person: their
   palette and mode, each nullable ("nothing saved"). `/auth/me` carries `appearance` (the saved values, the palette to
   paint, the organisation default and lock), so the console repaints in the account's palette on any browser.
   Browser storage stays as the pre-paint cache: the page paints from it first, then adopts the account's values.
2. **Written only by the person.** `PUT /auth/appearance` writes the caller's own row, keyed by the session's user id;
   there is no user id in the path or body (a body naming one is refused, the schema is strict). The bootstrap operator
   has no account (403 `no_user_identity`). Palette and mode are validated against the shipped lists (400), and the
   table's CHECKs repeat the lists. The write and its audit row (`user-appearance-updated`, old → new per field) are one
   transaction. Cookie writes carry the CSRF header (the gateway's existing wall).
3. **Organisation default and lock.** Two org settings, `themeDefaultPalette` (default `aurora`) and `themeLocked`
   (default off), written only through the existing admin-only `PUT /v1/org/settings`, which audits every change old →
   new in the write's transaction. Settings › Organisation shows them in a lazy-loaded Themes card.
4. **The lock never takes High contrast away.** While locked, the palette everyone sees is the organisation default,
   unless the person chose High contrast. Saving any other palette while locked is refused (409 `palette_locked`,
   audited as a deny). A choice saved before the lock is kept and comes back when the lock is lifted. The mode is never
   locked.
5. **No step-up.** Both org keys are exemptions in the strictness registry (`org-setting-strictness.ts`): a palette and
   a presentation lock protect nothing an admin could loosen, so changing them asks for no `settings_relax` step-up.

## Why the lock ships off (ADR-0180)

ADR-0180 makes every setting default to its strict value. The theme lock is a presentation setting, not a security
control: locked or not, nothing a person can reach, read or do changes, and High contrast stays open either way. So
"strict" has no meaning for it, and the default that changes nothing for an existing organisation (each person keeps
their own palette) is the one shipped.

## Consequences

- One migration (0259), one ADR, two org settings, one self-service route. The Appearance card says the choice is saved
  to the account (or kept in this browser for the bootstrap operator) and, while locked, offers only the default and
  High contrast.
- The palette list now lives in two places, `@regulait/shared` (`THEME_PALETTE_IDS`, the gateway and the CHECKs) and
  `apps/web/src/theme/palette.ts`; a web unit test pins that they agree.
- The entry bundle gains only a dynamic import: the code that adopts and saves the account's appearance loads on
  demand, and the admin card is a lazy chunk.
