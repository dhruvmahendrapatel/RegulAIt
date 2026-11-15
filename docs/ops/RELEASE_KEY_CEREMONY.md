# Release-key ceremony runbook (ADR-0324)

This is the runbook for creating RegulAIt's real release-signing keys, signing each release, and handling a
lost or stolen key. It is written for the owner, not for an engineer. Every command is given in full, and
every step says why it exists. The tools are `scripts/release-ceremony.sh` (makes and uses the keys) and
`scripts/verify-release.sh` (what customers and CI run to check a release). Both need only bash, tar and
openssl, and neither one connects to the network.

**Status:** this runbook is prepared, and the owner runs the real ceremony later (PENDING S3). Until then
`infra/release-keys/` holds only the ADR-0041 development key. Its private half was never kept, so
nothing can be released, and that is the intended state.

---

## Part 0 — The idea in plain language

A customer installing RegulAIt has to answer one question: did this file really come from RegulAIt,
unchanged? A digital signature answers it. We hold a secret **private key** that makes signatures, and
customers hold the matching **public key**, which can only check them.

The danger is the private key. In October 2026 the LiteLLM project's release pipeline was taken over.
Version 1.107.0 shipped malware that stole credentials, and the malware was **properly signed by LiteLLM's
own pipeline**, because the pipeline held the signing key. The signature was genuine and the software was
malicious. (Source: LiteLLM's incident posts, summarised in `internal/product/MARKET_ANALYSIS_2026-11.md`.)

So this design follows three rules:

1. **The build machine never holds a signing key.** GitHub Actions builds an *unsigned* candidate. A person
   checks it and signs it on a separate machine that is not connected to the internet.
2. **Two kinds of key.**
   - **Root keys** are like a board of directors. They are kept offline in separate places and used only at
     a ceremony, perhaps once a year. They never sign a release. They sign a short document, the
     **keyring statement**, which says which release key is allowed to sign, until when, and which keys are
     revoked.
   - The **release signing key** is like the spokesperson the board appoints. It signs each release. If
     it is stolen, the board (any two root keys) revokes it and appoints a new one, and every customer
     who installs the next release stops trusting the stolen key.
3. **Any two of three.** There are three root keys and any two can act. One lost root key loses nothing,
   and one stolen root key cannot do anything alone.

Customers' installations pin the root keys. Every release carries the keyring statement it was signed
under, and a deployment accepts a new statement only if two of the roots *it already trusts* signed it.
Statements are numbered (serial 1, 2, 3, ...), so an old statement can never be replayed to un-revoke a
stolen key.

Each release also carries:
- an **SBOM** (a list of every component inside it, in CycloneDX format), so customers can check it
  against security advisories, and
- **provenance** (SLSA v1), a statement of which workflow built it, from which git tag and commit. The
  person signing checks the provenance before signing, and customers check it afterwards.

---

## Part 1 — Decide the shape (defaults)

| Decision | Default | Why |
|---|---|---|
| Number of root keys | **3** (`root-a`, `root-b`, `root-c`) | One can be lost without losing control. |
| Root keys needed to act | **2 of 3** | One stolen root cannot act alone. The tool refuses a threshold of 1 unless you pass `--allow-single-root`, and the witness log records that you did. |
| Release signing keys | **1**, valid for **13 months** | You replace it once a year, with a month of overlap. |
| Key type | Ed25519 | The algorithm every RegulAIt verifier already uses (ADR-0041). It leaves no options to get wrong. |
| Root key storage | An encrypted file on **two USB sticks per root** (a main copy and a backup), each root in a different place | See part 8. |
| Release key storage | An encrypted file on a USB stick kept with the signing laptop, **or** a hardware token | See part 9. |
| Builder (the only workflow allowed to build releases) | `https://github.com/<owner>/<repo>/.github/workflows/release.yml` | Written into the keyring statement, so it is root-signed. |

**Custodians.** Write down roles, not names, in anything that goes into the repository, because the
repository is public. For example: custodian A is the owner (home safe), custodian B is the owner (a bank
deposit box), custodian C is a trusted third party (escrow). The witness sheet that stays offline may hold
names.

---

## Part 2 — Prepare (a day before)

**Shopping list:** a laptop that can be wiped (an old one is fine); 8 new USB sticks; tamper-evident
envelopes; a printed witness sheet (part 11); a pen; a witness, meaning a second person, or a phone set up
to record the screen and your hands.

1. **On your normal, connected computer**, download a Debian "live" image (it runs from a USB stick and
   installs nothing) and check its SHA-256 against debian.org's signed checksum file. Write it to one USB
   stick, labelled **BOOT**.
   *Why:* a fresh, verified operating system means no leftover malware can watch the keys being made.
2. **Still connected**, fetch the RegulAIt repository at a release tag you have reviewed, and copy the
   `scripts/` and `infra/release-keys/` directories to a USB stick labelled **TOOLS** (into `scripts/` and
   `infra/release-keys/`). Write down the commit SHA and the output of
   `sha256sum scripts/release-ceremony.sh scripts/verify-release.sh scripts/lib/release-trust.sh`.
   *Why:* on the day, the witness checks that the tools are the ones you reviewed.
3. Label the other sticks: **ROOT-A**, **ROOT-A-BACKUP**, **ROOT-B**, **ROOT-B-BACKUP**, **ROOT-C**,
   **ROOT-C-BACKUP**, **SIGNING**, and **PUBLIC** (the last one carries only public files out of the room).
   Use extra sticks if you need them.

---

## Part 3 — Rehearse on the air-gapped machine

1. Unplug the network cable and switch off Wi-Fi and Bluetooth. Boot the laptop from **BOOT**.
2. Plug in **TOOLS** and copy it to the laptop's memory (for example `cp -r /media/*/TOOLS ~/tools`).
   The witness re-runs the `sha256sum` line from part 2 and compares it with what was written down.
3. Run the full dry run:

   ```sh
   bash ~/tools/scripts/release-ceremony.sh dry-run
   ```

   It performs the whole ceremony with **throwaway keys** in a temporary folder: three roots, a signing key,
   a signed release, then 28 checks. Each attack must be refused for the right reason: a changed file, a
   changed manifest, an attacker's own keys, a stolen key after revocation, an old keyring replayed, a
   missing SBOM, provenance from another build, an expired key, and an edited witness log. Then it deletes
   the throwaway keys. **Continue only if it ends with `DRY RUN PASSED`.**

---

## Part 4 — The ceremony (root keys and the first release key)

Read each fingerprint aloud. The witness writes it on the sheet. Every command appends to the witness log
`~/ceremony/witness.log`. Each log line includes a hash of the line before it, so a changed or deleted line
is detected later (`log-verify`). The log holds only public facts: key ids, fingerprints and digests.

```sh
T=~/tools/scripts/release-ceremony.sh
V=~/tools/scripts/verify-release.sh
LOG=~/ceremony/witness.log; mkdir -p ~/ceremony
```

**4.1 Make the three root keys**, one stick at a time. Plug in **ROOT-A**, then run:

```sh
bash $T keygen --role root --id regulait-root-a-2026 --out /media/$USER/ROOT-A --log $LOG
```

You choose a passphrase (asked twice). The key file is encrypted with it. Write the passphrase on custody
card A and keep the card **separately** from the stick. Copy the two files to **ROOT-A-BACKUP**:

```sh
cp /media/$USER/ROOT-A/regulait-root-a-2026.* /media/$USER/ROOT-A-BACKUP/
cp /media/$USER/ROOT-A/regulait-root-a-2026.pub ~/ceremony/
```

Unmount both sticks, seal each in its own envelope, and write the envelope number on the sheet. Repeat for
`regulait-root-b-2026` and `regulait-root-c-2026`.
*Why:* each root lives on its own stick with its own passphrase and backup, so losing one stick, one
card or one place costs nothing.

The tool **refuses** to run while any network interface is up, and refuses to write a key inside a git
checkout. If it stops for either reason, fix the cause; do not work around it.

**4.2 Make the release signing key.** Plug in **SIGNING**, then run:

```sh
bash $T keygen --role signing --id regulait-release-2026-12 --out /media/$USER/SIGNING --log $LOG
cp /media/$USER/SIGNING/regulait-release-2026-12.pub ~/ceremony/
```

(If you use a hardware token for it, see part 9 instead.)

**4.2b Make the licence signing key** (ADR-0052 signs customer licences with its own key, pinned in
`infra/license-keys/`). Use the same command with `--id regulait-license-2026-12` on the **SIGNING** stick, and
copy its `.pub` to **PUBLIC** for `infra/license-keys/`. It is recorded in the witness log. It is not yet
listed in the root-signed statement, because the licence verifier still pins it directly (ADR-0324 follow-up).

**4.3 Write the keyring statement (serial 1).**

```sh
bash $T keyring --out-dir ~/ceremony/keyring --serial 1 --threshold 2 \
  --builder https://github.com/<owner>/<repo>/.github/workflows/release.yml \
  --root regulait-root-a-2026=$HOME/ceremony/regulait-root-a-2026.pub \
  --root regulait-root-b-2026=$HOME/ceremony/regulait-root-b-2026.pub \
  --root regulait-root-c-2026=$HOME/ceremony/regulait-root-c-2026.pub \
  --key  regulait-release-2026-12=$HOME/ceremony/regulait-release-2026-12.pub:update-bundle,provenance:2027-12-31 \
  --revoke regulait-release-dev-2026-08 \
  --log $LOG
```

Read out the statement's sha256. *Why revoke the dev key?* Its private half is gone, but listing it as
revoked means no later statement can ever authorise it again by mistake.

**4.4 All three roots sign it**, one at a time. Plug in **ROOT-A**, run the command below, then unplug it
and repeat for B and C:

```sh
bash $T sign-keyring --dir ~/ceremony/keyring --root-id regulait-root-a-2026 \
  --root-key /media/$USER/ROOT-A/regulait-root-a-2026.pem --log $LOG
```

Two signatures are enough for the keyring to verify. All three sign at the first ceremony so you prove that
each root key and its passphrase work. The tool checks that the private key matches the root it claims to
be before it signs.

**4.5 Check it, and check the log.**

```sh
bash $V --keyring-only ~/ceremony/keyring
bash $T log-verify $LOG
```

The first command lists each root's fingerprint. The witness compares them with the sheet.

**4.6 Take out only public files.** Copy `~/ceremony/keyring/` and `~/ceremony/witness.log` to **PUBLIC**.
Check with `grep -rl "PRIVATE KEY" /media/$USER/PUBLIC`, which must print nothing. Shut the laptop down;
the live system forgets everything. Seal the remaining envelopes. You and the witness sign the sheet.

---

## Part 5 — Publish the keyring (connected computer)

1. On a branch, copy from **PUBLIC** into the repository:
   - `keyring/keyring.json`, `keyring/keyring.json.sig.*` and `keyring/regulait-release-2026-12.pub`
     go to `infra/release-keys/`;
   - `keyring/root/*.pub` goes to `infra/release-keys/root/`;
   - `witness.log` goes to `infra/release-keys/ceremonies/<date>.log`.
2. **In the same change**, delete `infra/release-keys/regulait-release-dev-2026-08.pub` and update the
   "Current keyring" table in `infra/release-keys/README.md`. CI's keyring check
   (`scripts/release-ceremony.test.mjs`) becomes strict as soon as `keyring.json` exists. It fails if any
   `.pub` file in the directory is not authorised by the statement.
3. Publish the **root fingerprints** somewhere other than the repository, for example in the release
   notes, on a website page you control and on the install media. *Why:* a customer installing for the first
   time compares the fingerprints `verify-release.sh` prints with the published ones. That first comparison
   is the only trust that is not inherited.
4. Put the licence key's `.pub` in `infra/license-keys/` and delete `regulait-license-dev-2026-08.pub` there
   in the same change. Open the PR. The operator compiles `infra/release-keys/` in (ADR-0304), so rebuild the
   operator from this commit.

---

## Part 6 — Every release

1. **Tag.** Push a tag `vX.Y.Z` on the commit you reviewed. The **Release** workflow builds
   `regulait-update-X.Y.Z.unsigned.tar.gz` with a CycloneDX SBOM inside and `provenance.intoto.json`
   beside the manifest. It checks that the candidate passes the pre-sign check **and** that it is refused as
   a release, because it is unsigned. If the owner has set the repository variable
   `RELEASE_PROVENANCE_PUBLISH_APPROVED=true`, a second job also attests the provenance keylessly with
   Sigstore. That writes to Sigstore's public Rekor log, which is why it is off until you approve it.
2. **Check, connected.** Download the `release-candidate` artifact (or `release-candidate-attested`). Then
   run:

   ```sh
   scripts/verify-release.sh --candidate regulait-update-X.Y.Z.unsigned.tar.gz          # add --online if attested
   ```

   Read the `provenance:` line. The commit it shows must be the commit you tagged
   (`git rev-parse vX.Y.Z`). *Why:* this is the step LiteLLM did not have. A person confirms that CI built
   what was reviewed before anything is signed.
3. **Sign, offline.** Copy the candidate to a stick. Boot the signing laptop from **BOOT** with the network
   off, and plug in **SIGNING** and the stick. Then run:

   ```sh
   bash $T sign-release --candidate regulait-update-X.Y.Z.unsigned.tar.gz \
     --key /media/$USER/SIGNING/regulait-release-2026-12.pem \
     --trust ~/tools/infra/release-keys --out regulait-update-X.Y.Z.tar.gz --log $LOG
   ```

   The tool repeats the pre-sign check and refuses to sign a candidate that fails it. It checks that the
   key is the one the candidate names, signs the manifest and the provenance, and verifies the result.
4. **Publish.** Attach `regulait-update-X.Y.Z.tar.gz` (never the `.unsigned` one) to the GitHub release and
   publish it. The Release workflow's **verify** job downloads it and verifies it against the keyring on
   the default branch. It fails if an asset is unsigned or does not verify.
5. **Customers** run `scripts/verify-release.sh regulait-update-X.Y.Z.tar.gz`. The operator and
   `apply-update-bundle.sh` keep running the ADR-0041 checks.

---

## Part 7 — Rotation, revocation and the compromise drill

**Yearly signing-key rotation** (before `notAfter`). Hold a short ceremony with two roots. Make a new
signing key (`keygen --role signing`), then write a statement with the next serial that lists the new key
and leaves out, or revokes, the old one:

```sh
bash $T keyring --out-dir ~/ceremony/keyring-2 --previous ~/tools/infra/release-keys --serial 2 --threshold 2 \
  --builder https://github.com/<owner>/<repo>/.github/workflows/release.yml \
  --root ...same three... --key regulait-release-2027-12=...:update-bundle,provenance:2028-12-31 \
  --revoke regulait-release-2026-12 --log $LOG
```

`--previous` carries every earlier revocation forward and refuses a serial that does not go up. Two roots
sign it, it is published as in part 5, and the next release can already be signed by the new key. Because
the roots endorse the change, the four-step, two-release dance of ADR-0041 is no longer needed.

**If the release signing key is lost or stolen:**
1. Stop releasing. Do not sign anything with the suspect key.
2. Hold an emergency ceremony with any two roots. Make a new signing key, and write the next serial with
   `--revoke <the stolen key id>`.
3. Ship the next release signed by the new key. Every deployment that installs it refuses the stolen key
   from then on, whatever date a forged bundle claims, and refuses any bundle that carries the older
   keyring.
4. Tell customers through a channel other than the update channel (support notice, email, release notes).
   Give the revoked key id, the last good release, and "install release X before any other".

   **Be honest about the limit:** a deployment that has not yet installed the new keyring still trusts the
   stolen key. An air-gapped install has no way to receive a revocation except a bundle. That is why the
   notice matters.

**If one root key is lost or stolen:** nothing can be done with it alone. At the next ceremony, two other
roots sign a statement that replaces it (a new `--root`, the old one left out). The dry run's "root-c is
lost; replace it with root-d" step shows exactly this.

**If two root keys are stolen:** in-band recovery is impossible by design. Customers must receive a new
root set the way they received the first one, on new install media, with fingerprints published out of
band. Do not invent an "emergency key update" feature; it would be the very hole the pinning closes.

**The drill (once a year, and after any change to the tools):** run part 3's dry run on the air-gapped
machine. It rehearses a stolen-key revocation, a replay attempt, a root replacement and an expired key.
Then open each root backup with `openssl pkey -in <file>.pem -noout` and confirm the passphrase still works.
Record the date and result on a new witness sheet.

---

## Part 8 — Backup and escrow

- **Two copies of every root key** (main and backup sticks), in **different places**. The passphrase card
  is stored apart from both. One root per place: A at home, B in a bank box, C with a trusted third party.
- **Paper copy (optional):** the encrypted key file is short text. `cat regulait-root-a-2026.pem` can be
  printed and kept with the backup. It is useless without the passphrase.
- USB sticks fail over time. Check the backups at the yearly drill, and copy them to new sticks every few
  years.
- This is "M-of-N by independent keys" rather than splitting one key into shares (Shamir). Each root is a
  normal key that can be checked on its own, and nothing extra is needed to use one.

---

## Part 9 — Hardware token option

A hardware token (for example a YubiKey 5 with firmware 5.7 or later, which can hold Ed25519 keys in its
PIV application) keeps the private key **inside the device**. It signs when asked, and the key cannot be
copied off it.

- It suits the **release signing key** best: it is used often, and a token cannot be copied by malware.
  For root keys, a token has a drawback: no backup is possible, so you would need one token per root plus
  a spare. Encrypted files on sticks are simpler.
- Generate the key on the token (for example `ykman piv keys generate --algorithm ED25519 9c pub.pem`,
  then make it a certificate as the vendor documents). Give the tools a PKCS#11 URI instead of a file:
  `--key 'pkcs11:token=...;object=...'`. This needs `pkcs11-provider` (Apache-2.0) for openssl 3 on the
  signing laptop.
- **Not yet proven:** the token path follows openssl's documented provider interface, but it has not been
  run against a real token in this repository. Run the dry run's steps with the token once before relying
  on it.

---

## Part 10 — What each check protects against

| Check (in `verify-release.sh`) | Stops |
|---|---|
| The installed keyring verifies, signed by 2 of its own roots | A planted or hand-edited keyring |
| The bundle's keyring is signed by 2 of the **already-trusted** roots | An attacker shipping their own root or key, including from a stolen signing key |
| The keyring serial never goes down | Replaying an old statement to un-revoke a key |
| The signing key is listed, has the right purpose, is not revoked and has not expired | A stolen, retired or out-of-scope key |
| Manifest signature and every file digest (verify-update-bundle.sh) | A changed, missing or added file, and a downgrade |
| Nothing unexpected at the bundle root | A smuggled script beside the manifest |
| A CycloneDX SBOM is present and covered by the manifest | A release nobody can check against advisories |
| Provenance subject = this manifest; builder = the root-named workflow; ref = the tag; signed by the release key | A build from another workflow, branch or commit, and provenance copied from another build |
| `--online`: the CI's Sigstore attestation for that workflow and tag | A candidate that did not come from the GitHub workflow at all |

---

## Part 11 — Witness sheet (print, fill in by hand, keep offline)

```
RegulAIt release-key ceremony                       Date: ____________  Start time (UTC): ______
Tools commit: ____________________________  sha256 release-ceremony.sh: __________________
Dry run result (part 3): PASSED / FAILED     checks: ____ / ____

Key id                          Role      Fingerprint (sha256, first 16 + last 8)   Envelope no.
regulait-root-a-2026            root      ________________ ... ________             ______
regulait-root-b-2026            root      ________________ ... ________             ______
regulait-root-c-2026            root      ________________ ... ________             ______
regulait-release-____-__        signing   ________________ ... ________             ______

Keyring statement serial ___   sha256: ________________ ... ________
Signed by roots: A [ ]  B [ ]  C [ ]        keyring-only check: VERIFIED [ ]
Witness log last hash: ________________ ... ________     log-verify: intact [ ]
PUBLIC stick checked for private keys (grep printed nothing) [ ]

Custodian A ______________   Custodian B ______________   Custodian C ______________
Witness ____________________   End time (UTC): ______
```
