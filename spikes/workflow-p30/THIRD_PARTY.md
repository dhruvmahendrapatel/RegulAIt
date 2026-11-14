# Third-party packages: P30 spike (research only, not shipped)

Nothing in this directory ships. ADR-0254 rejects the engine, so this is the inventory a re-evaluation would start from,
not a clearance. The direct versions are exact pins in `package.json`. The resolved tree is in `evidence/resolved-2026-11-07.txt`; no lockfile is committed (see README).

| Direct dependency | Version | Licence |
|---|---|---|
| `workflow` | 5.4.0 | Apache-2.0 |
| `@workflow/world-postgres` | 5.1.1 | Apache-2.0 |
| `fastify` | 5.12.6 | MIT |
| `pg` | 8.20.0 | MIT |

The installed tree has 327 top-level entries (~265 MB) by declared licence: MIT 306, Apache-2.0 54, ISC 19, BSD-3-Clause
5, BSD-2-Clause 3, plus one each of Apache-2.0 AND MIT, 0BSD and (MIT OR CC0-1.0). Three need a closer look before anything
could ship:

- `argparse` 2.0.1 is Python-2.0. That is permissive, but it is not on the ADR-0176 list.
- `minimatch` 10.2.6 is BlueOak-1.0.0. That is permissive, but it is not on the ADR-0176 list.
- `@vercel/cli-auth` 0.0.1 declares no licence. It is a dependency of `@workflow/cli`.

`npm audit` on 2026-11-07 reports 28 advisories (23 high, 5 moderate). Two are reached at run time:

- `zod` <4.6.6, pinned `~4.5.4` by `@workflow/world` and `@workflow/core`;
- `undici` 7.30.0, pinned by `@workflow/world-local`.

Neither can be patched inside the upstream ranges.
