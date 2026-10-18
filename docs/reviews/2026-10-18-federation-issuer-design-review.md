# Design review: the separate RS256 federation issuer (ADR-0197 Q11, 2026-10-18)

Scope: #420 / ADR-0195 "As built: SD2b federation signer (migration 0205)". Read for this review:
ADR-0195 (decision 3, the 2026-10-17 algorithm check, both SD2b sections), ADR-0188 (issuer, delegated tokens,
Ed25519 signer), `packages/db/migrations/0205_federation_signing_keys.sql`, `apps/gateway/src/federation-routes.ts`,
`apps/gateway/src/federation-signing-keys.ts`, `apps/gateway/src/identity-signing-keys.ts`,
`apps/gateway/src/identity-routes.ts`, `apps/gateway/src/delegated-token.ts` (verifier), `apps/gateway/src/data-key.ts`,
`packages/cloud-discovery/src/{aws,azure,gcp,credentials}.ts`, and `docs/deployment/CLOUD_DISCOVERY.md` with
`docs/deployment/cloud-discovery/*.tf`.

## Recommendation

**Keep the separate issuer.** Its design is sound and nothing in it blocks the demo. Make two small changes before
2026-10-29:

1. **Publish a pending key's public half** in the federation JWKS, so a cloud can cache the next key before it starts
   signing. Today a rotation publishes the new key at the same moment it starts signing.
2. **Fix the customer-facing docs.** They still say the token comes from "RegulAIt's ADR-0188 issuer" and is "not
   built yet". A customer who follows them would register the wrong issuer URL.

There is no case for merging the two issuers, and no change to migration 0205 is needed.

## Evidence

### 1. Is a separate RS256 key set required?

Yes. The Ed25519 key cannot serve federation. Which algorithms each cloud accepts:

| Cloud | Accepts | EdDSA | Source |
|---|---|---|---|
| AWS IAM OIDC provider | RS256/384/512, ES256/384/512 | no | IAM User Guide, "Create an OpenID Connect (OIDC) identity provider" (cited in ADR-0195 on 2026-10-17; not re-fetched today) |
| GCP workload identity federation | RS256, ES256 | no | IAM docs, "Configure Workload Identity Federation with other identity providers" (same) |
| Microsoft Entra | **RS256 only** ("other algorithms may work, but haven't been tested") | no | learn.microsoft.com/entra/workload-id/workload-identity-federation-considerations, "Supported signing algorithms and issuers" (re-checked today) |

ES256 would satisfy AWS and GCP, but Entra rules it out, so **RS256 is the only algorithm all three accept**. Entra also
expects `"use": "sig"` on JWKS keys (Microsoft's SPIFFE federation tutorial). `federationJwks` already sets it.

Could one JWKS hold both the Ed25519 (`OKP`) keys and the RSA keys? It is technically possible. It is not safe to rely
on:

- **No cloud documents how it handles an `OKP` key in a trusted JWKS.** Entra documents only RS256. AWS and GCP do
  not say whether they skip a key type they do not support or reject the whole document. Learning this from a failed
  demo exchange is the wrong way to find out.
- **Third parties trust the root JWKS.** `/.well-known/jwks.json` is the key set that external relying parties (for
  example MCP servers verifying ADR-0188 identity assertions, `mcp-identity-assertion.ts`) are told to trust. If an
  RSA key that signs cloud tokens sat in that set, any relying party that verifies "any key in the JWKS" without
  pinning `alg` or checking `aud` would accept a RegulAIt-minted cloud token. A separate JWKS removes that whole class
  of mistake. It does not depend on every relying party being careful.

### 2. One issuer URL or two

| | Two issuers (as built) | One issuer |
|---|---|---|
| `iss` | `<public URL>` (Ed25519) and `<public URL>/federation` (RS256) | `<public URL>` for both |
| Discovery document | `/federation/.well-known/openid-configuration` advertises `RS256` only | The root has **no** OIDC discovery document today (only `jwks.json` and `oauth-protected-resource`). One would have to be added, advertising `RS256` for an issuer whose own tokens are `EdDSA` |
| JWKS | Each JWKS holds one key type | Both key types mixed (see §1) |
| Audiences | Clouds get `sts.amazonaws.com`, `api://AzureADTokenExchange` or the GCP provider; delegated tokens get RegulAIt resources | Same |

**Token confusion when the issuers are separate.** A federation token presented to RegulAIt's delegated-token
verifier fails several independent checks (`delegated-token.ts`):

- `algorithms: [ISSUER_JWS_ALG]` (`EdDSA`) rejects RS256;
- `issuerKeyFor` looks the `kid` up only in `identity_signing_keys`;
- the pinned `issuer` differs;
- `exactlyOneCnf` requires a sender binding, which federation tokens do not have;
- `typ` must be `at+jwt`, and federation tokens carry `JWT`;
- the token must have a row in `issued_tokens`.

In the other direction, a delegated Ed25519 token sent to a cloud fails on algorithm, on `iss` (the trust names
`/federation`) and on `aud`.

**Token confusion with one issuer.** The verifier's algorithm and key-table pins would still block an RS256 token. On
the cloud side, however, `iss` would no longer separate the two kinds of token. A trust policy that is too broad (no
`sub` condition, which the AWS console allows) would then rest on the algorithm alone. Separate issuers keep `iss` as a
second, independent barrier.

### 3. Key lifecycle, rotation, revocation and the data-key envelope

- **Custody differs on purpose.** The Ed25519 private key is a deploy-time PEM file that is never stored in the
  database (ADR-0188 decision 5). The RS256 private key is generated in the product and stored as PKCS#8 under the data
  key (`private_key_ciphertext`, registered in `CIPHERTEXT_COLUMNS`, `data-key.ts:287-289`). A database dump plus the
  data key yields the federation key. The same dump and key already yield every stored cloud and git secret, so this
  adds no new exposure. Option for later (not for the demo): let BYOC operators supply the RSA key as a file, the way
  the Ed25519 key is supplied.
- **The table's invariants are strong.** At most one active key (partial unique index). A live key holds its private
  half and a retired or revoked key never does (CHECK). Each stamp is written once and a destroyed private half never
  returns (trigger, `search_path` pinned). Rows are never deleted, and TRUNCATE is refused. Every change is audited.
  Turning federation on is a `settings_relax` step-up; rotate and revoke are `key_management` step-ups. Each step-up is
  decided on an unlocked read and re-checked under the table lock.
- **Gap: rotation does not publish the next key first.** `isPublished` and `publishedFederationKeys` leave out pending
  keys, so the new key appears in the JWKS at the same moment it signs its first token. A cloud that cached the old
  JWKS can then reject tokens for an unknown `kid` until it fetches again. Our own cache header is 60 s; the clouds'
  refetch behaviour is not documented. The standard fix is to publish the next key before it signs: publishing a
  public half that has signed nothing is harmless, and revoking the key still removes it at once. Retired keys already
  stay published for 600 s after rotation.
- **What revocation cannot reach.** Revoking a key removes it from the JWKS at once, but it cannot recall:
  - minted tokens, which live at most 300 s;
  - cloud sessions already obtained with them: AWS `DurationSeconds: 3600` (`aws.ts:221`), and Entra or GCP access
    tokens with their own lifetimes.

  This is inherent to federation and matches ADR-0188 decision 12 (rotation is not revocation). The admin UI and
  runbook should say so.

### 4. What the demo needs (AWS and Azure keyless federation from the hosted dev instance)

Nothing in the design blocks it. The prerequisites:

1. `REGULAIT_PUBLIC_URL` is an https origin that is publicly reachable, with a certificate from a public CA. AWS and
   Entra fetch `<issuer>/.well-known/openid-configuration` and the JWKS over the internet.
2. A data key is configured.
3. An admin generates a key and activates it, which takes the `settings_relax` step-up.
4. AWS: an OIDC provider with `url` = `<public URL>/federation` and `client_id_list` = `sts.amazonaws.com`. The trust
   conditions key on `<host>/federation:aud` and `:sub`. `aws.tf` derives both from the variable, so they are correct
   once the variable holds the federation issuer.
5. Azure: a federated credential whose issuer is exactly `<public URL>/federation`. Entra matches it as an exact
   string, and `federationIssuer` strips trailing slashes, so they agree. Subject:
   `regulait:discovery-source:<id>`. Audience: `api://AzureADTokenExchange`.
6. Entra takes several minutes to propagate a new federated credential (`AADSTS70021`, same Microsoft page). The demo
   runbook should create the credential well before the first run.

**Doc drift that would break a customer.**

- `CLOUD_DISCOVERY.md:10-14` still says the federation token is "not built yet".
- `CLOUD_DISCOVERY.md:41`, `aws.tf:6,10-11` and `azure.tf:6,13-14` describe the issuer as "RegulAIt's ADR-0188
  issuer" or "workload identity issuer URL". Someone following them would enter the root URL, and every exchange
  would fail.
- The Cloud federation card shows the right issuer, which reduces the risk. The Terraform comes before the card in the
  customer's setup, though, so the docs still need fixing.

### 5. Operational simplicity for customers

For each cloud the customer configures **one** trust: AWS sees only `/federation`, and so do Entra and GCP. The
Ed25519 issuer never has to be registered at a cloud, so a second issuer adds no trust relationship for the customer.
Merging would make nothing simpler for them. The only cost of two issuers is pasting the right URL, which the doc fix
covers.

## Risks (with the issuers kept separate)

| Risk | Severity | Mitigation |
|---|---|---|
| A rotation fails cloud exchanges until the clouds refetch the JWKS | Medium (outside the demo) | Change 1 |
| A customer registers the root issuer | Medium | Change 2 |
| A compromised database plus data key yields the federation key | Low (the same pair already exposes stored secrets) | Later: an operator-supplied key file |
| Revocation does not end cloud sessions (up to 1 h on AWS) | Low (inherent) | State it in the UI and runbook |
| Cloud behaviour not yet seen against a real account (M-041) | Medium | First real-account round trips (ADR-0197) |

## Build plan (one small PR, before 2026-10-29)

Branch `fed-issuer-q11-fixes`. No migration.

1. `federation-signing-keys.ts`:
   - `isPublished` returns true for a pending key (`activatedAt` null, not revoked).
   - `publishedFederationKeys` adds `OR activated_at IS NULL` while keeping `revoked_at IS NULL`.
   - `federationKeyView.published` follows.
   - Minting stays active-key only; it is unchanged.
2. Card copy: "Generated keys are published at once so the clouds can cache them. Activate after a few minutes."
   Update the rotate hint to match.
3. Tests (`federation-signing-keys.test.ts`, `zz-adr0195-sd2b-federation.test.ts`):
   - a pending key is in the JWKS route and signs nothing;
   - revoking a pending key removes it at once;
   - the JWKS still holds RSA keys only.
4. Docs: correct `CLOUD_DISCOVERY.md` (status line, the issuer `<public URL>/federation`, the revocation limits, Entra
   propagation) and the descriptions and comments in `aws.tf`, `azure.tf` and `gcp.tf`.
5. Gate: vitest for the touched files, the gateway build, `demo:prepare`, and both UI preflights.

Estimate: half a day plus review.

## Proposed ADR wording (for the master; owner text untouched)

Proposed as a new paragraph at the end of ADR-0195 "As built: SD2b federation signer (2026-10-17, migration 0205)":

> **Q11 design review (2026-10-18, ADR-0197).** The separate issuer `<REGULAIT_PUBLIC_URL>/federation` is kept. RS256
> is the only algorithm AWS, GCP and Entra all accept. The root JWKS is trusted by third-party relying parties and
> stays Ed25519-only. A cloud trust needs only the federation issuer, so customers configure one trust per cloud. As
> built after the review: a pending federation key is published in the federation JWKS, so the clouds can cache it
> before it signs. Revocation removes a key from the JWKS at once, but cloud sessions already obtained with its tokens
> run to their own expiry.
