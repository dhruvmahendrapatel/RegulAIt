import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// FS-53: the sign-in policy help text names the shipped strict defaults (ADR-0181),
// read from the shared constants and the schema column defaults, never re-typed.
const page = readFileSync(new URL("./SsoPage.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
const shared = readFileSync(new URL("../../../../../../packages/shared/src/identity-defaults.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../../../../../packages/db/src/schema.ts", import.meta.url), "utf8");
const num = (src: string, re: RegExp) => Number(src.match(re)?.[1]);

describe("SSO page sign-in policy defaults copy", () => {
  it("states the password classes and idle wall the install ships with", () => {
    const classes = num(shared, /passwordRequireClasses: (\d+)/);
    const idle = num(shared, /sessionIdleMinutes: (\d+)/);
    expect(classes).toBe(3);
    expect(page).toContain(`using ${classes} of 4 character classes`);
    expect(page).toContain(`with a ${idle}-minute idle wall`);
    expect(page).not.toContain("2 of 4 character classes");
    expect(page).not.toContain("2h idle");
  });
  it("states the length, lifetime and lockout the schema defaults to", () => {
    expect(page).toContain(`${num(schema, /password_min_length"\)\.notNull\(\)\.default\((\d+)\)/)}+ characters`);
    expect(page).toContain(`at most ${num(schema, /session_lifetime_hours"\)\.notNull\(\)\.default\((\d+)\)/)}h`);
    expect(page).toContain(
      `${num(schema, /login_lockout_threshold"\)\.notNull\(\)\.default\((\d+)\)/)} failures inside ${num(schema, /login_lockout_window_minutes"\)\.notNull\(\)\.default\((\d+)\)/)} minutes`,
    );
  });
});
