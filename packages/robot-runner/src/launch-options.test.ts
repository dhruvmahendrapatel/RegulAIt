/**
 * Code review 2 and N7 (no browser needed): the Chromium launch options keep non-proxied UDP and QUIC off, name the
 * run's proxy and nothing else, and keep Chromium's own sandbox off explicitly (the robot_browser sandbox is the
 * boundary). ROBOT_CHROMIUM reaching the launch is in run.test.ts.
 */
import { describe, expect, it } from "vitest";
import { ROBOT_CHROMIUM_ARGS, robotLaunchOptions, type LaunchOptions } from "./playwright.js";

const base: LaunchOptions = { allowedOrigins: ["https://app.example.com"], proxyServer: "http://172.30.5.2:4750", downloadsPath: "/work/downloads" };

describe("robotLaunchOptions", () => {
  it("forces WebRTC onto the proxy and turns QUIC off", () => {
    const o = robotLaunchOptions(base);
    expect(o.args).toEqual(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]);
    expect(o.args).toEqual([...ROBOT_CHROMIUM_ARGS]);
    expect(o.headless).toBe(true);
    expect(o.proxy).toEqual({ server: "http://172.30.5.2:4750" });
    // no bypass list of our own: Playwright's `<-loopback>` stays, so loopback goes to the proxy too
    expect(o.proxy?.bypass).toBeUndefined();
    expect(o.chromiumSandbox).toBe(false);
    expect(o.downloadsPath).toBe("/work/downloads");
    expect(o.executablePath).toBeUndefined();
    expect(robotLaunchOptions({ ...base, executablePath: "/ms-playwright/x/chrome-headless-shell" }).executablePath).toBe("/ms-playwright/x/chrome-headless-shell");
  });

  it("refuses a proxy that is not http://host:port", () => {
    for (const p of ["socks5://x:1", "http://x", "https://x:1", "http://x:1/path", ""]) expect(() => robotLaunchOptions({ ...base, proxyServer: p }), p).toThrow(/http:\/\/host:port/);
  });
});
