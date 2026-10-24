import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMISSIBLE, checkLicences, isAllowed } from "./licence-gate-workspace.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const allowFile = JSON.parse(readFileSync(path.join(here, "licence-allow-workspace.json"), "utf8"));
const pkg = (name, v = "1.0.0") => ({ name, versions: [v] });

describe("workspace licence gate (FS-22, ADR-0176 addendum)", () => {
  it("allows the ADR-0176 list and flat AND/OR expressions over it", () => {
    for (const l of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "0BSD", "Unlicense", "MIT AND ISC", "(MIT OR GPL-3.0)"]) {
      expect(isAllowed(l), l).toBe(true);
    }
    for (const l of ["GPL-3.0", "AGPL-3.0", "BUSL-1.1", "SSPL-1.0", "MIT AND GPL-2.0", "BlueOak-1.0.0", "", undefined]) {
      expect(isAllowed(l), String(l)).toBe(false);
    }
  });

  it("admits BlueOak-1.0.0 / Python-2.0 only for a package named in the allow file", () => {
    const allow = [{ subject: "sax", licence: "BlueOak-1.0.0" }];
    expect(checkLicences({ MIT: [pkg("a")], "BlueOak-1.0.0": [pkg("sax")] }, allow).problems).toEqual([]);
    expect(checkLicences({ "BlueOak-1.0.0": [pkg("sax"), pkg("newcomer")] }, allow).problems).toEqual([
      "DENIED newcomer@1.0.0 BlueOak-1.0.0",
    ]);
  });

  it("denies copyleft even when someone lists it in the allow file", () => {
    const res = checkLicences({ "GPL-3.0": [pkg("x")] }, [{ subject: "x", licence: "GPL-3.0" }]);
    expect(res.problems).toContain("DENIED x@1.0.0 GPL-3.0");
    expect(res.problems).toContain("allow file: x names GPL-3.0, which no ADR admits");
  });

  it("fails an allow-file entry that no longer matches, so the file cannot rot", () => {
    const res = checkLicences({ MIT: [pkg("a")] }, [{ subject: "gone", licence: "Python-2.0" }]);
    expect(res.problems).toEqual(["allow file: gone (Python-2.0) is not in the closure; remove it"]);
  });

  it("the committed allow file names only admissible licences, each with a decision and a reason", () => {
    expect(allowFile.length).toBeGreaterThan(0);
    for (const e of allowFile) {
      expect(ADMISSIBLE.has(e.licence), e.subject).toBe(true);
      expect(e.decision).toMatch(/owner 2026-10-24/);
      expect(e.why.length).toBeGreaterThan(10);
    }
  });
});
