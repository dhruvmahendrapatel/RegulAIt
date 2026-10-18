/**
 * The demo seeder activates TOTP with the PREVIOUS step's code (so a sign-in in
 * the same window can still use the current one). If a 30 s boundary passes
 * between computing that code and the gateway checking it, the code is two
 * steps old and outside the gateway's ±1 window. This pins the boundary
 * deterministically: the fake gateway's clock jumps past two boundaries during
 * the first activation, as a slow full-suite run can do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrolAdminsTotp, enrolAdminTotp } from "./demo-identity.js";
import { totpCode, totpStep } from "./totp.js";

const SECRET = "JBSWY3DPEHPK3PXP"; // synthetic, test-only

function reply(statusCode: number, body: unknown = {}) {
  return { statusCode, body: JSON.stringify(body), headers: {}, json: () => body };
}

describe("enrolAdminTotp across a TOTP step boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("enrols even when the first activation code goes stale before the gateway checks it", async () => {
    // 29 s into a step: the next boundary is one second away
    let clock = 1_000_000 * 30_000 + 29_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let activations = 0;
    const app = {
      inject: async (opts: { method: string; url: string; payload?: object }) => {
        if (opts.url === "/v1/users") return reply(200, { users: [{ id: "u1", email: "a@example.test", totpEnabled: false, hasPassword: false }] });
        if (opts.url.endsWith("/set-initial-password")) return reply(200, { password: "synthetic-one-time" });
        if (opts.url === "/auth/login") return { ...reply(200), headers: { "set-cookie": ["regulait_session=s1; Path=/"] } };
        if (opts.url === "/auth/totp/enroll") return reply(200, { secret: SECRET, otpauthUri: "otpauth://totp/x" });
        if (opts.url === "/auth/totp/activate") {
          activations += 1;
          // the first request is slow: two boundaries pass before the gateway checks the code
          if (activations === 1) clock += 31_000;
          const now = totpStep(clock);
          const code = (opts.payload as { code: string }).code;
          const ok = [now - 1, now, now + 1].some((s) => totpCode(SECRET, s) === code);
          return reply(ok ? 200 : 401, ok ? {} : { error: "invalid_code" });
        }
        if (opts.url === "/auth/logout") return reply(204);
        throw new Error(`unexpected ${opts.method} ${opts.url}`);
      },
    };
    const out = await enrolAdminTotp(app, "boot", "u1");
    expect(out.status).toBe("enrolled");
    expect(activations).toBe(2);
  });

  it("enrolAdminsTotp issues every one-time password before the first activation ends first-admin setup", async () => {
    const order: string[] = [];
    let windowOpen = true;
    const app = {
      inject: async (opts: { method: string; url: string; headers?: Record<string, string>; payload?: object }) => {
        if (opts.url === "/v1/users")
          return reply(200, {
            users: ["u1", "u2"].map((id) => ({ id, email: `${id}@example.test`, totpEnabled: false, hasPassword: false })),
          });
        const issue = /^\/v1\/users\/(u\d)\/set-initial-password$/.exec(opts.url);
        if (issue) {
          order.push(`issue ${issue[1]}`);
          // the bootstrap credential's step-up passes only while no admin has an authenticator (B4S-06)
          return windowOpen ? reply(200, { password: `synthetic-${issue[1]}` }) : reply(403, { error: "step_up_required" });
        }
        if (opts.url === "/auth/login") {
          const who = String((opts.payload as { identifier: string }).identifier).split("@")[0]!;
          return { ...reply(200), headers: { "set-cookie": [`regulait_session=${who}; Path=/`] } };
        }
        if (opts.url === "/auth/totp/enroll") return reply(200, { secret: SECRET, otpauthUri: "otpauth://totp/x" });
        if (opts.url === "/auth/totp/activate") {
          order.push(`activate ${opts.headers?.cookie?.split("=")[1]}`);
          windowOpen = false;
          return reply(200, {});
        }
        if (opts.url === "/auth/logout") return reply(204);
        throw new Error(`unexpected ${opts.method} ${opts.url}`);
      },
    };
    const out = await enrolAdminsTotp(app, "boot", ["u1", "u2"]);
    expect(out.map((o) => o.status)).toEqual(["enrolled", "enrolled"]);
    expect(order).toEqual(["issue u1", "issue u2", "activate u1", "activate u2"]);
  });
});
