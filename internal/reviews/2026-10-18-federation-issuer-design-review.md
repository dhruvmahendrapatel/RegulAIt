# Design review: the separate RS256 federation issuer (ADR-0197 Q11, 2026-10-18)

Scope: #420 / ADR-0195 SD2b (migration 0205). Read: ADR-0195, ADR-0188, migration 0205, the federation signer and
routes, the Ed25519 key store and delegated-token verifier, `packages/cloud-discovery`, and the customer docs and Terraform.

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

One JWKS holding both `OKP` and RSA keys is possible but unsafe:

- **No cloud documents how it handles an `OKP` key in a trusted JWKS.** Entra documents only RS256. AWS and GCP do
  not say whether they skip a key type they do not support or reject the whole document.
- **Third parties trust the root JWKS.** `/.well-known/jwks.json` is the key set that external relying parties (for
  example MCP servers verifying ADR-0188 identity assertions, `mcp-identity-assertion.ts`) are told to trust. If an
  RSA key that signs cloud tokens sat in that set, any relying party that verifies "any key in the JWKS" without
  pinning `alg` or checking `aud` would accept a RegulAIt-minted cloud token.A separate JWKS removes that class
  of mistake.

### 2. One issuer URL or two

| | Two issuers (as built) | One issuer |
|---|---|---|
| `iss` | `<public URL>` (Ed25519) and `<public URL>/federation` (RS256) | `<public URL>` for both |
| Discovery document | `/federation/.well-known/openid-configuration` advertises `RS256` only | The root has **no** OIDC discovery document today (only `jwks.json` and `oauth-protected-resource`). One would have to be added, advertising `RS256` for an issuer whose own tokens are `EdDSA` |
| JWKS | Each JWKS holds one key type | Both key types mixed (see §1) |

**Token confusion when the issuers are separate.** A federation token fails six independent checks at the
delegated-token verifier (`delegated-token.ts`): `EdDSA`-only algorithms, a `kid` looked up only in
`identity_signing_keys`, the pinned `issuer`, the required `cnf` binding, `typ` `at+jwt`, and an `issued_tokens` row.

In the other direction, a delegated Ed25519 token sent to a cloud fails on algorithm, on `iss` (the trust names
`/federation`) and on `aud`.

**Token confusion with one issuer.** The verifier's algorithm and key-table pins would still block an RS256 token. On
the cloud side, however, `iss` would no longer separate the two kinds of token. A trust policy that is too broad (no
`sub` condition, which the AWS console allows) would then rest on the algorithm alone. Separate issuers keep `iss` as a
second, independent barrier.

### 3. Key lifecycle, rotation, revocation and the data-key envelope

- **Custody differs on purpose.** The Ed25519 private key is a deploy-time PEM file that is never stored in the
  database (ADR-0188 decision 5). The RS256 private key is generated in the product and stored as PKCS#8 under the data
  key (`private_key_ciphertext`, registered in `CIPHERTEXT_COLUMNS`, `data-key.ts:287-289`). A dump plus the data key
  already yields every stored cloud and git secret, so this adds no new exposure (see Risks).
- **The table's invariants are strong:** one active key, no private half after retire or revoke, write-once stamps,
  no DELETE or TRUNCATE, audited step-ups re-checked under the table lock.
- **Gap: rotation does not publish the next key first.** `isPublished` and `publishedFederationKeys` leave out pending
  keys, so the new key appears in the JWKS at the same moment it signs its first token. A cloud that cached the old
  JWKS can then reject tokens for an unknown `kid` until it fetches again. Our own cache header is 60 s; the clouds'
  refetch behaviour is not documented. The standard fix is to publish the next key before it signs: publishing a
  public half that has signed nothing is harmless, and revoking the key still removes it at once. Retired keys already
  stay published for 600 s after rotation.
- **What revocation cannot reach.** A revoked key leaves the JWKS at once, but minted tokens (at most 300 s) and the
  cloud sessions obtained with them (AWS `DurationSeconds: 3600`, `aws.ts:221`) run to expiry. This is inherent to
  federation; the UI and runbook should say so.

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

**Doc drift that would break a customer.** `CLOUD_DISCOVERY.md:10-14` still says the token is "not built yet", and
`CLOUD_DISCOVERY.md:41`, `aws.tf:6,10-11` and `azure.tf:6,13-14` call the issuer "RegulAIt's ADR-0188 issuer" or
"workload identity issuer URL". Entering the root URL makes every exchange fail. The Cloud federation card shows the
right value, but the Terraform comes first in a customer's setup.

### 5. Operational simplicity for customers

Customers configure **one** trust per cloud, against `/federation`; the Ed25519 issuer is never registered at a
cloud. Merging would simplify nothing for them; the only cost is pasting the right URL (change 2).

## Risks

- **Rotation outage** until the clouds refetch the JWKS (medium; not exercised in the demo). Change 1.
- **Wrong issuer registered** by a customer (medium). Change 2.
- **Database dump plus data key yields the federation key** (low; the same pair already exposes stored secrets).
  Later: an operator-supplied key file.
- **Not yet run against a real account** (M-041; medium). Covered by ADR-0197's first-week real-account round trips.

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

> **Q11 design review (2026-10-18, ADR-0197).** The separate issuer `<REGULAIT_PUBLIC_URL>/federation` is kept: RS256
> is the one algorithm AWS, GCP and Entra all accept, and the root JWKS, which third parties trust, stays Ed25519-only.
> Customers configure one trust per cloud. A pending federation key is published before it signs. Revocation cannot
> end cloud sessions already obtained.
