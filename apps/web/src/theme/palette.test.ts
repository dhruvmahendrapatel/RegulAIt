/**
 * T1: every palette in palettes.css holds the AA floors tokens.css documents, never touches the risk scale, and
 * keeps its system-dark copy identical to its explicit-dark block.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast as ratio } from "../test-utils/contrast";
import { PALETTES } from "./palette";

const css = readFileSync(new URL("./palettes.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.replace(/\s+/g, " ").trim();
  return out;
}

const DARK_SURFACE = "#111626"; // tokens.css dark --rg-surface, unless a palette overrides it
const RISK = /^--rg-(critical|high|medium|low|positive|product)/;

describe.each(PALETTES.filter((p) => p.id !== "aurora"))("palette $id", (p) => {
  const light = block(`:root[data-palette="${p.id}"]`);
  const dark = block(`:root[data-palette="${p.id}"][data-theme="dark"]`);
  const system = block(`:root[data-palette="${p.id}"]:not([data-theme="light"])`);

  it("light: links, primary fills and tinted chips keep AA", () => {
    const link = light["--rg-signal-700"]!;
    expect(ratio(link, "#ffffff")).toBeGreaterThanOrEqual(4.5); // link on a card, white on a primary fill
    expect(ratio(light["--rg-signal-800"]!, "#ffffff")).toBeGreaterThanOrEqual(4.5); // pressed fill
    expect(ratio(link, light["--rg-canvas"]!)).toBeGreaterThanOrEqual(4.5); // the field's worst point
    expect(ratio(link, light["--rg-signal-tint"]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light["--rg-ink-muted"] ?? "#4f5256", light["--rg-canvas"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it("dark: links and the tonal primary keep AA", () => {
    const link = dark["--rg-signal-700"]!;
    expect(ratio(link, dark["--rg-surface"] ?? DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(link, dark["--rg-canvas"]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(link, dark["--rg-signal-tint"]!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(dark["--rg-ink-muted"] ?? "#9a9fa8", dark["--rg-surface"] ?? DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it("system dark matches explicit dark", () => {
    expect(system).toEqual(dark);
  });

  it("never re-colours the risk scale or the product green", () => {
    for (const name of [...Object.keys(light), ...Object.keys(dark)]) expect(name).not.toMatch(RISK);
  });

  it("the picker's swatch accent is the palette's light link colour", () => {
    expect(block(`[data-swatch="${p.id}"]`)["--swatch-accent"]).toBe(light["--rg-signal-700"]);
  });
});

it("no rule anywhere in palettes.css declares a risk or product-green token", () => {
  const declared = [...css.matchAll(/(--rg-[\w-]+)\s*:/g)].map((m) => m[1]!).filter((name) => RISK.test(name));
  expect(declared).toEqual([]);
});
