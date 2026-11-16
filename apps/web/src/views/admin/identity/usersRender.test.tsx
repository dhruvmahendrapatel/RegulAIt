import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminUser } from "../../../api/adminTypes";
import { USER_COLUMNS, roleBadge, signInLabel, statusBadge } from "./UsersPage";

const user = (over: Partial<AdminUser>): AdminUser => ({ isAdmin: false, hasPassword: true, mustChangePassword: false, disabledAt: null, ...over }) as AdminUser;
const column = (key: string) => USER_COLUMNS.find((c) => c.key === key)!;

describe("users: one renderer per fact, shared by the list and the detail status row", () => {
  it("names the sign-in method the same way everywhere", () => {
    expect(signInLabel(user({ mustChangePassword: true }))).toBe("one-time password");
    expect(signInLabel(user({}))).toBe("password");
    expect(signInLabel(user({ hasPassword: false }))).toBe("no password");
    expect(column("signIn").render).toBe(signInLabel);
  });

  it("uses the same role and status badges in the list columns", () => {
    expect(column("role").render).toBe(roleBadge);
    expect(column("status").render).toBe(statusBadge);
    expect(renderToStaticMarkup(<>{roleBadge(user({ isAdmin: true }))}</>)).toContain("admin");
    expect(renderToStaticMarkup(<>{statusBadge(user({ disabledAt: "2026-11-01T00:00:00Z" }))}</>)).toContain("disabled");
    expect(renderToStaticMarkup(<>{statusBadge(user({}))}</>)).toContain("active");
  });
});
