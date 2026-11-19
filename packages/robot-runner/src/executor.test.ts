import { createHash } from "node:crypto";
import { ROBOT_EVIDENCE_CHUNK_BYTES, robotEvidenceUploadSchema, robotRunResultSchema } from "@regulait/shared";
import { describe, expect, it } from "vitest";
import { runRobotPlan, uploadEvidence } from "./executor.js";
import { FakeGateway, FakePage, makePlan, SECRET_VALUE } from "./fakes.test-helpers.js";

const login = [
  { op: "goto", url: "https://app.example.com/login" },
  { op: "fill", selector: "#user", value: "robot" },
  { op: "fill_secret", selector: "#pass", secretRef: "password" },
  { op: "click", selector: "#go" },
  { op: "read", selector: "#balance", output: "balance" },
] as const;

async function run(plan: ReturnType<typeof makePlan>, page = new FakePage(), gw = new FakeGateway(), now?: () => number) {
  const result = await runRobotPlan(plan.plan, { page, gateway: gw, runKey: plan.runKey, ...(now ? { now } : {}) });
  expect(robotRunResultSchema.safeParse(result).success).toBe(true);
  expect(gw.results).toEqual([result]);
  for (const c of gw.evidenceChunks) expect(robotEvidenceUploadSchema.safeParse(c).success).toBe(true);
  return { result, page, gw };
}

describe("runRobotPlan", () => {
  it("runs the steps in order with a heartbeat before each, and reports outputs", async () => {
    const page = new FakePage();
    page.texts["#balance"] = "42.00";
    const { result, gw } = await run(makePlan([...login]), page);
    expect(result).toEqual({ status: "succeeded", stepsCompleted: 5, outputs: { balance: "42.00" } });
    expect(gw.heartbeats).toEqual([0, 1, 2, 3, 4]);
    expect(page.values.get("#pass")).toBe(SECRET_VALUE);
    expect(page.calls).toEqual(["goto https://app.example.com/login", "fill #user", "fill #pass", "click #go"]);
  });

  it("refuses a goto off the allowed origins (navigation_refused) and never navigates", async () => {
    for (const url of ["https://evil.example.net/", "http://app.example.com/", "https://app.example.com:8443/", "data:text/html,x"]) {
      const { result, page } = await run(makePlan([{ op: "goto", url }]));
      expect(result).toMatchObject({ status: "failed", failureCode: "navigation_refused", failedStep: 0, stepsCompleted: 0 });
      expect(page.calls).toEqual([]);
    }
  });

  it("fills a secret only on its own origin (secret_origin_mismatch on another allowed origin)", async () => {
    const page = new FakePage();
    const { result } = await run(
      makePlan([
        { op: "goto", url: "https://other.example.com/form" },
        { op: "fill_secret", selector: "#pass", secretRef: "password" },
      ]),
      page,
    );
    expect(result).toMatchObject({ status: "failed", failureCode: "secret_origin_mismatch", failedStep: 1, stepsCompleted: 1 });
    expect(page.values.has("#pass")).toBe(false);
  });

  it("re-checks the origin at the fill: a click that moved the page off the secret's origin stops the fill", async () => {
    const page = new FakePage();
    page.navigateOnClick["#next"] = "https://other.example.com/phish";
    const { result } = await run(
      makePlan([
        { op: "goto", url: "https://app.example.com/" },
        { op: "click", selector: "#next" },
        { op: "fill_secret", selector: "#pass", secretRef: "password" },
      ]),
      page,
    );
    expect(result.failureCode).toBe("secret_origin_mismatch");
    expect([...page.values.values()]).not.toContain(SECRET_VALUE);
  });

  it("an unknown secret ref, or a sealed value that does not open, never fills", async () => {
    const page = new FakePage();
    const { result } = await run(makePlan([{ op: "goto", url: "https://app.example.com/" }, { op: "fill_secret", selector: "#p", secretRef: "nope" }]), page);
    expect(result.failureCode).toBe("secret_origin_mismatch");
    // the wrong run key: the plan's secrets do not open, the run fails before any step
    const p = makePlan([{ op: "goto", url: "https://app.example.com/" }]);
    const gw = new FakeGateway();
    const r = await runRobotPlan(p.plan, { page: new FakePage(), gateway: gw, runKey: "another-key" });
    expect(r).toEqual({ status: "failed", failureCode: "runner_error", stepsCompleted: 0, outputs: {} });
    expect(gw.heartbeats).toEqual([]);
  });

  it("caps a read at the plan's outputChars (output_too_long), never truncating", async () => {
    const page = new FakePage();
    page.texts["#t"] = "x".repeat(101);
    const { result } = await run(makePlan([{ op: "read", selector: "#t", output: "t" }]), page);
    expect(result).toMatchObject({ status: "failed", failureCode: "output_too_long", failedStep: 0, outputs: {} });
    page.texts["#t"] = "x".repeat(100);
    expect((await run(makePlan([{ op: "read", selector: "#t", output: "t" }]), page)).result.outputs.t).toHaveLength(100);
  });

  it("a download: sha256 output, bytes up as chunked evidence, capped at downloadBytes", async () => {
    const page = new FakePage();
    const bytes = Buffer.alloc(ROBOT_EVIDENCE_CHUNK_BYTES * 2 + 17, 7);
    page.downloads["#dl"] = bytes;
    const { result, gw } = await run(makePlan([{ op: "download", selector: "#dl", output: "file" }], { screenshots: "none" }), page);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(result).toEqual({ status: "succeeded", stepsCompleted: 1, outputs: { file: `sha256:${sha}` } });
    expect(gw.evidenceChunks.map((c) => [c.item, c.kind, c.chunk, c.last])).toEqual([
      [0, "download", 0, false],
      [0, "download", 1, false],
      [0, "download", 2, true],
    ]);
    expect(gw.evidenceChunks[2]).toMatchObject({ size: bytes.length, sha256: sha, step: 0, contentType: "application/octet-stream" });
    expect(Buffer.concat(gw.evidenceChunks.map((c) => Buffer.from(c.dataBase64, "base64")))).toEqual(bytes);

    page.downloads["#big"] = Buffer.alloc(1024 * 1024 + 1);
    const big = await run(makePlan([{ op: "download", selector: "#big", output: "file" }]), page);
    expect(big.result).toMatchObject({ status: "failed", failureCode: "download_too_large" });
    expect(big.gw.evidenceChunks).toEqual([]);
  });

  it("check: the element must be visible, and hold the text when one is given", async () => {
    const page = new FakePage();
    page.visible.add("#ok");
    page.texts["#ok"] = "Payment received";
    expect((await run(makePlan([{ op: "check", selector: "#ok", text: "received" }]), page)).result.status).toBe("succeeded");
    expect((await run(makePlan([{ op: "check", selector: "#ok", text: "refused" }]), page)).result).toMatchObject({ failureCode: "step_failed" });
    expect((await run(makePlan([{ op: "check", selector: "#gone" }]), page)).result).toMatchObject({ failureCode: "step_failed", failedStep: 0 });
  });

  it("a heartbeat answering cancel stops the run at the next step: cancelled / halted", async () => {
    const gw = new FakeGateway();
    gw.cancelAtStep = 2;
    const page = new FakePage();
    const { result } = await run(makePlan([...login]), page, gw);
    expect(result).toEqual({ status: "cancelled", failureCode: "halted", stepsCompleted: 2, outputs: {} });
    expect(page.calls).toEqual(["goto https://app.example.com/login", "fill #user"]);
  });

  it("a heartbeat that cannot be delivered fails the run as runner_error, before the step runs", async () => {
    const gw = new FakeGateway();
    gw.failHeartbeat = true;
    const page = new FakePage();
    const { result } = await run(makePlan([...login]), page, gw);
    expect(result).toMatchObject({ status: "failed", failureCode: "runner_error", failedStep: 0 });
    expect(page.calls).toEqual([]);
  });

  it("the wall clock ends the run timed_out, mid-step", async () => {
    const page = new FakePage();
    page.delayMs = 200;
    const { result } = await run(makePlan([...login], { limits: { wallClockMs: 300, actionTimeoutMs: 5_000, outputChars: 100, downloadBytes: 1024 } }), page);
    expect(result).toMatchObject({ status: "timed_out", failureCode: "timed_out", failedStep: 1, stepsCompleted: 1 });
  });

  it("a page error is step_failed with no page text anywhere in the result", async () => {
    const page = new FakePage();
    const { result, gw } = await run(makePlan([{ op: "goto", url: "https://app.example.com/" }, { op: "fill_secret", selector: "#p", secretRef: "password" }, { op: "read", selector: "#missing", output: "x" }]), page);
    expect(result).toMatchObject({ status: "failed", failureCode: "step_failed", failedStep: 2, stepsCompleted: 2 });
    // the fake's error message quotes the page's values: none of it reaches the gateway
    expect(JSON.stringify(gw.results)).not.toContain(SECRET_VALUE);
  });

  it("masked screenshots: JPEG evidence after every step, masked over every selector filled so far", async () => {
    const page = new FakePage();
    page.texts["#balance"] = "1";
    const { gw } = await run(makePlan([...login, { op: "select", selector: "#acct", value: "savings" }]), page);
    expect(page.masks).toEqual([[], ["#user"], ["#user", "#pass"], ["#user", "#pass"], ["#user", "#pass"], ["#user", "#pass", "#acct"]]);
    const shots = gw.evidenceChunks.filter((c) => c.kind === "screenshot");
    expect(shots.map((c) => [c.item, c.step, c.contentType])).toEqual([0, 1, 2, 3, 4, 5].map((i) => [i, i, "image/jpeg"]));
  });

  it("screenshots none: no evidence at all, and no screenshot is taken", async () => {
    const page = new FakePage();
    page.texts["#balance"] = "1";
    const { gw } = await run(makePlan([...login], { screenshots: "none" }), page);
    expect(page.masks).toEqual([]);
    expect(gw.evidenceChunks).toEqual([]);
  });

  it("CANARY: the secret value is in no evidence byte and no result, only in the fill", async () => {
    const page = new FakePage();
    page.texts["#balance"] = "1";
    const p = makePlan([...login, { op: "read", selector: "#balance", output: "again" }]);
    const { gw } = await run(p, page);
    const sealed = p.plan.secrets[0]!.sealed;
    const evidenceBytes = Buffer.concat(gw.evidenceChunks.map((c) => Buffer.from(c.dataBase64, "base64"))).toString("utf8");
    for (const needle of [SECRET_VALUE, sealed, p.runKey]) {
      expect(evidenceBytes).not.toContain(needle);
      expect(JSON.stringify(gw.evidenceChunks)).not.toContain(needle);
      expect(JSON.stringify(gw.results)).not.toContain(needle);
    }
    expect(Buffer.from(SECRET_VALUE).toString("base64")).not.toBe("");
    expect(JSON.stringify(gw.evidenceChunks)).not.toContain(Buffer.from(SECRET_VALUE).toString("base64").slice(0, 16));
  });
});

describe("uploadEvidence", () => {
  it("an empty item is one last chunk naming size 0", async () => {
    const gw = new FakeGateway();
    await uploadEvidence(gw, 3, "screenshot", 1, "image/jpeg", Buffer.alloc(0));
    expect(gw.evidenceChunks).toEqual([{ item: 3, kind: "screenshot", step: 1, contentType: "image/jpeg", chunk: 0, dataBase64: "", last: true, size: 0, sha256: createHash("sha256").digest("hex") }]);
  });
});
