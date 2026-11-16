<!-- fold: pending -->
**E6 (2026-11-15) - deepmerge GHSA-gcqx-w48m-w2h4 (low) has no fixed release; the engines/promptfoo acceptance expires 2026-11-16.**
- **Advisory:** `mergeObject()` lets a crafted source object poison the prototype of the returned object. Affects
  deepmerge `>=4.2.0 <=4.3.1`; 4.3.1 (2023-03-16) is the latest release, so no version fixes it.
- **Exposure:** only `engines/promptfoo/package-lock.json`, through `puppeteer-extra-plugin-stealth` →
  `puppeteer-extra-plugin-user-preferences` → `deepmerge`. All three are `optional` in the lockfile and the image installs
  with `npm ci --omit=optional`, so none ships (`npm audit --package-lock-only --omit=optional`: 0 vulnerabilities,
  2026-11-15). `packages/engine-promptfoo/src/image.test.ts` fails if any of them stops being optional. Not in
  `pnpm-lock.yaml` or any other lockfile.
- **Mitigation:** none needed while the chain stays optional and uninstalled. Not dismissed or allow-listed: the
  Dependabot alert stays open. The acceptance recorded in `engines/promptfoo/THIRD_PARTY.md` (ADR-0187 decisions 177 and
  225) runs to 2026-11-16, so the master needs to extend it or drop the chain. Re-check at each deepmerge,
  puppeteer-extra or promptfoo release.
