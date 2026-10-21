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
export const SANDBOX_INIT_SHA256 = "bbd95cb65c56e3a384373d31133fb41867941aef0d154cd4b3d8f9a8d3defdc3";

export const RUNSC_RELEASES: Readonly<Record<string, string>> = {
  "release-20261012.0":
    "e2616f197143bb00472a835c77f6696ccda441f2af0fbcc2b952617f3ec64e8de877878cf01c68a52b83993be25428ce5bea6024a4154b247583ad1b52fbcd91",
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
  "release-20261012.0": {
    "gvisor-bin/checkpointgofer":
      "b0500b26aa310cfcaebf2c3dd4a01599a169c7b249d11e38e5f0fdd7cee3ff123afc90200c86b89cf820890822fb538c37d83edc38927a92876f542710aab1b1",
    "gvisor-bin/gvisor-sentry-prewarmer":
      "75b760b02d13fa6bfbaac119625f5264c4446d52184fc8d1613806a5f9d0d2303d5b84a73441d0fef1e4e80ba399453768dab4c6d1462ff677db6bda37f82e04",
    "gvisor-bin/gvisor_sentry":
      "d31a001185b1b5a956571364850b342bc74f1f5b877d68d6e60f6d832ab67f8b94c90f0dd78b1e356747f743e600ab6110e68ade398bd6ac8c1a2706606836d0",
    "gvisor-bin/runsc-fd-parking":
      "bdcb8034e31250379e24e40399b62c66be88318d969c462fe065a8a785c83d3a638214685ae04d7ee09f7a66695f6381635f989271ad8f0a23ee6e08040b3454",
    "gvisor-bin/runsc-metric-server":
      "48f61a25a84dff87f4b10a34acdc6cb1ba11a1573538c0ef79890e9d74f06c1308d92f8949b1bd56cb0f8e06e12798b213301fbb143576e2cf9557e15aefd906",
  },
};
