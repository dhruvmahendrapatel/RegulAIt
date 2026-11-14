# Third-party components — `@regulait/connector-provider`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `4.6.7` (exact; ADR-0192) | MIT | Runtime schema and validation for `connectorProviderConfigSchema` and the connector config/kind contracts in `src/index.ts`. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.6.6` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |

**Checked and not used (ADR-0176 rule 4 exception).** `resend` (npm, Resend's official Node SDK), `6.34.1` released
2026-10-16, MIT, deps `postal-mime` and `standardwebhooks`. It calls the global `fetch` directly and takes no fetch
option, so its requests cannot be routed through the injected egress-guarded fetch every adapter here must use; it also
reads `RESEND_BASE_URL` and `RESEND_API_KEY` from the environment and logs API error bodies outside production. The
unmet requirement is "every request URL adjudicated by the egress guard", so `ResendConnectorProvider` makes its one
call (`POST /emails`) through `fetchImpl` (ADR-0202 lane E). Re-check if the SDK gains a fetch option.

## Activepieces community pieces: vocabulary only, no code (ADR-0255, P31)

`src/pieces.ts` (`CURATED_PIECES`) and the generated `src/pieces-available.ts` (`AVAILABLE_PIECES`) contain no
Activepieces code. No `@activepieces/*` package is a dependency, and nothing from one is bundled or run. What they take
from Activepieces:

- **The curated pieces:** each piece's key, its action names and display names, and their read/write classification.
  These were read on 2026-11-07, without running anything, from the pinned npm tarballs of `@activepieces/piece-slack`
  `0.23.1`, `@activepieces/piece-jira-cloud` `0.6.4`, `@activepieces/piece-github` `0.11.1`,
  `@activepieces/piece-google-sheets` `0.19.5` and `@activepieces/piece-gmail` `0.18.6`. The request builders are our
  own, written against each vendor's public REST API.
- **The available list:** the names, versions and upstream paths of the other `@activepieces/piece-*` packages
  (`scripts/connector-catalogue-refresh.mjs`, a dev-time tool).
  - The versions come from the public npm registry search API.
  - An entry is kept only if the upstream tree, at the commit recorded in `AVAILABLE_PIECES_SOURCE`, has
    `packages/pieces/community/<key>/package.json` declaring that exact name.
  - Names with no community source are dropped, including those under `packages/pieces/core/`.

**Why the licence is MIT.**
- None of the curated packages has an npm `license` field, so the package metadata does not settle it.
- Every `@activepieces/piece-*` package is published from `packages/pieces/community/<key>` of
  github.com/activepieces/activepieces.
- That repository's root `LICENSE` (© 2020-2024 Activepieces Inc.; checked 2026-11-07) licenses all content under "MIT
  Expat", except `packages/ee/` and `packages/server/api/src/app/ee`, which are under the proprietary
  `packages/ee/LICENSE`. Third-party components keep their own licences.
- The community path is outside both excluded directories, so the MIT terms follow from the root file.
- Each curated entry records `upstream.path`. `scripts/activepieces-ee-guard.mjs` fails CI if a path is outside
  `packages/pieces/community/`, or if any `ee` path, EE package import or EE lockfile entry appears in the repository.

**Checked and not used (ADR-0176 rule 4 exception).** These are `@activepieces/pieces-framework` `0.32.0`, MIT, and
`@activepieces/pieces-common` `0.12.5`, MIT, together with the pieces themselves. They miss three requirements:
- A piece makes its HTTP calls through `pieces-common`'s `axios` 1.15.2 client or a vendor SDK, and neither takes an
  injected fetch. So "every request URL adjudicated by the egress guard" cannot be met.
- A piece receives its credential as `context.auth` and keeps state in the engine's `context.store`. So "credentials
  only in our secret store" cannot be met.
- The framework carries the Activepieces engine contract, including `ai` 6.0.0 and `@activepieces/shared`.

Re-check if the framework gains an injectable HTTP client and an externally supplied credential.
