import { describe, expect, it } from "vitest";
import { sortSessions } from "./AccountPage";
import { sortPasskeys, type OwnPasskey } from "./PasskeysCard";
import type { OwnSession } from "../../api/adminTypes";

const session = (id: string, current: boolean, lastSeenAt: string | null, createdAt = "2026-11-01T00:00:00Z"): OwnSession => ({
  id,
  current,
  lastSeenAt,
  createdAt,
  expiresAt: "2026-12-01T00:00:00Z",
  ip: null,
  lastSeenIp: null,
  origin: "web",
  deviceLabel: id,
});
const passkey = (id: string, lastUsedAt: string | null, createdAt: string): OwnPasskey => ({ id, label: id, createdAt, lastUsedAt, backedUp: false });

describe("the Account previews keep what matters inside their first five rows (review of #654)", () => {
  it("sessions: this device first however old, then the most recently seen; never seen falls back to sign-in time", () => {
    const rows = [
      session("a", false, "2026-11-10T00:00:00Z"),
      session("b", false, null, "2026-11-12T00:00:00Z"),
      session("c", false, "2026-11-13T00:00:00Z"),
      session("me", true, "2026-11-02T00:00:00Z"),
      session("d", false, "2026-11-11T00:00:00Z"),
      session("e", false, "2026-11-09T00:00:00Z"),
    ];
    expect(sortSessions(rows).map((s) => s.id)).toEqual(["me", "c", "b", "d", "a", "e"]);
    expect(rows[0]!.id).toBe("a"); // the input is not reordered in place
  });

  it("passkeys: the most recently used first, never-used ones after them by when they were added", () => {
    const rows = [
      passkey("old-unused", null, "2026-10-01T00:00:00Z"),
      passkey("used-late", "2026-11-12T00:00:00Z", "2026-09-01T00:00:00Z"),
      passkey("new-unused", null, "2026-11-13T00:00:00Z"),
      passkey("used-early", "2026-11-01T00:00:00Z", "2026-09-02T00:00:00Z"),
    ];
    expect(sortPasskeys(rows).map((p) => p.id)).toEqual(["used-late", "used-early", "new-unused", "old-unused"]);
  });
});
