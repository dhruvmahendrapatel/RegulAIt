/**
 * ADR-0176 — one constant-time compare, and no second copy anywhere.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "./constant-time.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HELPER = "packages/shared/src/constant-time.ts";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.spec\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("constantTimeEqual", () => {
  it("is true exactly for equal inputs", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(constantTimeEqual("s3cret-token", "s3cret-tokeN")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("é", "é")).toBe(false); // bytes, not a normalised form
    expect(constantTimeEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(constantTimeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual("abc", Buffer.from("abc"))).toBe(true);
  });

  it("never throws on a length mismatch (the raw timingSafeEqual does)", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual(Buffer.alloc(16), Buffer.alloc(32))).toBe(false);
  });
});

describe("there is ONE constant-time compare in the repository", () => {
  it("no source file outside the shared helper calls timingSafeEqual or defines its own safeEqual", () => {
    const roots = ["apps", "packages"].map((r) => path.join(REPO, r));
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const rel = path.relative(REPO, file).split(path.sep).join("/");
        if (rel === HELPER) continue;
        const text = readFileSync(file, "utf8");
        if (/\btimingSafeEqual\b/.test(text) || /function\s+(?:safeEqual|constantTimeEqual)\s*\(/.test(text)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
