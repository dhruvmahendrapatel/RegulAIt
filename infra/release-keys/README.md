# Pinned release-signing public keys (ADR-0041)

Every file here is one **Ed25519 public key in SPKI PEM form**. Together they are the
*keyring* — the complete set of signers a deployment will accept an update from.
`scripts/verify-update-bundle.sh` reads a bundle's `signingKeyId` and looks for
`<signingKeyId>.pub` in this directory. If it is not here, the bundle is refused **even if
its signature is internally valid**. That is what pinning means: the question is never "is
this signed?", it is "is this signed by a key you were already given?".

## Current keyring

| key id | algorithm | SHA-256 of the DER public key | status |
| --- | --- | --- | --- |
| `regulait-release-dev-2026-08` | Ed25519 | `f2cbda4b1471e4070f7bd75edb69617a48cf58721f34607011935933fa629ff1` | **DEVELOPMENT KEY — see the warning below** |

Fingerprint any key here with:

```sh
openssl pkey -pubin -in regulait-release-dev-2026-08.pub -outform DER | sha256sum
```

## The honest state of this, today

`regulait-release-dev-2026-08.pub` is a **development key generated during the
implementation of ADR-0041**. Its private half was created in a scratch directory to prove
the build/verify path end to end and was **not retained anywhere**. Consequences, stated
plainly rather than implied:

- **Nobody can currently sign a bundle that this repo's default keyring accepts.** That is
  the correct failure direction (fail closed), but it also means this keyring is not yet a
  release root — it is the *shape* of one.
- **Before the first customer release**, a real keypair must be generated on an offline
  host, its public half committed here, and the development key removed in the same change.
  Until that happens, treat any bundle verification against this keyring as a *test* of the
  mechanism, not a statement about provenance.

## Key custody — who holds what

| artifact | where it lives | who can use it |
| --- | --- | --- |
| private signing key (`*.pem`) | an offline host / HSM controlled by whoever cuts releases. **Never in this repository** — `.gitignore` refuses `*.pem` and `*.key`, and `scripts/build-update-bundle.sh` prunes both patterns out of any payload it builds. | the release signer, one person or one quorum, at release time only |
| public key (`*.pub`) | this directory. Ships inside every install and inside every update bundle. | every deployment, for verification only |

`scripts/build-update-bundle.sh` reads the private key from a path you pass with `--key`.
It never copies it, never writes it to the bundle, and never logs it.

Generate a release keypair:

```sh
openssl genpkey -algorithm ed25519 -out regulait-release-<id>.pem
openssl pkey -in regulait-release-<id>.pem -pubout -out regulait-release-<id>.pub
chmod 400 regulait-release-<id>.pem
```

Ed25519 rather than RSA-PSS: it hashes internally, so there is no digest-choice or
padding-mode decision to get wrong, the keys are 32 bytes, and `openssl pkeyutl -sign
-rawin` is the only correct way to use it. (The verifier also accepts an RSA/EC
`dgst -sha256` signature, so an organisation whose HSM cannot do Ed25519 is not blocked —
but Ed25519 is the default and the recommendation.)

## Rotation — what it actually looks like

There is no revocation list and there cannot be one: an air-gapped deployment has nothing
to check it against. Rotation is therefore a **delivery** problem, not a protocol problem,
and it runs in this order:

1. **Generate** the new keypair offline. Publish the new `.pub` fingerprint through a
   channel that is not the update channel (signed release notes, a support call, the same
   route the customer got their original install media through).
2. **Add** the new `.pub` to this directory and ship that change *in a bundle signed by the
   OLD key*. This is the only step that matters: the customer's deployment learns the new
   key by way of a bundle it can already verify. After it applies, both keys are pinned.
3. **Cut** the next release signed by the new key. It verifies, because step 2 installed
   the key.
4. **Remove** the old `.pub`, in a bundle signed by the new key. Only now does the old key
   stop being accepted.

Steps 2 and 4 must be separate releases. Collapsing them — shipping a bundle signed by the
new key that also installs the new key — is unverifiable by construction: the deployment
would have to trust the bundle in order to learn the key it needs to trust the bundle.

**If the private key is lost or compromised outside that sequence**, there is no in-band
recovery. Every affected deployment must have the new public key installed out of band, by
the same route as the original install media. Say so to the customer rather than inventing
a fallback: an "emergency key update" endpoint would be exactly the hole the pinning exists
to close.

## What signing does and does not prove

- **Does**: the bundle's manifest — and therefore every file digest in it — was produced by
  a holder of the pinned private key, and nothing has changed since.
- **Does not**: that the release is *current*. A correctly signed old release is still an
  old release, which is why the verifier refuses downgrades separately.
- **Does not**: that the build was reproducible, or that the source matches a git tag.
  Nothing here is a provenance attestation (SLSA/in-toto). If that is required, it is a
  further slice, not something this keyring quietly covers.
