/**
 * ADR-0187 B5-M — the committed settings file IS `MODELSCAN_SETTINGS` (parsed and compared), it loads
 * no code from outside modelscan, writes JSON, and carries the deny-list additions G19 measured.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { MODELSCAN_DENYLIST_ADDITIONS, MODELSCAN_SETTINGS } from "./settings.js";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/modelscan/modelscan-settings.toml");
const parsed = parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("B5-M modelscan settings", () => {
  it("the TOML file and MODELSCAN_SETTINGS are the same settings", () => {
    expect(parsed).toEqual(JSON.parse(JSON.stringify(MODELSCAN_SETTINGS)));
  });

  it("imports only modelscan's own classes and reports JSON", () => {
    const s = parsed as { scanners: Record<string, unknown>; middlewares: Record<string, unknown>; reporting: { module: string } };
    for (const k of [...Object.keys(s.scanners), ...Object.keys(s.middlewares), s.reporting.module]) expect(k).toMatch(/^modelscan\.(scanners|middlewares|reports)\.[A-Za-z0-9]+$/);
    expect(s.reporting.module).toBe("modelscan.reports.JSONReport");
  });

  it("carries the deny-list additions G19 measured slipping through", () => {
    const g = MODELSCAN_SETTINGS.unsafe_globals as unknown as Record<string, Record<string, string | readonly string[]>>;
    const listed = (mod: string, name?: string) =>
      Object.values(g).some((sev) => {
        const v = sev[mod];
        return v === "*" || (name !== undefined && Array.isArray(v) && v.includes(name));
      });
    for (const a of MODELSCAN_DENYLIST_ADDITIONS) {
      const [mod, name] = a === "operator.methodcaller" ? ["operator", "methodcaller"] : [a, undefined];
      expect(listed(mod!, name), a).toBe(true);
    }
    // modelscan's own defaults are kept
    expect(listed("os")).toBe(true);
    expect(listed("builtins", "eval")).toBe(true);
  });
});
