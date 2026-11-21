<!-- fold: state-recap -->
**E25 (2026-11-16) - deepmerge and braces removed from the promptfoo engine lockfile, not accepted.** Owner decision
2026-11-16: the engines/promptfoo acceptance (ADR-0187 decisions 177 and 225, to 2026-11-16) ends and is not extended.
deepmerge GHSA-gcqx-w48m-w2h4 (via promptfoo's optional peer `puppeteer-extra-plugin-stealth`) and braces
GHSA-vfj7-8cjw-p6xm (via nunjucks' optional peer chokidar 3) had no fixed release and came only through unused optional
peers. Both peers now resolve, through `overrides` `$` references, to `engines/promptfoo/absent-optional-peer`, an empty
manifest that `npm ci --omit=optional` never installs. Both chains are gone from `package-lock.json` (36 optional entries).
node-forge, the third entry, was already fixed (1.4.2). `npm audit --package-lock-only` reports 0, with and without
`--omit=optional`. The installed closure is byte-identical (355 packages, the same SBOM), and `image.test.ts` pins the
result. Closes the E6 pending item (2026-11-15). Not in scope and still open: the garak acceptance in
`engines/garak/THIRD_PARTY.md`, which also runs to 2026-11-16.
