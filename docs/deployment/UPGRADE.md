# Upgrading a RegulAIt deployment — signed, offline-verifiable update bundles

[ADR-0041](../decisions/0041-byoc-primary-motion.md) names this as load-bearing scope, not polish:
if the primary motion is *many customer-hosted deployments*, then fleet lifecycle
(GOVERNANCE_LAYER_SPEC §8.2) means updates must be **cryptographically verifiable offline before
they are applied** — because an air-gapped customer has no way to check anything with us at apply
time, and because the alternative is asking a regulated buyer to run a tarball someone emailed
them.

```sh
./scripts/verify-update-bundle.sh regulait-update-0.2.0.tar.gz   # verify (offline)
./scripts/apply-update-bundle.sh  regulait-update-0.2.0.tar.gz   # verify, stage, swap, converge
```

---

## What a bundle is

```
regulait-update-<version>.tar.gz
└── regulait-update-<version>/
      manifest.json        version, key id, and a SHA-256 for every file
      manifest.json.sig    detached Ed25519 signature over manifest.json (base64)
      payload/…            the files
```

**The signature covers the manifest, not the tarball.** A signature over the archive proves it
arrived intact and nothing else — you would still have to trust the extractor. Signing a manifest
that names every file with its digest lets the verifier decide file-by-file, and lets it detect a
file that was *added* (present in the payload, absent from the manifest), which a whole-archive
hash cannot usefully express.

Ed25519 via `openssl pkeyutl -sign -rawin`. Ed25519 hashes internally, so there is no digest choice
and no padding mode to get wrong. RSA-PSS would have been acceptable too; the verifier also accepts
an RSA/EC `dgst -sha256` signature so an HSM that cannot do Ed25519 is not excluded.

---

## What the verifier refuses

Every one of these is a **refusal with a non-zero exit**, not a warning. There is deliberately no
`--force`.

| condition | why it is fatal |
| --- | --- |
| manifest missing | nothing to verify |
| **signature missing** | stripping the signature is precisely the attack |
| **unknown signing key** | a bundle signed by a key you were never given is refused *even if the signature is internally valid* — that is what pinning means |
| **signature does not verify** | modified manifest, or signed by a different private key |
| **a listed file is missing** | a partial bundle is not a smaller update; it is an untested state |
| **a file's digest differs** | payload tampering under an intact manifest signature |
| **the payload has a file the manifest does not list** | everything shipped must be named, or the signature covers less than the bundle does |
| **downgrade** | a correctly signed *old* release is still a downgrade, and a downgrade re-opens whatever the newer release closed |
| bundle requires a higher `minInstalledVersion` | skipping a release skips its migrations |
| key id containing anything but `[A-Za-z0-9._-]` | the key id names a file in the keyring; `../../etc/…` must not select one |

All of these were exercised against a real bundle during implementation — build, verify (pass),
then modify a file, delete a file, add an unlisted file, strip the signature, re-sign with an
untrusted key, sign with an untrusted *key id*, and offer a genuinely-signed older version. Every
one refused; the pristine bundle and a same-version re-apply passed.

Reproduce it yourself:

```sh
tar -xzf bundle.tar.gz -C /tmp/x
echo '# tamper' >> /tmp/x/regulait-update-0.2.0/payload/docker-compose.yml
tar -C /tmp/x -czf /tmp/tampered.tar.gz regulait-update-0.2.0
./scripts/verify-update-bundle.sh /tmp/tampered.tar.gz ; echo "exit=$?"
```

**The verifier makes no network call**, by design. There is no revocation endpoint and no timestamp
authority for an air-gapped deployment to reach, so pretending to consult one would be theatre.

---

## Keys, custody and rotation

Read [`infra/release-keys/README.md`](../../infra/release-keys/README.md) — it is the authority and
it is honest about the current state (the shipped key is a **development** key whose private half
was not retained, so it is the *shape* of a release root rather than one).

The short version:

- The **private** key lives on an offline host or HSM controlled by whoever cuts releases. It is
  never in this repository — `.gitignore` refuses `*.pem`/`*.key`, and the bundle builder prunes
  both patterns out of any payload.
- The **public** key ships with every install, in `infra/release-keys/`. That directory is the
  keyring; a bundle names one key id and only that key is tried.
- **Rotation is a delivery problem, not a protocol problem**, and the order matters: ship the new
  public key *in a bundle signed by the old key*, then cut the next release under the new key, then
  remove the old public key *in a bundle signed by the new key*. Collapsing steps is unverifiable
  by construction — the deployment would have to trust the bundle in order to learn the key it
  needs to trust the bundle.
- If a key is lost or compromised outside that sequence there is **no in-band recovery**. The new
  public key must be delivered out of band, by the same route as the original install media. An
  "emergency key update" endpoint would be exactly the hole pinning exists to close.

---

## Applying an update

`scripts/apply-update-bundle.sh` does, in order:

1. **Verify** into a throwaway directory. Nothing from an unverified bundle goes near the install
   directory.
2. **Insist on a backup.** Migrations run on gateway boot and are idempotent, but they are
   **forward-only** — a file-level rollback will not un-migrate the database.
3. **Preserve the previous tree** at `<install-dir>.prev-<old-version>`. Nothing is deleted.
4. **Apply** the verified payload over the install directory. `.env`, `.regulait-version` and every
   Docker volume are untouched — the payload deliberately does not contain them.
5. **`docker load`** the image bundle, if `--image-bundle` was given (the air-gapped path).
6. **Re-run the installer**, which reads the existing `.env`, preserves every secret in it, and
   brings the stack back up.

```sh
# connected
./scripts/apply-update-bundle.sh regulait-update-0.2.0.tar.gz --install-dir /opt/regulait

# air-gapped
./scripts/apply-update-bundle.sh regulait-update-0.2.0.tar.gz --install-dir /opt/regulait \
    --image-bundle /media/usb/regulait-images-0.2.0.tar
```

### Rolling back

```sh
docker compose -p regulait down
rm -rf /opt/regulait && mv /opt/regulait.prev-0.1.0 /opt/regulait
/opt/regulait/scripts/install.sh --dir /opt/regulait --yes
```

**Files only.** If the update ran a migration, restore the dump you took in step 2 as well — see
[BACKUP_RESTORE.md](BACKUP_RESTORE.md). This is also why the verifier refuses downgrades: rolling
back is a deliberate operator-driven restore, not an "update" to an older bundle.

---

## Cutting a release (for whoever maintains RegulAIt)

```sh
./scripts/build-update-bundle.sh \
    --version 0.2.0 \
    --key ~/offline/regulait-release-2026.pem \
    --key-id regulait-release-2026 \
    --min-installed 0.1.0
```

The default payload is the deployment surface — `docker-compose.yml`, `Dockerfile`, the workspace
sources, `infra/caddy`, `infra/scripts`, `infra/release-keys`, `scripts/`, `docs/deployment/` —
with `node_modules`, `dist`, `.git`, `.terraform`, Terraform state and plans, any `*.pem`/`*.key`,
and any `.env` pruned out. Override the set with repeated `--include`.

Then verify it the way a customer will, against the pinned keyring, before it leaves your machine:

```sh
./scripts/verify-update-bundle.sh dist/regulait-update-0.2.0.tar.gz
```

---

## What signing does not prove

- **Not that the release is current.** A correctly signed old bundle is an old bundle; the
  downgrade check is a *separate* control for a reason.
- **Not build provenance.** The signature says who signed the manifest, not that the payload was
  built from a particular commit. There is no SLSA/in-toto attestation here. If a customer requires
  one, that is a further slice.
- **Not that the update is safe for your data.** Take the backup.
