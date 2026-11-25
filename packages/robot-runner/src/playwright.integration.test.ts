/**
 * Optional: the `RobotPage` adapter against a REAL Chromium. Runs only when REGULAIT_TEST_PLAYWRIGHT_CHROMIUM names a
 * Chromium binary (skipped otherwise, e.g. in CI without a browser). Pages are `data:` URLs (allowed by the route
 * check), so no TLS is needed; a local http server proves the in-browser route check aborts a request off the allowed
 * origins before it leaves the browser, and a local proxy proves every launch is pointed at the run's proxy.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRobotBrowser, requestAllowed, webSocketAllowed, type RobotBrowser } from "./playwright.js";

const chromiumPath = process.env.REGULAIT_TEST_PLAYWRIGHT_CHROMIUM;
const allowed = ["https://app.example.com"];

describe("route checks (pure)", () => {
  it("allow only about:blank, data: and the allowed https origins", () => {
    expect(requestAllowed("about:blank", allowed)).toBe(true);
    expect(requestAllowed("data:text/html,x", allowed)).toBe(true);
    expect(requestAllowed("https://app.example.com/a?b", allowed)).toBe(true);
    for (const u of ["http://app.example.com/", "https://app.example.com:444/", "https://evil.example.com/", "blob:https://app.example.com/1", "file:///etc/passwd", "ftp://x/"]) expect(requestAllowed(u, allowed)).toBe(false);
    expect(webSocketAllowed("wss://app.example.com/ws", allowed)).toBe(true);
    for (const u of ["ws://app.example.com/ws", "wss://evil.example.com/ws"]) expect(webSocketAllowed(u, allowed)).toBe(false);
  });
});

describe.skipIf(!chromiumPath)("launchRobotBrowser (real Chromium)", () => {
  let browser: RobotBrowser;
  let server: Server;
  let proxy: Server;
  const hits: string[] = [];
  let serverOrigin = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("leak");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    serverOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    proxy = createServer((_req, res) => {
      res.statusCode = 403;
      res.end();
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    browser = await launchRobotBrowser({
      allowedOrigins: allowed,
      proxyServer: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      downloadsPath: mkdtempSync(path.join(tmpdir(), "robot-dl-")),
      executablePath: chromiumPath!,
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    proxy?.close();
  });

  const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`)}`;

  it("fills, selects, reads and checks on a page, and takes a masked JPEG", async () => {
    const p = browser.page;
    await p.goto(html(`<input id="u"><input id="pw" type="text"><select id="s"><option>a</option><option>b</option></select><p id="t">Total: 42</p>`), 10_000);
    await p.fill("#u", "robot", 5_000);
    await p.fill("#pw", "CANARY-visible-text", 5_000);
    await p.select("#s", "b", 5_000);
    expect(await p.innerText("#t", 5_000)).toBe("Total: 42");
    expect(await p.visibleText("#t", 5_000)).toContain("42");
    const shot = await p.screenshot(["#u", "#pw", "#s"], 10_000);
    expect(shot.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    await expect(p.visibleText("#nope", 500)).rejects.toThrow();
  }, 60_000);

  it("takes a download, capped", async () => {
    const p = browser.page;
    const data = Buffer.from("hello download").toString("base64");
    await p.goto(html(`<a id="dl" download="f.txt" href="data:application/octet-stream;base64,${data}">get</a>`), 10_000);
    expect((await p.download("#dl", 10_000, 1024)) as Buffer).toEqual(Buffer.from("hello download"));
    expect(await p.download("#dl", 10_000, 4)).toBe("too_large");
  }, 60_000);
  it("aborts a request off the allowed origins inside the browser (the server never sees it)", async () => {
    const p = browser.page;
    await p.goto(html(`<img src="${serverOrigin}/img.png"><script>fetch("${serverOrigin}/fetch").catch(()=>{})</script><p id="done">ok</p>`), 10_000);
    await p.visibleText("#done", 5_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(hits).toEqual([]);
    await expect(p.goto(`${serverOrigin}/nav`, 5_000)).rejects.toThrow();
    expect(hits).toEqual([]);
  }, 60_000);

});
