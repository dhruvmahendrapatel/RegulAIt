# Export-signing key custody (ADR-0116)

This directory is **deliberately empty of keys**, and that is the shipping state.

`ADR-0116`'s signed export bundles are signed by a key held by **the deployment** — the
organisation running RegulAIt — not by the software vendor. There is therefore no public key for
this repo to pin, the way `infra/release-keys/` (ADR-0041) and `infra/license-keys/`
(ADR-0052) pin *our* signers. The direction of trust is reversed: the customer's own operator
holds the private key, and the customer's **auditor** is the one who pins its fingerprint.

Same algorithm and same shape as the other two keyrings — Ed25519, SPKI PEM, `<keyId>.pub` — so
there is one signing scheme in this product, not three. This directory exists as the natural home
for a deployment's own `.pub` files if an operator chooses to keep them beside the install, and as
the place to state the custody rules.

## What a deployment must do before `?signed=1` does anything

Until both variables are set, **every signed-export request returns 409** with a named rule and
these instructions. It does not fall back to an unsigned bundle, and it does **not** generate a
keypair for you. A key the product minted for itself proves only "whoever held this machine
signed this", which is precisely the failure ADR-0116 exists to avoid.

1. **Generate the keypair OFF the gateway host**, on a machine you control:

   ```sh
   openssl genpkey -algorithm ed25519 -out regulait-export-2026.key
   openssl pkey -in regulait-export-2026.key -pubout -out regulait-export-2026.pub
   ```

2. **Record the fingerprint.** This is the one value your auditors need:

   ```sh
   echo "sha256:$(openssl pkey -pubin -in regulait-export-2026.pub -outform DER | sha256sum | cut -d' ' -f1)"
   ```

3. **Install the private key** where only the gateway process can read it (`chmod 400`, owned by
   the service account) and point the deployment at it:

   ```sh
   REGULAIT_EXPORT_SIGNING_KEY=/etc/regulait/export-keys/regulait-export-2026.key
   REGULAIT_EXPORT_SIGNING_KEY_ID=regulait-export-2026
   ```

   `GET /v1/exports/signing-key` will then report the same fingerprint you computed in step 2.
   If those two values ever disagree, the deployment is not signing with the key you think it is.

4. **Publish the fingerprint out of band, once, per auditor.** An engagement letter, a signed
   PDF, a value read aloud on a call, a line in your SOC 2 evidence index — anywhere the person
   who produces a bundle cannot edit afterwards. Do **not** tell an auditor to take the
   fingerprint from a bundle's `README.txt` or `manifest.json`: both are written by whoever
   produced the bundle, and a fingerprint taken from the artifact it is meant to authenticate
   proves nothing.

## What the auditor does with it

```sh
scripts/verify-export-bundle.sh regulait-export-report-run-<id>.tar.gz \
    --fingerprint sha256:<the value you gave them>
```

No database, no gateway, no network, no RegulAIt install. `openssl`, `sha256sum`, `tar` and a
POSIX shell. The script **refuses to run** if no fingerprint or keyring is supplied, because a
bundle cannot establish its own trust root.

## Rotation

Generate a new keypair with a **new key id** and switch the two environment variables. Nothing
that was already signed changes:

- a bundle signed by the old key stays verifiable forever against the **old** fingerprint, or
  against a keyring directory that still contains the old `.pub`;
- an auditor holding a keyring with both `.pub` files verifies both generations;
- a bundle signed by the new key, checked against the old fingerprint, is **refused** and the
  refusal names the fingerprint it actually saw. That is the point: your auditor learns a
  rotation happened and confirms it with you, rather than silently accepting an unfamiliar key.

So the auditor's obligation on rotation is to **retain old fingerprints**, not to re-verify old
bundles.

## What is NOT here, and will not be added by any automated step

- **No private key, ever.** Nothing in this repository, no test, and no install script generates
  a key into this directory or into a deployment. The tests in
  `apps/gateway/src/export-bundle.test.ts` generate ephemeral keypairs in the test process, into
  a temp directory that is removed afterwards, and never touch this path.
- **No production key.** Creating a real signing identity is an owner decision that has been
  explicitly deferred, and `infra/release-keys/` is untouched by ADR-0116.
- **No vendor key.** RegulAIt the vendor does not hold, and cannot hold, a key that attests to
  your data. If a tool ever tells an auditor to "obtain the public key from the vendor" for an
  export bundle, that tool is wrong — it is the exact error ADR-0116 documents in a sibling
  product.
