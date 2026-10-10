# ADR-0188 delegation conformance vectors

S5 must pass this corpus through its own adapter and real routes. These vectors were derived solely from ADR-0188 text at `b91c6072b2e28c38bed163c68ff33be6635b852c` (PR #302). No product implementation, product tests, shared wire contracts, prior review ledger or spike/probes were consulted. The task authorization is X49 on owner board `2536ab4b4ca5ad54efd6741534f91c720770a302`, To Codex 17:05.

`cases.json` contains semantic inputs and one root form template. Each case names its exact ADR section in `sections`; `input` describes preconditions or a single mutation of an otherwise valid exchange, and `expected` gives the required behavior. `eligible` means that this particular control permits continuation **only if all other controls pass**; it is not a promise of token issuance. Semantic cases isolate the named control; the applicable exchange gate still decides whether the endpoint may reach that control. `active` marks an already normative requirement, not a claim that a route is wired. Template placeholders require an adapter. Input names outside `formPairs` are corpus vocabulary, not API field names. No services, real credentials, private keys or personal data are involved.

| Case family | Exact ADR-0188 source |
| --- | --- |
| Root template, parameter refusals, human proof, output | Decision 15, **The token-exchange wire contract**; Decision 5, **Tokens that leave the process** |
| DPoP `htu`, `htm`, `ath`, age 60/61, future 5/6, nonce, binding | Decision 13, **Our own resource-side verifier**, steps 1–4; Decision 5, Binding |
| Client assertions, replay races and retained claims | Decision 14, **Replay claims are an atomic insert**; Decision 15, Root; S5 security amendment item 7 |
| Single-use human proof and exact request binding | Decision 15, Root; Decision 14, `human_delegation_proof` |
| Every middle actor, current rights and held turns | Decision 17, **The live-chain check reads every ancestor** |
| Stored-path `act` and hop/depth boundaries | Decision 15, Output; Decision 25, **One canonical actor order**; Decision 26, **Depth is the hop count**; Decision 34, **The depth term and the chain check** |
| Child substitution, output key and pre-claim order | Decision 23, **A parent authorises one specific child and body**; Decision 15 as amended |
| External child hold and signed zero depth | **Amendments from the S5 security review**, item 1 |
| Steward/project proof access and strict cap/lifetime | **Amendments from the S5 security review**, items 2 and 6 |
| X.509/SPIFFE issuer/profile/proxy negatives | Decision 21, **X.509 and SPIFFE path validation**; S5 security review items 3 and 4 |
| Timeout cleanup and child audience equality | S5 security review item 5 and recorded child-resource ruling |

The active profile includes the S5 fail-closed refusal `delegation_depth_unenforced` before **any** replay claim or allocation. `signed-depth-enabled` cases are conditional requirements for a future explicitly enabled exchange, after root signed depth is persisted and enforced. They must not be reported as current S5 positives. S4 presence alone does not lift the switch. Later S5 fix-round changes remain **pending** until announced; this corpus claims no validation of any later implementation head.

`crypto.json` supplies genuine Ed25519 signatures made offline with disposable generated keys; only public JWKs are retained. It includes valid generic client assertion/DPoP/authorization signatures, valid signatures with invalid semantic age/audience/signer binding, and a modified payload with the original signature (must fail). `clock` is fixed; adapters must use this time or re-sign with fresh synthetic keys. Nonces and parent token bytes are deliberately synthetic. A valid signature is never sufficient authority.

The crypto fixtures do **not** claim complete positive wire interoperability: the ADR leaves the exact human-proof JWT claim names and complete proof-route JSON envelope unspecified; root request names/types for cap, depth and lifetime are not completely frozen in Decision 15; `authorization_details` item member spelling is descriptive, not a complete schema; Decision 23 leaves whether `delegation` is serialized canonical text or a JSON object unclear, whether `child_cnf` holds a bare thumbprint or `{jkt}` is unclear, and expiry supports either timestamp or lifetime. The authorization fixture uses an illustrative object and `{jkt}` solely for generic signature/hash/binding checks. Exact nonce bytes, key selection header, signature algorithm policy for client assertions, certificate fixture encodings and missing refusal-code priorities are also not frozen here. No invented wire-positive human proof, child exchange or certificate path is supplied. For unresolved code priorities, the adapter must document which independently applicable condition it isolates; semantic refusals marked `exactErrorUnspecified` must not acquire guessed OAuth codes.

Replay cases require two actual replicas and a shared atomic store in S5's integration runner, plus sequential repeats/restart and a winner failing after its retained claim. Child substitution cases require the intended request to remain eligible with the same genuine unused parent authorization; all claim namespaces (including client assertion and endpoint DPoP) and allocations must stay untouched on the substituted attempt. Conditional positive tests must additionally rebuild `act` from stored grants, preserve the sponsor, bind the output to the child key, and enforce the live intersection. Live-chain cases assert zero upstream effects. No corpus self-check substitutes for these product tests.

Run the independent local integrity check:

```sh
node packages/shared/test-vectors/delegation/validate.mjs
```

It checks family coverage, unique ids, declared phases, genuine cryptographic signatures, tamper rejection, RFC 7638 thumbprints, token hashes and actor encoding. It neither imports product code nor certifies endpoint conformance. Required web typecheck/build receipts and filename/basename guard results are reported in the PR; no UI behavior changes are made.
