/**
 * ADR-0364 S3 — the `RobotPage` seam over playwright-core (Apache-2.0, pinned exactly; §9). We write no browser code:
 * this maps the step executor's few operations onto Playwright's own calls.
 *
 *  - Chromium headless, from the image's baked browser (`executablePath`, or PLAYWRIGHT_BROWSERS_PATH); nothing is
 *    downloaded at run time (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 in the image);
 *  - one fresh, non-persistent context (no profile, cookie or storage outlives the run), downloads into the run's
 *    tmpfs work directory, service workers blocked;
 *  - every request goes through the run's own Smokescreen (`proxyServer`, required: there is no unproxied mode);
 *  - the in-browser second line (§7): `context.route('**\/*')` aborts every request whose URL is not on an allowed
 *    origin (only `about:blank` and `data:` pass besides), and `routeWebSocket` closes every socket that is not;
 *  - traces are never started (S3: traces off).
 */
import { readFile, stat } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type LaunchOptions as PlaywrightLaunchOptions, type Page } from "playwright-core";
import { originAllowed } from "@regulait/shared";
import type { RobotPage } from "./executor.js";

export interface LaunchOptions {
  allowedOrigins: readonly string[];
  /** the run's Smokescreen, `http://host:port` */
  proxyServer: string;
  /** where downloads land (the sandbox's tmpfs) */
  downloadsPath: string;
  /** the baked Chromium; absent = Playwright's own lookup under PLAYWRIGHT_BROWSERS_PATH */
  executablePath?: string;
}

/** the URL check the route handlers apply (exported for tests) */
export function requestAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  if (url === "about:blank" || url.startsWith("data:")) return true;
  return originAllowed(url, allowedOrigins);
}

/** a WebSocket URL is judged as the https URL of the same host and port */
export function webSocketAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  if (!url.startsWith("wss://")) return false;
  return originAllowed(`https://${url.slice("wss://".length)}`, allowedOrigins);
}

export interface RobotBrowser {
  page: RobotPage;
  close(): Promise<void>;
}

class PlaywrightRobotPage implements RobotPage {
  constructor(private readonly p: Page) {}
  url(): string {
    return this.p.url();
  }
  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.p.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  }
  async fill(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.p.locator(selector).fill(value, { timeout: timeoutMs });
  }
  async click(selector: string, timeoutMs: number): Promise<void> {
    await this.p.locator(selector).click({ timeout: timeoutMs });
  }
  async select(selector: string, value: string, timeoutMs: number): Promise<void> {
    await this.p.locator(selector).selectOption(value, { timeout: timeoutMs });
  }
  async innerText(selector: string, timeoutMs: number): Promise<string> {
    return this.p.locator(selector).innerText({ timeout: timeoutMs });
  }
  async visibleText(selector: string, timeoutMs: number): Promise<string> {
    const l = this.p.locator(selector);
    await l.waitFor({ state: "visible", timeout: timeoutMs });
    return l.innerText({ timeout: timeoutMs });
  }
  async download(selector: string, timeoutMs: number, maxBytes: number): Promise<Buffer | "too_large"> {
    const [d] = await Promise.all([this.p.waitForEvent("download", { timeout: timeoutMs }), this.p.locator(selector).click({ timeout: timeoutMs })]);
    try {
      const file = await d.path();
      if ((await stat(file)).size > maxBytes) return "too_large";
      return await readFile(file);
    } finally {
      await d.delete().catch(() => undefined);
    }
  }
  async screenshot(mask: readonly string[], timeoutMs: number): Promise<Buffer> {
    return this.p.screenshot({
      type: "jpeg",
      quality: 70,
      mask: mask.map((s) => this.p.locator(s)),
      animations: "disabled",
      caret: "hide",
      timeout: timeoutMs,
    });
  }
}

/**
 * Code review 2: Chromium's own switches that keep every byte on the proxy. The proxy carries TCP (CONNECT) only, so:
 *  - WebRTC may use no UDP that does not go through the proxy (`disable_non_proxied_udp`: no host or STUN candidates,
 *    no non-proxied UDP; Chromium's `--force-webrtc-ip-handling-policy`, which a page cannot change);
 *  - no QUIC (HTTP/3 is UDP and would not use the HTTP proxy).
 * Playwright adds `--proxy-server` and `--proxy-bypass-list=<-loopback>` itself (loopback is proxied too, so refused).
 * The network under them already has no route but the proxy (an internal network whose only peer is the proxy); these
 * keep the browser from trying.
 */
export const ROBOT_CHROMIUM_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"] as const;

/** the options `chromium.launch` gets (pure; exported for tests) */
export function robotLaunchOptions(opts: LaunchOptions): PlaywrightLaunchOptions {
  if (!/^http:\/\/[A-Za-z0-9.-]+:\d{1,5}$/.test(opts.proxyServer)) throw new Error("the egress proxy must be http://host:port");
  return {
    headless: true,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    proxy: { server: opts.proxyServer },
    downloadsPath: opts.downloadsPath,
    args: [...ROBOT_CHROMIUM_ARGS],
    // Chromium's own sandbox stays OFF (Playwright's default, stated here): it needs user namespaces or a setuid
    // helper, which the robot_browser sandbox (no capabilities, no-new-privileges, seccomp, gVisor) withholds. The
    // isolation boundary is that sandbox, not Chromium's (an accepted risk, ADR-0364).
    chromiumSandbox: false,
  };
}

export async function launchRobotBrowser(opts: LaunchOptions): Promise<RobotBrowser> {
  const browser: Browser = await chromium.launch(robotLaunchOptions(opts));
  try {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: true, serviceWorkers: "block", permissions: [] });
    await context.route("**/*", (route) => (requestAllowed(route.request().url(), opts.allowedOrigins) ? route.continue() : route.abort("blockedbyclient")));
    await context.routeWebSocket(/.*/, (ws) => (webSocketAllowed(ws.url(), opts.allowedOrigins) ? ws.connectToServer() : ws.close()));
    const page = await context.newPage();
    return {
      page: new PlaywrightRobotPage(page),
      close: async () => {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      },
    };
  } catch (e) {
    await browser.close().catch(() => undefined);
    throw e;
  }
}
