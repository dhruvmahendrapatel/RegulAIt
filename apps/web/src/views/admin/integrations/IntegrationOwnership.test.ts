/**
 * PR #181 review (P2): GET /v1/users returns a bounded page (`limit` only, no
 * cursor or search). The owner pickers must say "not loaded" for a person
 * missing from a truncated page, never infer that the person is inactive.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AdminUser } from "../../../api/adminTypes";
import { USERS_LIST_MAX, userPickerPage } from "../adminKit";
import { canSaveOwner, ownerStatus } from "./IntegrationOwnership";

const person = (id: string, disabledAt: string | null = null): AdminUser => ({
  id, email: `${id}@example.test`, displayName: id, isAdmin: false, disabledAt,
  createdAt: "2026-10-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false,
});

describe("userPickerPage", () => {
  it("marks a page that reached the requested maximum as incomplete", () => {
    expect(userPickerPage([person("a"), person("b")], 2).complete).toBe(false);
    expect(userPickerPage([person("a")], 2).complete).toBe(true);
    const gateway = readFileSync(new URL("../../../../../gateway/src/list-limit.ts", import.meta.url), "utf8");
    expect(gateway.match(/export const LIST_MAX_LIMIT = ([\d_]+);/)?.[1]?.replace(/_/g, ""), "the gateway's /v1/users maximum").toBe(String(USERS_LIST_MAX));
  });
});

describe("ownerStatus", () => {
  it("never calls an owner inactive only because a truncated page omitted them", () => {
    const truncated = userPickerPage([person("a"), person("b")], 2);
    expect(ownerStatus("beyond-the-page", truncated)).toBe("not_loaded");
    expect(ownerStatus("beyond-the-page", truncated, { ownerUserId: "beyond-the-page", ownership: "owned" })).toBe("not_loaded");
  });

  it("uses the server's orphaned verdict for the saved owner even when not loaded", () => {
    const truncated = userPickerPage([person("a"), person("b")], 2);
    expect(ownerStatus("gone", truncated, { ownerUserId: "gone", ownership: "orphaned" })).toBe("inactive");
  });

  it("reports listed people from their own record and absence from a complete list as not found", () => {
    const complete = userPickerPage([person("a"), person("off", "2026-10-02T00:00:00Z")], 5);
    expect(ownerStatus("", complete)).toBe("none");
    expect(ownerStatus("a", complete)).toBe("active");
    expect(ownerStatus("off", complete)).toBe("inactive");
    expect(ownerStatus("missing", complete)).toBe("not_found");
  });
});

describe("canSaveOwner (PR #181 review)", () => {
  it("refuses a save that would only restate the loaded owner", () => {
    expect(canSaveOwner("a", { ownerUserId: "a" }, "active")).toBe(false);
    expect(canSaveOwner("", { ownerUserId: null }, "none")).toBe(false);
    expect(canSaveOwner("", {}, "none")).toBe(false);
  });

  it("allows a real change to an assignable owner or to unassigned", () => {
    expect(canSaveOwner("b", { ownerUserId: "a" }, "active")).toBe(true);
    expect(canSaveOwner("", { ownerUserId: "a" }, "none")).toBe(true);
    expect(canSaveOwner("b", { ownerUserId: null }, "not_loaded")).toBe(true);
    expect(canSaveOwner("gone", { ownerUserId: null }, "inactive")).toBe(false);
  });
});
