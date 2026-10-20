/**
 * The import example names only the demo's fictional provider, and its host is the one the demo seeder catalogues
 * (DEMO_SHADOW_DISCOVERY.importExample, imported from the shared source so a drift fails here).
 */
import { describe, expect, it } from "vitest";
import { IMPORT_EXAMPLE, IMPORT_EXAMPLE_HOST, IMPORT_EXAMPLE_PROVIDER } from "./shadowAiExample";

/* eslint-disable @typescript-eslint/no-explicit-any */
const sharedDataset = async (): Promise<any> =>
  (await import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/demo-intake/shadow-discovery.ts", import.meta.url).pathname))
    .DEMO_SHADOW_DISCOVERY;

describe("the Shadow AI import example", () => {
  it("its host is a reserved .example name (a fictional provider, never a real vendor)", () => {
    expect(IMPORT_EXAMPLE.rows.map((r) => r.destinationHost)).toEqual([IMPORT_EXAMPLE_HOST]);
    expect(IMPORT_EXAMPLE_HOST.endsWith(".example")).toBe(true);
  });

  it("mirrors the provider and host the demo seeder catalogues", async () => {
    const d = await sharedDataset();
    expect(d.importExample).toEqual({ provider: IMPORT_EXAMPLE_PROVIDER, host: IMPORT_EXAMPLE_HOST });
  });
});
