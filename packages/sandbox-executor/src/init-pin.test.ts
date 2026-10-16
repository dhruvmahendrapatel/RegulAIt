/**
 * The runsc pins (`init-pin.ts`) are the I0 spike's recorded identities, file for file: `runsc` and every
 * `gvisor-bin/` sidecar of each pinned release appear in `spikes/isolation-i0/THIRD_PARTY.md` with the same sha512.
 * A pin that drifts from the verified record fails here, before the gVisor CI job installs anything against it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNSC_RELEASE_SIDECARS, RUNSC_RELEASES } from "./init-pin.js";

const record = readFileSync(fileURLToPath(new URL("../../../spikes/isolation-i0/THIRD_PARTY.md", import.meta.url)), "utf8");
/** the sha512 the I0 record gives a file of the release tarball (`| \`<file>\` | <size> | \`<sha512>\` |`) */
function recorded(file: string): string | null {
  const row = record.split("\n").find((l) => l.startsWith(`| \`${file}\` |`));
  const m = row ? /\| `([0-9a-f]{128})` \|\s*$/.exec(row) : null;
  return m ? m[1]! : null;
}

describe("the runsc release pins", () => {
  it("every pinned release pins its gvisor-bin/ sidecars, and nothing else is pinned for an unknown release", () => {
    expect(Object.keys(RUNSC_RELEASE_SIDECARS).sort()).toEqual(Object.keys(RUNSC_RELEASES).sort());
    for (const sidecars of Object.values(RUNSC_RELEASE_SIDECARS)) {
      expect(Object.keys(sidecars).length).toBeGreaterThan(0);
      for (const [file, sum] of Object.entries(sidecars)) {
        expect(file).toMatch(/^gvisor-bin\/[A-Za-z0-9_.-]+$/);
        expect(sum).toMatch(/^[0-9a-f]{128}$/);
      }
    }
  });

  it("runsc and each sidecar of release-20261005.0 match the I0 spike's verified record", () => {
    expect(recorded("runsc")).toBe(RUNSC_RELEASES["release-20261005.0"]);
    const sidecars = RUNSC_RELEASE_SIDECARS["release-20261005.0"]!;
    for (const [file, sum] of Object.entries(sidecars)) expect(recorded(file), file).toBe(sum);
    // the record lists exactly these sidecars (no gvisor-bin/ file in the release is left unpinned)
    const listed = record.split("\n").flatMap((l) => /^\| `(gvisor-bin\/[^`]+)` \|/.exec(l)?.[1] ?? []);
    expect(listed.sort()).toEqual(Object.keys(sidecars).sort());
  });
});
