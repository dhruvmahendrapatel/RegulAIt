/**
 * PR #181 review (P2): PUT /v1/org/settings is a partial update. The retention
 * form sends only the fields this admin edited, so it cannot revert another
 * admin's concurrent change to the field it left alone.
 */
import { describe, expect, it } from "vitest";
import { retentionChanges } from "./RetentionPage";

const loaded = { semanticCacheTtlSeconds: 3600, conversationRetentionDays: 30 };

describe("retentionChanges", () => {
  it("sends only the edited field", () => {
    expect(retentionChanges(loaded, "3600", "31")).toEqual({ body: { conversationRetentionDays: 31 }, extends: true });
    expect(retentionChanges(loaded, "1800", "30")).toEqual({ body: { semanticCacheTtlSeconds: 1800 }, extends: false });
  });

  it("sends both when both were edited and nothing when nothing was", () => {
    expect(retentionChanges(loaded, "7200", "7")).toEqual({ body: { semanticCacheTtlSeconds: 7200, conversationRetentionDays: 7 }, extends: true });
    expect(retentionChanges(loaded, "3600", "30")).toEqual({ body: {}, extends: false });
  });

  it("still refuses an invalid value", () => {
    expect(retentionChanges(loaded, "3600", "0")).toHaveProperty("error");
    expect(retentionChanges(loaded, "1.5", "30")).toHaveProperty("error");
  });
});
