# Isolation I0 spike: third-party artefacts

The spike scripts themselves use only the Python 3.11 standard library, bash and coreutils. No third-party code is
vendored, installed into the repository, or committed. The artefacts below were downloaded into a scratch directory
for the spike, verified, used, and **deleted** before the commit. Only their identities are recorded here.

## gVisor `release-20261005.0` (Apache-2.0)

Source: the official release bucket, `https://storage.googleapis.com/gvisor/releases/release/20261005.0/x86_64/`.
Licence: Apache License 2.0 (the `LICENSE` file at upstream tag `release-20261005.0`, read 2026-10-10; see
`evidence/survey-recheck.md`). `runsc --version` printed `runsc version release-20261005.0`, `spec: 1.2.1`.

| Object | Size (bytes) | sha512 | Verified against |
|---|---|---|---|
| `gvisor.tar.bz2` | 166822039 | `79869ae9a589355a46d46fdac068d9a954e741741ffe77c64e38c56ea955498c1cb04e9bce44e1cce5155333e6b76bee72347c6661bb7c78fd2fe3aad198c8fe` | published `gvisor.tar.bz2.sha512` (`sha512sum -c`: OK), twice |
| `gvisor.tar.zstd` | 129604888 | `27fed731b432d6a39d908956623fd273979fda66b3ccf4b9c12413ea417c516e18a9dc3cced403fb28efe495d64dce4251f51cf8c4d9f4a72f9833bd96b6bb35` | published `gvisor.tar.zstd.sha512` (match); not unpacked (no `zstd` tool here) |

Files inside `gvisor.tar.bz2` (sha512 of each extracted file):

| File | Size (bytes) | sha512 |
|---|---|---|
| `runsc` | 109966750 | `0e0a278f73a3017c45d6fa790ca06a3f62c272c873b504c514efafb3ddacc9ea0f372376128bff8ffe3d766d7cd5f22ceda8bab8075ea10e1064e065d21d8266` |
| `containerd-shim-runsc-v1` | 43626680 | `1a30ac91bef05cd8f00a2516a341ffcbe9a6f8a034792f17bfe1957617dfec3d64d41fa6b84ad7bcd5b13406889a6737e672fdd501be3cb349f788ff8dccf961` |
| `gvisor-bin/gvisor_sentry` | 52149808 | `b09da3479cbfdbd989b448568d1b8305fdf1789ae05cd864f15ac4b3df2d14a9cc83d5ccd62fa0dfad5c54fe7012e249aab123d306146770a1c8b7418932a193` |
| `gvisor-bin/gvisor-sentry-prewarmer` | 1416 | `f0c131766303ca4733a4e42bd171d8ddf42a0a0087564605b3207b0f4c148d9ff355bad25e27d388c7c9cf06265160b3a02047ec195c035d9e8f428d8f608ce6` |
| `gvisor-bin/runsc-fd-parking` | 1320 | `bdcb8034e31250379e24e40399b62c66be88318d969c462fe065a8a785c83d3a638214685ae04d7ee09f7a66695f6381635f989271ad8f0a23ee6e08040b3454` |
| `gvisor-bin/runsc-metric-server` | 53222722 | `2e1494bfdb4aaece286bf687aa2f950884b1b5eea991c0fb9ae30109c759dbe2476398344729a97d1d3f3407b99dff84f64777ca4c2cf768e27c4b023eea6d63` |
| `gvisor-bin/checkpointgofer` | 69128994 | `42240362e2f4f6bf6f418f24d0ccdba5aab5a88a51a99ab4c296a3ee0929321f92c27368b0e6702426d1a8ed58c053ee1d1ad7657e65ec32cdc690d2eca1e18c` |

`fetch-gvisor.sh` pins the tarball's sha512 above and re-verifies it against the published object.

## OpenShell (Apache-2.0), read only, never executed

| Artefact | Identity | Licence |
|---|---|---|
| PyPI `openshell` 0.1.3 wheel `openshell-0.1.3-py3-none-any.whl` (131882 bytes, uploaded 2026-10-09T15:23:07Z) | sha256 `d1eaa6abcd714e2f19d4a8ecbc2079bebeb7b56d81e9f8d3f5a9b5165ed1956c` (matches PyPI's digest); sha512 `b57a9a252df9eddd3a95d01ab82d9e68f607f886329db528072783112fe4fce545a006340415082e0d480910138ed3c957e046ef10722668c0861d8fb1504558` | PyPI `license_expression: Apache-2.0`; wheel `licenses/LICENSE` is the Apache License 2.0 text |
| Upstream source, shallow clone of the default branch | commit `eeba0e7954c0fb4d8e9e2e29d1bfa68e290eb8b3` (2026-10-10T01:12:03Z); newest release tag `v0.1.3` (2026-10-09) | `LICENSE`: Apache License 2.0 |

Both were deleted after reading. Nothing from them is in this folder.
