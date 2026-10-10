/**
 * ADR-0189 slice B7: the R17 switch has ONE definition. The gateway's snapshot
 * routes and triggers and B7's release-time AI BOM step read the same binding
 * (`packages/shared/src/bom/release-switch.ts`); the gateway re-exports it and
 * never declares its own. Independent of every other test file (no database).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "@regulait/shared";
import * as gatewayAiBom from "./ai-bom.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("ADR-0189 B7: one R17 switch", () => {
  it("the gateway's AI_BOM_SNAPSHOTS_RELEASED is the shared binding, and it is off", () => {
    expect(gatewayAiBom.AI_BOM_SNAPSHOTS_RELEASED).toBe(shared.AI_BOM_SNAPSHOTS_RELEASED);
    expect(shared.AI_BOM_SNAPSHOTS_RELEASED).toBe(false);
  });
  it("the gateway re-exports the shared constant and declares no switch of its own", () => {
    const src = readFileSync(path.join(here, "ai-bom.ts"), "utf8");
    expect(src).toContain('import { AI_BOM_SNAPSHOTS_RELEASED } from "@regulait/shared";');
    expect(src).toContain("export { AI_BOM_SNAPSHOTS_RELEASED };");
    expect(src).not.toMatch(/const AI_BOM_SNAPSHOTS_RELEASED\b/);
    const sharedSrc = readFileSync(path.join(here, "../../../packages/shared/src/bom/release-switch.ts"), "utf8");
    expect(sharedSrc).toContain("export const AI_BOM_SNAPSHOTS_RELEASED = false as boolean;");
  });
});
