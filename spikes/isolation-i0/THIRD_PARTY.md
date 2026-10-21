# Isolation I0 spike: third-party artefacts

The spike scripts themselves use only the Python 3.11 standard library, bash and coreutils. No third-party code is
vendored, installed into the repository, or committed. The artefacts below were downloaded into a scratch directory
for the spike, verified, used, and **deleted** before the commit. Only their identities are recorded here.

## gVisor `release-20261012.0` (Apache-2.0)

Re-pinned 2026-10-20 (ADR-0190 I4, gVisor CI job), replacing `release-20261005.0`, by the I0 process: the tarball
fetched from the official release bucket, checked against the published `.sha512` object, extracted, and every file
hashed. This release contains upstream commit `7be4160a` ("Honor errnoRet in OCI seccomp profiles"); see ADR-0190.

Source: the official release bucket, `https://storage.googleapis.com/gvisor/releases/release/20261012.0/x86_64/`.
Upstream tag `release-20261012.0`: tag object `2fda77caeddf03ab6832b601b061d2969ac9e035`, commit
`60faa657ca99f3398e04c8dbc580a848df20f2f2` (github.com/google/gvisor).
Licence: Apache License 2.0 (the `LICENSE` file at upstream tag `release-20261012.0`, read 2026-10-20; unchanged since
`release-20261005.0`). `runsc --version` printed `runsc version release-20261012.0`, `spec: 1.2.1`.

| Object | Size (bytes) | sha512 | Verified against |
|---|---|---|---|
| `gvisor.tar.bz2` | 100743091 | `9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e` | published `gvisor.tar.bz2.sha512` (`sha512sum -c`: OK) |
| `gvisor.tar.zstd` | 76363853 | `ce2e1aeb853c104e854dea6644333a1dba0fbc9dd1646af97e1d013fdf810da6d4176dd96f2139d7b055e5382117c0d7c4567ebd64ed9bef47fdd15f80fd67ab` | published `gvisor.tar.zstd.sha512` only; not downloaded or unpacked |

Files inside `gvisor.tar.bz2` (sha512 of each extracted file):

| File | Size (bytes) | sha512 |
|---|---|---|
| `runsc` | 56950133 | `e2616f197143bb00472a835c77f6696ccda441f2af0fbcc2b952617f3ec64e8de877878cf01c68a52b83993be25428ce5bea6024a4154b247583ad1b52fbcd91` |
| `containerd-shim-runsc-v1` | 24005168 | `caf00515bb9417d8141ffcbf8189f0c5a933d557020e8334c484db84f9e5ba4153911e7aac83d65c1ffe114b1ea0599f12d3a9a6dfd10fe3655c854bb27966a8` |
| `gvisor-bin/gvisor_sentry` | 52420211 | `d31a001185b1b5a956571364850b342bc74f1f5b877d68d6e60f6d832ab67f8b94c90f0dd78b1e356747f743e600ab6110e68ade398bd6ac8c1a2706606836d0` |
| `gvisor-bin/gvisor-sentry-prewarmer` | 1416 | `75b760b02d13fa6bfbaac119625f5264c4446d52184fc8d1613806a5f9d0d2303d5b84a73441d0fef1e4e80ba399453768dab4c6d1462ff677db6bda37f82e04` |
| `gvisor-bin/runsc-fd-parking` | 1320 | `bdcb8034e31250379e24e40399b62c66be88318d969c462fe065a8a785c83d3a638214685ae04d7ee09f7a66695f6381635f989271ad8f0a23ee6e08040b3454` |
| `gvisor-bin/runsc-metric-server` | 53874786 | `48f61a25a84dff87f4b10a34acdc6cb1ba11a1573538c0ef79890e9d74f06c1308d92f8949b1bd56cb0f8e06e12798b213301fbb143576e2cf9557e15aefd906` |
| `gvisor-bin/checkpointgofer` | 48421319 | `b0500b26aa310cfcaebf2c3dd4a01599a169c7b249d11e38e5f0fdd7cee3ff123afc90200c86b89cf820890822fb538c37d83edc38927a92876f542710aab1b1` |

`fetch-gvisor.sh` pins the tarball's sha512 above and re-verifies it against the published object.

The I0 spike itself ran `release-20261005.0` (tarball sha512 `79869ae9…98c8fe`, `runsc` sha512 `0e0a278f…1d8266`);
that pin is retired. Its evidence under `evidence/` is left as recorded.

## OpenShell (Apache-2.0), read only, never executed

| Artefact | Identity | Licence |
|---|---|---|
| PyPI `openshell` 0.1.3 wheel `openshell-0.1.3-py3-none-any.whl` (131882 bytes, uploaded 2026-10-09T15:23:07Z) | sha256 `d1eaa6abcd714e2f19d4a8ecbc2079bebeb7b56d81e9f8d3f5a9b5165ed1956c` (matches PyPI's digest); sha512 `b57a9a252df9eddd3a95d01ab82d9e68f607f886329db528072783112fe4fce545a006340415082e0d480910138ed3c957e046ef10722668c0861d8fb1504558` | PyPI `license_expression: Apache-2.0`; wheel `licenses/LICENSE` is the Apache License 2.0 text |
| Upstream source, shallow clone of the default branch | commit `eeba0e7954c0fb4d8e9e2e29d1bfa68e290eb8b3` (2026-10-10T01:12:03Z); newest release tag `v0.1.3` (2026-10-09) | `LICENSE`: Apache License 2.0 |

Both were deleted after reading. Nothing from them is in this folder.
