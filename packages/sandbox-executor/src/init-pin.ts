/**
 * ADR-0190 slice I4 (review H2) — THE PINS the runsc backend checks before any sandbox:
 *
 *  - `SANDBOX_INIT_SHA256`: the sandbox init this executor ships (`sandbox-init/sandbox-init.mjs`). The executor
 *    hashes the file it is about to mount; any other bytes refuse to start a sandbox. `runsc-backend.test.ts` keeps this
 *    constant equal to the file in the repository, so a change to the init is a change to the pin, reviewed.
 *  - `RUNSC_RELEASES`: the gVisor release the executor accepts as `runsc`, by the sha512 of its `runsc` binary as the
 *    I0 spike verified it from the official release tarball (`spikes/isolation-i0/THIRD_PARTY.md`). The executor
 *    hashes the binary the daemon's `runsc` runtime actually points at; a binary that is not a pinned release is not
 *    gVisor as far as this executor is concerned (its sandboxes are reported as `runc`, and the gateway refuses
 *    them). A new gVisor release is added here, from its verified tarball, in a reviewed change.
 */
export const SANDBOX_INIT_SHA256 = "024f68ccc42e6d5f76685e79978a2253878268b2d1046e8c5c20d6fed7b39f7f";

export const RUNSC_RELEASES: Readonly<Record<string, string>> = {
  "release-20261005.0":
    "0e0a278f73a3017c45d6fa790ca06a3f62c272c873b504c514efafb3ddacc9ea0f372376128bff8ffe3d766d7cd5f22ceda8bab8075ea10e1064e065d21d8266",
};

/**
 * The `gvisor-bin/` sidecars that ship beside `runsc` in each pinned release, by the sha512 of each file as the I0
 * spike recorded it from the verified tarball (`spikes/isolation-i0/THIRD_PARTY.md`). `runsc` loads them from the
 * `gvisor-bin/` directory next to its own binary, so a release is installed as `runsc` plus exactly these files
 * (INSTALL.md, amendment E). The gVisor CI job (`.github/workflows/gvisor.yml`) installs a release only when the
 * extracted `runsc` matches `RUNSC_RELEASES` and the extracted `gvisor-bin/` holds exactly these files with these
 * hashes. The executor itself does not yet hash the sidecars at placement time (it hashes `runsc` only).
 */
export const RUNSC_RELEASE_SIDECARS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "release-20261005.0": {
    "gvisor-bin/checkpointgofer":
      "42240362e2f4f6bf6f418f24d0ccdba5aab5a88a51a99ab4c296a3ee0929321f92c27368b0e6702426d1a8ed58c053ee1d1ad7657e65ec32cdc690d2eca1e18c",
    "gvisor-bin/gvisor-sentry-prewarmer":
      "f0c131766303ca4733a4e42bd171d8ddf42a0a0087564605b3207b0f4c148d9ff355bad25e27d388c7c9cf06265160b3a02047ec195c035d9e8f428d8f608ce6",
    "gvisor-bin/gvisor_sentry":
      "b09da3479cbfdbd989b448568d1b8305fdf1789ae05cd864f15ac4b3df2d14a9cc83d5ccd62fa0dfad5c54fe7012e249aab123d306146770a1c8b7418932a193",
    "gvisor-bin/runsc-fd-parking":
      "bdcb8034e31250379e24e40399b62c66be88318d969c462fe065a8a785c83d3a638214685ae04d7ee09f7a66695f6381635f989271ad8f0a23ee6e08040b3454",
    "gvisor-bin/runsc-metric-server":
      "2e1494bfdb4aaece286bf687aa2f950884b1b5eea991c0fb9ae30109c759dbe2476398344729a97d1d3f3407b99dff84f64777ca4c2cf768e27c4b023eea6d63",
  },
};
