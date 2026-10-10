/**
 * The demo seeder activates TOTP with the PREVIOUS step's code (so a sign-in in
 * the same window can still use the current one). If a 30 s boundary passes
 * between computing that code and the gateway checking it, the code is two
 * steps old and outside the gateway's ±1 window. This pins the boundary
 * deterministically: the fake gateway's clock jumps past two boundaries during
 * the first activation, as a slow full-suite run can do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrolAdminTotp } from "./demo-identity.js";
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
});
