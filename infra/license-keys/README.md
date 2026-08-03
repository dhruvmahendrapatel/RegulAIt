# Pinned license-signing public keys (ADR-0052)

Every file here is one **Ed25519 public key in SPKI PEM form**. Together they are the *license
keyring* — the complete set of signers a deployment will accept a license from. The gateway reads
an install request's `signingKeyId` and looks for `<signingKeyId>.pub` in this directory. If it is
not here the license is **refused even if its signature is internally valid**. That is what pinning
means: the question is never "is this signed?", it is "is this signed by a key you were already
given?".

This is deliberately the **same posture, the same algorithm and the same directory shape** as
`infra/release-keys/` (ADR-0041's update bundles). One signing scheme in this product, not two.
The keyrings are separate because the two artifacts authorise different things — a release-signing
key must not be able to mint licenses, and vice versa.

## Current keyring

| key id | algorithm | SHA-256 of the DER public key | status |
| --- | --- | --- | --- |
| `regulait-license-dev-2026-08` | Ed25519 | `6f9d486c1af5a8ba352848e1a717bee5f1483e3a01eac24377c6bd6b7431bb01` | **DEVELOPMENT KEY — see the warning below** |

Fingerprint any key here with:

```sh
openssl pkey -pubin -in regulait-license-dev-2026-08.pub -outform DER | sha256sum
```

## The honest state of this, today

`regulait-license-dev-2026-08.pub` is a **development key generated during the implementation of
ADR-0052**. Its private half was created in a scratch directory to prove the shape of the keyring
and was **not retained anywhere**. Consequences, stated plainly rather than implied:

- **Nobody can currently sign a license that this repo's default keyring accepts.** That is the
  correct failure direction (fail closed on a forgery), but it also means this keyring is not yet a
  licensing root — it is the *shape* of one.
- **Before the first commercial deployment**, a real keypair must be generated on an offline host,
  its public half committed here, and the development key removed in the same change. Until then,
  treat any license verification against this keyring as a *test of the mechanism*, not a statement
  about entitlement.
- The tests do not depend on this key. `apps/gateway/src/licensing.test.ts` generates an **ephemeral**
  keypair, writes its public half into a temporary keyring, signs a license with the private half in
  memory and points `REGULAIT_LICENSE_KEYRING` at that directory. Real Ed25519 crypto is exercised
  end to end with **no committed secret** — `.gitignore` refuses `*.pem` and `*.key`, and nothing
  here is exempt from that.

## Key custody — who holds what

| artifact | where it lives | who can use it |
| --- | --- | --- |
| private signing key (`*.pem`) | an offline host / HSM controlled by whoever issues licenses. **Never in this repository.** | the license issuer, at issue time only |
| public key (`*.pub`) | this directory. Ships inside every install. | every deployment, for verification only |

`scripts/sign-license.sh` reads the private key from a path you pass with `--key`. It never copies
it, never writes it into the artifact, and never logs it.

Generate a license-signing keypair:

```sh
openssl genpkey -algorithm ed25519 -out regulait-license-<id>.pem
openssl pkey -in regulait-license-<id>.pem -pubout -out regulait-license-<id>.pub
chmod 400 regulait-license-<id>.pem
```

Ed25519 rather than RSA-PSS, for the same reasons `infra/release-keys/README.md` gives: it hashes
internally, so there is no digest-choice or padding-mode decision to get wrong, and
`openssl pkeyutl -sign -rawin` is the only correct way to use it.

## Where the keyring lives at runtime

The gateway resolves the keyring in this order:

1. `$REGULAIT_LICENSE_KEYRING` — an absolute path. This is what a packaged deployment sets (e.g.
   `/etc/regulait/license-keys`).
2. otherwise, `infra/license-keys/` relative to the installed tree — this directory.

If the directory does not exist, **every license is refused**. An unverifiable license is not a
license, and a missing keyring is not a reason to accept one.

## Rotation — what it actually looks like

There is no revocation list and there cannot be one: an air-gapped deployment has nothing to check
it against. Rotation is a **delivery** problem, and it runs in the same order as the release keyring:

1. **Generate** the new keypair offline and publish its fingerprint through a channel that is not
   the license channel.
2. **Add** the new `.pub` to this directory and ship that change *in an update bundle signed by the
   current RELEASE key* (ADR-0041). After it applies, both license keys are pinned.
3. **Issue** the next license signed by the new key. It verifies, because step 2 installed the key.
4. **Remove** the old `.pub` in a later release. Only now does the old key stop being accepted.

Steps 2 and 4 must be separate releases, for the same reason ADR-0041 gives: collapsing them is
unverifiable by construction.

**If the private key is lost or compromised outside that sequence**, there is no in-band recovery.
Every affected deployment must receive the new public key out of band. An "emergency key update"
endpoint would be exactly the hole the pinning exists to close.

## What signing a license does and does not prove

- **Does**: the document's exact bytes — tenant, tier, seat cap, expiry, deployment-mode grant —
  were produced by a holder of the pinned private key and have not changed since.
- **Does not**: that the deployment's clock is honest. Validity is evaluated against the host clock,
  and the host is the customer's own infrastructure. This is disclosed in ADR-0052, not mitigated.
- **Does not**: that the license is the *current* one. A correctly signed older license is still a
  valid signed artifact; installing one is an operator action, and the install history in
  `licenses` is what makes "what was in force when" answerable.
