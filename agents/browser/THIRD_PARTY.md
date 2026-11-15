# Third-party components — managed browser extension (`agents/browser`)

ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained (a release in about the last 12 months); pinned
through `pnpm-lock.yaml`; works air-gapped (the built extension fetches nothing but its own gateway). Checked
2026-11-15 against the npm registry (release dates) and each package's licence field.

## Bundled into the extension

| Package | Version | Licence | Used for, and why |
|---|---|---|---|
| `jose` | `6.2.14` (2026-10-29) | MIT | The S7 `private_key_jwt` client assertion and DPoP proofs by the device key (`src/oauth.ts`), and base64url. Already pinned by the gateway. Policy signatures are verified with WebCrypto Ed25519 directly |
| `re2js` | `2.8.8` (2026-10-17) | MIT | Through `@regulait/shared/dlp-secret-re2`: the RE2 (linear-time) table of the shared `dlp.secret.*` rules. Pinned by `@regulait/shared` |
| `zod` | `4.6.7` (2026-10-12) | MIT | Through `@regulait/shared/browser-governance`: parsing managed config and the policy in the worker. The content script and block page import the zod-free `constants` subpath |

## Build only (not shipped)

| Package | Version | Licence | Used for |
|---|---|---|---|
| `esbuild` | `0.28.2` (2026-08-08) | MIT | Bundling the worker, content script and block page (`scripts/build.mjs`). Already in the lockfile through vite |
| `@types/chrome` | `0.3.7` (2026-10-27) | MIT | Extension API types |
| `typescript`, `vitest`, `@types/node` | workspace versions | Apache-2.0, MIT, MIT | Typecheck and tests |

## Searched and not used

| Package | Licence | Why not |
|---|---|---|
| `webextension-polyfill` 0.12.0 | MPL-2.0 | Not on the licence list, and not needed: MV3 Chromium APIs return promises |
| `wxt` 0.21.5, `@crxjs/vite-plugin` 3.0.0 | MIT | Frameworks that generate the manifest themselves; ours is generated from the site catalogue and pinned by a test |
| `@noble/curves` 2.4.0 | MIT | Not needed: WebCrypto does Ed25519 and P-256 |

The block page and notices use `apps/web/src/theme/tokens.css` (our own design tokens), copied at build time.
