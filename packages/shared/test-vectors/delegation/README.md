# ADR-0188 delegation and token-endpoint specification vectors

Adopted from Codex X49 (PR #320, branch `codex/x49`) under ADR-0191, and reviewed against the **current** ADR-0188
text on `origin/b6-identity-s5` @ `31157923` (ADR blob `7cf988f0`), which carries the S5 security-review
amendments, items 1 to 9. Written from ADR text only: no product implementation, product test or wire contract was
read. These are semantic vectors, not HTTP DTOs; S5/S6 owners write an adapter and run them through the real routes.

Counts: 171 cases = 112 kept from X49 unchanged, 23 revised, 36 new.
19 carry `"pendingBranch": "b6-identity-s5@31157923…"`: their rule exists only on that branch
(S5 items 2-ruling, 6 default-cap step-up, 8 and 9), not yet on `main`. Find them with
`grep -n pendingBranch cases.json`. Re-check them when the branch merges.

## Fields

- `profile`: `active` is the rule as it applies today. `signed-depth-enabled` is conditional: it applies only after
  S4's `depth_limit` exists, the root exchange persists the signed `max_depth`, and the explicit code switch is lifted
  (S5 item 1). Until then every external child exchange is refused `delegation_depth_unenforced`; such vectors must
  never be reported as current positives.
- `expected.effect`: `eligible` means this control lets the request continue **only if every other control passes**.
- `origin`: `X49`, `X49-revised` (with a `revision` note) or `claude-new`.
- `exactErrorUnspecified`, `gap`: the ADR does not fix the code or the precedence; adapters must not guess one.

## Changed X49 vectors, and why

- `human-proof-one-use`: Secret-shaped jti carries CANARY.
- `replay-namespace-isolation`: Secret-shaped key carries CANARY.
- `client-assertion-aud-array`: Citation narrowed to item 7 (single-string aud).
- `act-stored-path`: A three-actor token can only come from a child exchange, which S5 item 1 refuses today; moved to the conditional profile. act-root-single is the active counterpart.
- `depth-stored-0-max-0`: Surface pinned to the kernel depth term: an external child exchange is refused delegation_depth_unenforced first (S5 item 1).
- `depth-stored-3-max-3`: Surface pinned to the kernel depth term: an external child exchange is refused delegation_depth_unenforced first (S5 item 1).
- `depth-stored-4-max-3`: Was token-endpoint invalid_grant/delegation_depth in the active profile, which S5 item 1 makes unreachable; the kernel term refuses delegation-depth.
- `depth-stored-8-max-8`: Surface pinned to the kernel depth term: an external child exchange is refused delegation_depth_unenforced first (S5 item 1).
- `depth-stored-9-max-8`: Was exactErrorUnspecified; decision 34 refuses a hop count outside 1..9 as actor-chain-invalid, and decision 30 runs that term before delegation-depth.
- `s5-not-steward`: Citation narrowed to item 2.
- `s5-no-project-access`: Item 2 now requires an explicit project_members row (master ruling), not ADR-0011 attribution access.
- `s5-cap-required`: Citation narrowed to item 6.
- `s5-lifetime-over-default`: Citation narrowed to item 6; input named after the org setting.
- `s5-tightening-between-proof-exchange`: Citation narrowed to item 6.
- `timeout-grant-revoked`: Item 5: the timeout_grant_revoked audit row names the grant id; no refusal while a grant is live.
- `certificate-issuerNotCA`: Citation narrowed to item 3.
- `certificate-issuerMissingKeyCertSign`: Citation narrowed to item 3.
- `certificate-issuerPathLenTooSmall`: Made concrete: pathLenConstraint 0 with one intermediate below it.
- `certificate-untrustedProxy`: Citation narrowed to decision 21 (forwarded certificate rules).
- `certificate-unauthenticatedProxy`: Citation narrowed to decision 21 (forwarded certificate rules).
- `certificate-headerNotConfigured`: Citation narrowed to decision 21 (forwarded certificate rules).
- `certificate-proxyPeerCertUsedAsClient`: Citation narrowed to item 4.
- `human-proof-sensitive-write-stepup`: Was exactErrorUnspecified; S5 item 8 fixes the 403, the identity_manage step-up and the exact action.body facts.

## Crypto fixtures

`crypto.json` was regenerated (format v2) with fresh disposable Ed25519 keys; the private keys existed only in memory
and are discarded. Each JWS is stored as three separate fields (`protected`, `payload`, `signature`) that the checker
joins with `.`, so no compact token is in the tree. Every secret-shaped value (`jti`, `nonce`, token bytes,
idempotency key) contains `CANARY`; `.gitleaks.toml` allows CANARY matches in this directory only. A valid signature
is never sufficient authority.

## Checks

`node packages/shared/test-vectors/delegation/validate.mjs` (also run by
`packages/shared/src/spec-vectors-0188-0190.test.ts`) checks ids, citations, profiles, pending markers, the S5
invariants (no active child positive; `delegation_depth_unenforced` claims nothing; 900 s default; the step-up body;
one-string `aud`; claim lifetimes; issuer rules; hop-count rule ids), CANARY coverage, real signatures, tamper
rejection and RFC 7638 thumbprints, then proves it rejects deliberate corruptions. Self-consistency only.

## Spec gaps found (ADR-0188 @ b6-identity-s5)

- Precedence between `delegation_depth_unenforced` and `mtls_parent_handoff_unsupported` for an mTLS parent
  (`child-mtls-parent-active`).
- No error code for raising `delegationRootMaxLifetimeSeconds` above 24 h (`s5-max-lifetime-setting-over-24h`).
- The refusal code when a step-up grant names other facts (item 8 says only "refused and not spent").
- No refusal codes for the human-credential rules of owner decision 4 (bootstrap token, virtual key, API key without MFA).
- A child audience other than the parent's (recorded ruling) has no error code (`child-other-audience`).
- Decision 15's root request names and types for cap, depth and lifetime, the human-proof JWT claim names, and whether
  `delegation` is canonical text or an object, remain unfrozen (X49's original notes stand).

## Vector map (id → ADR-0188 paragraph)

| Vector | Profile | Text on | ADR-0188 section | Origin |
|---|---|---|---|---|
| `root-request-template` | active | main | Decision 15 | X49 |
| `request-grant_type-missing` | active | main | Decision 15 | X49 |
| `request-grant_type-duplicate` | active | main | Decision 15 | X49 |
| `request-subject_token-missing` | active | main | Decision 15 | X49 |
| `request-subject_token-duplicate` | active | main | Decision 15 | X49 |
| `request-subject_token_type-missing` | active | main | Decision 15 | X49 |
| `request-subject_token_type-duplicate` | active | main | Decision 15 | X49 |
| `request-resource-missing` | active | main | Decision 15 | X49 |
| `request-resource-duplicate` | active | main | Decision 15 | X49 |
| `request-requested_token_type-missing` | active | main | Decision 15 | X49 |
| `request-requested_token_type-duplicate` | active | main | Decision 15 | X49 |
| `resource-other` | active | main | Decision 15 | X49 |
| `root-actor-token` | active | main | Decision 15 | X49 |
| `subject-session` | active | main | Decision 15 | X49 |
| `human-proof-expired` | active | main | Decision 15 | X49 |
| `human-proof-bad-signature` | active | main | Decision 15 | X49 |
| `human-proof-wrong-agent` | active | main | Decision 15 | X49 |
| `human-proof-mismatch-authorization_details` | active | main | Decision 15 | X49 |
| `human-proof-mismatch-resource` | active | main | Decision 15 | X49 |
| `human-proof-mismatch-project_id` | active | main | Decision 15 | X49 |
| `human-proof-mismatch-env` | active | main | Decision 15 | X49 |
| `human-proof-mismatch-key_thumbprint` | active | main | Decision 15 | X49 |
| `human-proof-one-use` | active | main | Decision 15; Decision 14 | X49-revised |
| `replay-client_assertion` | active | main | Decision 14 | X49 |
| `replay-as_dpop` | active | main | Decision 14 | X49 |
| `replay-rs_dpop` | active | main | Decision 14 | X49 |
| `replay-human_delegation_proof` | active | main | Decision 14 | X49 |
| `replay-delegation_authz` | active | main | Decision 14 | X49 |
| `replay-namespace-isolation` | active | main | Decision 14 | X49-revised |
| `resource-dpop-valid` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-age-60` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-age-61` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-future-5` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-future-6` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-wrong-htm` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-wrong-htu` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-wrong-ath` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-missing-nonce` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-stale-nonce` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-replay-jti` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-wrong-key` | active | main | Decision 13; Decision 5 | X49 |
| `resource-dpop-no-proof` | active | main | Decision 13; Decision 5 | X49 |
| `cnf-invalid-42` | active | main | Decision 13 | X49 |
| `cnf-invalid-43` | active | main | Decision 13 | X49 |
| `cnf-invalid-44` | active | main | Decision 13 | X49 |
| `mtls-no-dpop-fallback` | active | main | Decision 13; Decision 21 | X49 |
| `client-assertion-wrong-issuer` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-wrong-subject` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-aud-array` | active | main | Decision 15; Amendments from the S5 security review, item 7 | X49-revised |
| `client-assertion-aud-wrong` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-older-than-5-min` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-expiry-over-5-min` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-repeated-jti` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-unregistered-key` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-revoked-key` | active | main | Decision 15; Decision 5; Amendments from the S5 security review, item 7 | X49 |
| `client-assertion-valid` | active | main | Decision 15 | X49 |
| `live-chain-middle-identity` | active | main | Decision 17 | X49 |
| `live-chain-middle-grant` | active | main | Decision 17 | X49 |
| `live-chain-middle-authCredential` | active | main | Decision 17 | X49 |
| `live-chain-middle-subjectCredential` | active | main | Decision 17 | X49 |
| `live-chain-middle-ownGrants` | active | main | Decision 17 | X49 |
| `live-chain-middle-haltState` | active | main | Decision 17 | X49 |
| `live-chain-middle-sponsorRights` | active | main | Decision 17 | X49 |
| `live-chain-middle-sponsorEnabled` | active | main | Decision 17 | X49 |
| `live-chain-middle-path` | active | main | Decision 17 | X49 |
| `live-chain-middle-depth` | active | main | Decision 17 | X49 |
| `live-chain-middle-root` | active | main | Decision 17 | X49 |
| `live-chain-middle-project` | active | main | Decision 17 | X49 |
| `live-chain-middle-env` | active | main | Decision 17 | X49 |
| `live-chain-middle-runContext` | active | main | Decision 17 | X49 |
| `live-chain-held-turn` | active | main | Decision 17 | X49 |
| `act-stored-path` | signed-depth-enabled | main | Decision 15; Decision 25; Amendments from the S5 security review, item 1 | X49-revised |
| `depth-stored-0-max-0` | active | main | Decision 26; Decision 30; Decision 34 | X49-revised |
| `depth-stored-3-max-3` | active | main | Decision 26; Decision 30; Decision 34 | X49-revised |
| `depth-stored-4-max-3` | active | main | Decision 26; Decision 30; Decision 34 | X49-revised |
| `depth-stored-8-max-8` | active | main | Decision 26; Decision 30; Decision 34 | X49-revised |
| `depth-stored-9-max-8` | active | main | Decision 26; Decision 30; Decision 34 | X49-revised |
| `child-depth-unenforced` | active | main | Amendments from the S5 security review, item 1 | X49 |
| `child-substitution-child` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-child_cnf` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-authorization_details` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-resource` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-project_id` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-env` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-cap_micros` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-max_depth` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-expires_at` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-substitution-parent_grant_id` | signed-depth-enabled | main | Decision 23 | X49 |
| `child-authorization-valid` | signed-depth-enabled | main | Decision 23; Decision 15 | X49 |
| `child-mtls-parent` | signed-depth-enabled | main | Decision 23 | X49 |
| `signed-root-zero-depth` | signed-depth-enabled | main | Amendments from the S5 security review, item 1 | X49 |
| `child-other-audience` | signed-depth-enabled | main | Amendments from the S5 security review, recorded child resource ruling | X49 |
| `s5-not-steward` | active | main | Amendments from the S5 security review, item 2 | X49-revised |
| `s5-no-project-access` | active | **pending** | Amendments from the S5 security review, item 2 | X49-revised |
| `s5-cap-required` | active | main | Amendments from the S5 security review, item 6 | X49-revised |
| `s5-lifetime-over-default` | active | main | Amendments from the S5 security review, item 6 | X49-revised |
| `s5-tightening-between-proof-exchange` | active | main | Amendments from the S5 security review, item 6 | X49-revised |
| `timeout-grant-revoked` | active | main | Amendments from the S5 security review, item 5 | X49-revised |
| `certificate-unknownCA` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-expired` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-notYetValid` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-wrongSAN` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-wrongTrustDomain` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-leafCA` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-missingDigitalSignature` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-brokenPath` | active | main | Decision 21; Amendments from the S5 security review, items 3 and 4 | X49 |
| `certificate-issuerNotCA` | active | main | Decision 21; Amendments from the S5 security review, item 3 | X49-revised |
| `certificate-issuerMissingKeyCertSign` | active | main | Decision 21; Amendments from the S5 security review, item 3 | X49-revised |
| `certificate-issuerPathLenTooSmall` | active | main | Decision 21; Amendments from the S5 security review, item 3 | X49-revised |
| `certificate-untrustedProxy` | active | main | Decision 21 | X49-revised |
| `certificate-unauthenticatedProxy` | active | main | Decision 21 | X49-revised |
| `certificate-headerNotConfigured` | active | main | Decision 21 | X49-revised |
| `certificate-proxyPeerCertUsedAsClient` | active | main | Decision 21; Amendments from the S5 security review, item 4 | X49-revised |
| `endpoint-dpop-nonce-missing` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `endpoint-dpop-nonce-stale` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `endpoint-dpop-age-61` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `endpoint-dpop-wrong-method` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `endpoint-dpop-wrong-uri` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `endpoint-dpop-wrong-key` | active | main | Decision 13; Decision 15; Spike S0 result, own DPoP profile | X49 |
| `request-over-budget` | signed-depth-enabled | main | Decision 15; Decision 16; Decision 22 | X49 |
| `request-over-scope` | signed-depth-enabled | main | Decision 15; Decision 16 | X49 |
| `root-mtls-bound-output` | active | main | Decision 13; Decision 15; Decision 21 | X49 |
| `human-proof-credential-bootstrap` | active | main | Decision 15; Owner decision 4 | X49 |
| `human-proof-credential-virtual-key` | active | main | Decision 15; Owner decision 4 | X49 |
| `human-proof-credential-api-key-owner-without-required-MFA` | active | main | Decision 15; Owner decision 4 | X49 |
| `human-proof-sensitive-write-stepup` | active | **pending** | Decision 15; Owner decision 4; Amendments from the S5 security review, item 8 | X49-revised |
| `resource-token-wrongAudience` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-wrongEnvironment` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-expiredToken` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-algNone` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-unknownKid` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-signerWorkloadNotIssuer` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-issuedBindingMismatch` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-issuedRowMissing` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `resource-token-issuerKeyRevoked` | active | main | Decision 5; Decision 12; Decision 13 | X49 |
| `child-depth-unenforced-org-limit-only` | active | main | Amendments from the S5 security review, item 1 | claude-new |
| `child-depth-unenforced-root-parent` | active | main | Amendments from the S5 security review, item 1 | claude-new |
| `child-mtls-parent-active` | active | main | Decision 23; Amendments from the S5 security review, item 1 | claude-new |
| `act-root-single` | active | main | Decision 15; Decision 25 | claude-new |
| `s5-project-without-members` | active | **pending** | Amendments from the S5 security review, item 2 | claude-new |
| `s5-admin-not-member` | active | **pending** | Amendments from the S5 security review, item 2 | claude-new |
| `s5-steward-and-member` | active | **pending** | Amendments from the S5 security review, item 2 | claude-new |
| `s5-default-cap-applied` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-uncapped-when-admin-allows` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-default-cap-set-needs-step-up` | active | **pending** | Amendments from the S5 security review, item 6 | claude-new |
| `s5-lifetime-default-15-min` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-lifetime-900` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-max-lifetime-setting-24h` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-max-lifetime-setting-over-24h` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `s5-lifetime-tightened-between-proof-exchange` | active | main | Amendments from the S5 security review, item 6 | claude-new |
| `introspection-aud-array-inactive` | active | main | Amendments from the S5 security review, item 7 | claude-new |
| `introspection-aud-string-active` | active | main | Amendments from the S5 security review, item 7 | claude-new |
| `s5-step-up-other-capMicros` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-maxDepth` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-lifetimeSeconds` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-authorizationDetails` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-resource` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-env` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-agentKeyThumbprint` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-projectId` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-other-agentIdentityId` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `s5-step-up-resolved-defaults` | active | **pending** | Amendments from the S5 security review, item 8; Amendments from the S5 security review, item 6 | claude-new |
| `s5-step-up-matching-facts` | active | **pending** | Amendments from the S5 security review, item 8 | claude-new |
| `replay-claim-lifetime-client_assertion` | active | **pending** | Decision 14; Amendments from the S5 security review, item 9 | claude-new |
| `replay-claim-lifetime-as_dpop` | active | **pending** | Decision 14; Amendments from the S5 security review, item 9 | claude-new |
| `certificate-anchorNotCA` | active | main | Decision 21; Amendments from the S5 security review, item 3 | claude-new |
| `certificate-intermediateNotCA` | active | main | Decision 21; Amendments from the S5 security review, item 3 | claude-new |
| `certificate-pathLen-satisfied` | active | main | Decision 21; Amendments from the S5 security review, item 3 | claude-new |
| `certificate-pathLen-absent` | active | main | Decision 21; Amendments from the S5 security review, item 3 | claude-new |
| `timeout-request-aborted` | active | main | Amendments from the S5 security review, item 5 | claude-new |
| `timeout-before-grant` | active | main | Amendments from the S5 security review, item 5 | claude-new |

## History: X49 PR description (verbatim)

No `codexInputs.md` entry for X49 exists on `codex/x49` or any other branch; the PR #320 description is kept here as
the draft's record.

> Adds an independent ADR-0188 corpus that S5 must pass: 135 semantic/template cases for token-exchange refusal, DPoP, client assertions, one-use human proofs, stored actor chains, depth, live ancestors, certificate/proxy checks and strict S5 amendments. Source is ADR text only at b91c6072; no product implementation, tests, contracts, review ledger or probes were consulted.
>
> Includes eight genuine offline Ed25519 fixtures and a dependency-free integrity validator. Disposable private keys were discarded. README names exact ADR sections, explains unresolved wire details and separates the current delegation_depth_unenforced hold from conditional future signed-depth positives. Later fix-round updates remain pending until announced; this does not claim product endpoint conformance.
>
> Validation on base 2276739b:
> - node packages/shared/test-vectors/delegation/validate.mjs: 135 cases checked, 8 Ed25519 fixtures verified including genuine tamper rejection.
> - pnpm --filter @regulait/web exec tsc --noEmit: PASS.
> - pnpm --filter @regulait/web build: PASS, 1145 modules; existing chunk-size warning.
> - Exact/case filename and local/global HTML/TSX basename guards: PASS across 2362 tracked/new files.
> - git diff --cached --check: PASS.
>
> Only packages/shared/test-vectors/delegation/ changes. No live service operations. Owner authorization: X49, board 2536ab4b4ca5ad54efd6741534f91c720770a302, To Codex 17:05.
