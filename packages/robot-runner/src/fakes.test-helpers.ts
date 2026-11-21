/** test doubles for the robot runner (no browser, no gateway); imported by the *.test.ts files only */
import { newRobotRunKey, sealRobotSecret, type RobotEvidenceUpload, type RobotPlanStep, type RobotRunPlan, type RobotRunResult } from "@regulait/shared";
import type { RobotGateway, RobotPage } from "./executor.js";

export const RUN_ID = "4b8f0c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
export const SECRET_VALUE = "CANARY-s3cr3t-Value-91f2";

/** a page that "renders" every filled value into its screenshot unless the value's selector is masked */
export class FakePage implements RobotPage {
  current = "about:blank";
  values = new Map<string, string>();
  texts: Record<string, string> = {};
  visible = new Set<string>();
  downloads: Record<string, Buffer> = {};
  /** a click on this selector moves the page to this URL */
  navigateOnClick: Record<string, string> = {};
  /** ms an action takes */
  delayMs = 0;
  masks: string[][] = [];
  calls: string[] = [];
  private async wait() {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
  }
  url() {
    return this.current;
  }
  async goto(url: string) {
    this.calls.push(`goto ${url}`);
    await this.wait();
    this.current = url;
  }
  async fill(selector: string, value: string) {
    this.calls.push(`fill ${selector}`);
    await this.wait();
    this.values.set(selector, value);
  }
  async click(selector: string) {
    this.calls.push(`click ${selector}`);
    await this.wait();
    if (this.navigateOnClick[selector]) this.current = this.navigateOnClick[selector]!;
  }
  async select(selector: string, value: string) {
    this.calls.push(`select ${selector}`);
    this.values.set(selector, value);
  }
  async innerText(selector: string) {
    const t = this.texts[selector];
    if (t === undefined) throw new Error(`no element ${selector}: page says ${JSON.stringify([...this.values.values()])}`);
    return t;
  }
  async visibleText(selector: string) {
    if (!this.visible.has(selector)) throw new Error("not visible");
    return this.texts[selector] ?? "";
  }
  async download(selector: string, _t: number, max: number) {
    const b = this.downloads[selector];
    if (!b) throw new Error("no download");
    return b.length > max ? ("too_large" as const) : b;
  }
  async screenshot(mask: readonly string[]) {
    this.masks.push([...mask]);
    const shown = [...this.values].map(([s, v]) => (mask.includes(s) ? [s, "█████"] : [s, v]));
    return Buffer.from(JSON.stringify({ url: this.current, shown }), "utf8");
  }
}

export class FakeGateway implements RobotGateway {
  heartbeats: number[] = [];
  evidenceChunks: RobotEvidenceUpload[] = [];
  results: RobotRunResult[] = [];
  cancelAtStep: number | null = null;
  failHeartbeat = false;
  async heartbeat(step: number) {
    if (this.failHeartbeat) throw new Error("channel down");
    this.heartbeats.push(step);
    return { cancel: this.cancelAtStep !== null && step >= this.cancelAtStep };
  }
  async evidence(chunk: RobotEvidenceUpload) {
    this.evidenceChunks.push(chunk);
  }
  async result(r: RobotRunResult) {
    this.results.push(r);
  }
}

export function makePlan(steps: RobotPlanStep[], over: Partial<RobotRunPlan> = {}, runKey = newRobotRunKey()): { plan: RobotRunPlan; runKey: string } {
  const plan: RobotRunPlan = {
    runId: RUN_ID,
    kind: "test",
    allowedOrigins: ["https://app.example.com", "https://other.example.com"],
    steps,
    secrets: [{ ref: "password", origin: "https://app.example.com", sealed: sealRobotSecret(runKey, RUN_ID, "password", SECRET_VALUE) }],
    limits: { wallClockMs: 60_000, actionTimeoutMs: 5_000, outputChars: 100, downloadBytes: 1024 * 1024 },
    screenshots: "masked",
    ...over,
  };
  return { plan, runKey };
}
