/** ADR-0256: the community-list parser is linear on hostile record input (M-074). In the serialized timing project. */
import { expect, it } from "vitest";
import { parseCommunityList } from "./mcp-catalogue.js";

it("parses a hostile 400k-character line in linear time", () => {
  const hostile = "- [" + "[".repeat(200_000) + "](" + "(".repeat(200_000);
  const t = performance.now();
  expect(parseCommunityList(hostile).entries).toEqual([]);
  expect(performance.now() - t).toBeLessThan(1000);
});
