# Third-party components — `@regulait/connector-provider`

Open-source components this package ships or uses in its tests (ADR-0176 admission rules: MIT, Apache-2.0, BSD or
ISC; maintained; pinned; works air-gapped). npm dependencies are pinned exactly through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `zod` (npm, github.com/colinhacks/zod, © Colin McDonnell) | `4.6.6` (exact; ADR-0192) | MIT | Runtime schema and validation for `connectorProviderConfigSchema` and the connector config/kind contracts in `src/index.ts`. |
| `@types/node` (npm, github.com/DefinitelyTyped/DefinitelyTyped) | `26.1.1` (exact devDependency) | MIT | Type definitions for the Node.js standard library used by the sources and tests; test/build-only, never in a shipped bundle. |
| `vitest` (npm, github.com/vitest-dev/vitest, © Anthony Fu and contributors) | `4.1.11` (exact devDependency) | MIT | Test runner for the `*.test.ts` files in `src/`; test-only, never in a shipped bundle. |

**Checked and not used (ADR-0176 rule 4 exception).** `resend` (npm, Resend's official Node SDK), `6.34.1` released
2026-10-16, MIT, deps `postal-mime` and `standardwebhooks`. It calls the global `fetch` directly and takes no fetch
option, so its requests cannot be routed through the injected egress-guarded fetch every adapter here must use; it also
reads `RESEND_BASE_URL` and `RESEND_API_KEY` from the environment and logs API error bodies outside production. The
unmet requirement is "every request URL adjudicated by the egress guard", so `ResendConnectorProvider` makes its one
call (`POST /emails`) through `fetchImpl` (ADR-0202 lane E). Re-check if the SDK gains a fetch option.
