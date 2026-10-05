/**
 * ADR-0173 batch 2c fix round B — the monitoring chart's series palette meets
 * WCAG 1.4.11 (non-text contrast, at least 3:1 against the chart surface) in
 * light and dark, and colour is never the only cue: every series slot has its
 * own dash pattern. Reads the CSS module itself, so a palette edit that
 * drops below 3:1 fails here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { SERIES_DASHES } from "./monitoringModel";

// The test runner turns any CSS import (even `?raw`) into an empty module, so
// the file is read from disk. The SPA's tsconfig carries no Node types, hence
// the untyped dynamic import.
let css = "";
beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(p: URL, enc: "utf8"): string };
  css = fs.readFileSync(new URL("./monitoring.module.css", import.meta.url), "utf8");
});

/** the chart surfaces (`--rg-surface` in theme/tokens.css) */
const LIGHT_SURFACE = "#ffffff";
const DARK_SURFACE = "#111626";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** every `.palette { --mon-sN: #hex; ... }` block, in file order */
function paletteBlocks(): string[][] {
  const blocks = [...css.matchAll(/\.palette\s*\{([^}]*)\}/g)].map((m) =>
    [...m[1]!.matchAll(/--mon-s(\d):\s*(#[0-9a-fA-F]{6})/g)].sort((a, b) => Number(a[1]) - Number(b[1])).map((x) => x[2]!.toLowerCase()),
  );
  return blocks;
}

describe("monitoring series palette", () => {
  it("has a light block and two dark blocks of six slots", () => {
    const blocks = paletteBlocks();
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(b).toHaveLength(6);
  });

  it("every light slot is at least 3:1 on the light chart surface", () => {
    const [light] = paletteBlocks();
    for (const c of light!) expect(contrast(c, LIGHT_SURFACE), c).toBeGreaterThanOrEqual(3);
  });

  it("every dark slot is at least 3:1 on the dark chart surface", () => {
    const [, ...dark] = paletteBlocks();
    for (const block of dark) for (const c of block) expect(contrast(c, DARK_SURFACE), c).toBeGreaterThanOrEqual(3);
  });

  it("each slot has its own dash pattern, so colour is not the only cue", () => {
    expect(SERIES_DASHES).toHaveLength(6);
    expect(new Set(SERIES_DASHES).size).toBe(6);
  });
});
