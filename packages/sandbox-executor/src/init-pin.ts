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
