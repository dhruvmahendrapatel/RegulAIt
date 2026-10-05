# Third-party runtime dependencies added deliberately

One line per dependency added under the owner's direction (2026-10-05) to prefer proven, permissively
licensed open source over hand-written code for standard problems. Each works offline (no runtime
network calls), so an air-gapped deployment is unaffected.

| Package | Version | Licence | Why |
|---|---|---|---|
| `jose` | 6.2.12 | MIT | Verifies the Teams Bot Framework's Bearer JWT (`jwtVerify`) against the JWKS named by the workspace's OpenID metadata (`createRemoteJWKSet`, with its key-set cache and unknown-key refresh), ADR-0173 batch 2b. Already in the lockfile through `openid-client`; now a direct, exact-pinned dependency. No dependencies. Its only network use is the key-set fetch, which goes through our egress-guarded fetch (`customFetch`), so with no allow entry it makes no call. |
