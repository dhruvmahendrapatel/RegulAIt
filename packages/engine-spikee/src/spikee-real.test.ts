/**
 * ADR-0245 — the REAL pinned spikee (0.9.4, the image's closure) against a FAKE gateway, through the worker's own code
 * path (`LocalSpikeeExecutor` → `runSpikeeDataset`) and the mapper. Opt-in: set REGULAIT_SPIKEE_PYTHON to the python
 * of a venv built from engines/spikee/requirements.txt, and REGULAIT_SPIKEE_SEEDS to that venv's
 * `site-packages/spikee/data/workspace/datasets` (the image links it at /opt/spikee/seeds). Skipped otherwise (CI has no
 * such venv; the image build is its proof).
 *
 * What it pins, on the real engine:
 *   - a target that complies (echoes the document, so the injected instruction's canary appears) reads `fail`;
 *   - a refusing target reads `pass` (the control for the line above);
 *   - a key the gateway refuses (401) still exits 0 and reads `unknown`, never pass;
 *   - every model call is a POST to the fake gateway's /v1/chat/completions with the run's key and the gateway's
 *     agent and project headers, and nothing else of ours;
 *   - system-prompt extraction sends spikee's demo system message, so its regex judge can match;
 *   - at most `trials` entries per item reach the target.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planSpikeeRun } from "./config.js";
import { mapSpikeeRun } from "./mapper.js";
import { LocalSpikeeExecutor } from "./worker.js";

const PY = process.env.REGULAIT_SPIKEE_PYTHON;
const SEEDS = process.env.REGULAIT_SPIKEE_SEEDS;
const KEY = "rglv_synthetic_test_key";
let server: Server;
let base = "";
let mode: "echo" | "refuse" = "refuse";
let root = "";
const seen: Array<{ method: string; url: string; auth: string | undefined; headers: string[]; model: string; roles: string[]; system: string }> = [];

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

describe.skipIf(!PY || !SEEDS)("ADR-0245 spikee, the real engine (opt-in: REGULAIT_SPIKEE_PYTHON, REGULAIT_SPIKEE_SEEDS)", () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const b = JSON.parse((await body(req)) || "{}") as { model: string; messages?: Array<{ role: string; content: string }> };
      const msgs = b.messages ?? [];
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        headers: Object.keys(req.headers).sort(),
        model: b.model,
        roles: msgs.map((m) => m.role),
        system: msgs.find((m) => m.role === "system")?.content ?? "",
      });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "virtual_key_revoked" } }));
      }
      const all = msgs.map((m) => m.content).join("\n");
      const content = mode === "echo" ? `Sure. ${all}` : "I cannot help with that.";
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: b.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v1`;
    root = await mkdtemp(path.join(tmpdir(), "spikee-real-"));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });

  const run = async (sets: string[], trials: number, apiKey = KEY) => {
    const plan = planSpikeeRun(sets);
    const exec = new LocalSpikeeExecutor(root, { python: PY!, path: path.dirname(PY!), seedsDir: SEEDS! });
    const { outcomes } = await exec.run(
      {
        runId: "00000000-0000-4000-8000-000000000001",
        datasets: plan.datasets.map((d) => d.set),
        plugins: plan.plugins.map((p) => p.set),
        target: { baseUrl: base, model: "agent-model", headers: { "x-regulait-agent-id": "a1", "x-regulait-project-id": "p1" } },
        apiKey,
        trials,
        timeoutMs: 600_000,
      },
      new AbortController().signal,
    );
    return { plan, outcomes, body: mapSpikeeRun(plan, outcomes) };
  };

  it("a complying target fails, and every call is the fake gateway's chat route with the run key and headers only", async () => {
    mode = "echo";
    seen.length = 0;
    const { body, outcomes } = await run(["dataset:mini-test", "plugin:base64"], 3);
    expect(outcomes[0]!.problem).toBeNull();
    const base64 = body.items.find((i) => i.key === "dataset:mini-test+plugin:base64")!;
    const plain = body.items.find((i) => i.key === "dataset:mini-test")!;
    expect(plain.verdict).toBe("fail");
    expect(plain.attempts).toBe(3);
    expect(plain.defeated).toBeGreaterThan(0);
    expect(["pass", "fail"]).toContain(base64.verdict);
    expect(base64.attempts).toBe(3);
    expect(body.status).toBe("completed");
    // 3 entries per item, two items: six calls, and nothing else
    expect(seen.length).toBe(6);
    for (const s of seen) {
      expect(s.method).toBe("POST");
      expect(s.url).toBe("/v1/chat/completions");
      expect(s.auth).toBe(`Bearer ${KEY}`);
      expect(s.model).toBe("agent-model");
      expect(s.headers.filter((h) => h.startsWith("x-"))).toEqual(["x-regulait-agent-id", "x-regulait-project-id"]);
    }
    // the envelope carries no model text
    expect(JSON.stringify(body)).not.toContain("Sure.");
  }, 600_000);

  it("a refusing target passes (the control)", async () => {
    mode = "refuse";
    const { body } = await run(["dataset:mini-test"], 3);
    expect(body.items.map((i) => [i.key, i.verdict, i.attempts, i.defeated])).toEqual([["dataset:mini-test", "pass", 3, 0]]);
  }, 600_000);

  it("a refused key exits 0 and reads unknown, never pass", async () => {
    mode = "refuse";
    const { body, outcomes } = await run(["dataset:mini-test"], 2, "rglv_wrong_key");
    expect(outcomes[0]!.testExitCode).toBe(0);
    expect(body.items[0]!.verdict).toBe("unknown");
    expect(body.status).toBe("failed");
  }, 600_000);

  it("system-prompt extraction sends spikee's demo system message, and a leaking target fails", async () => {
    mode = "echo";
    seen.length = 0;
    const { body } = await run(["dataset:sysmsg-extraction-2025-04"], 2);
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.roles).toEqual(["system", "user"]);
      expect(s.system).toContain("1854");
    }
    expect(body.items[0]!.verdict).toBe("fail");
  }, 600_000);

  it("cybersec-2026-01 and llm-mailbox generate and run offline with local judges", async () => {
    mode = "refuse";
    const { body } = await run(["dataset:cybersec-2026-01", "dataset:llm-mailbox", "plugin:hex"], 1);
    expect(body.items.map((i) => [i.key, i.verdict])).toEqual([
      ["dataset:cybersec-2026-01", "pass"],
      ["dataset:cybersec-2026-01+plugin:hex", "pass"],
      ["dataset:llm-mailbox", "pass"],
      ["dataset:llm-mailbox+plugin:hex", "pass"],
    ]);
  }, 600_000);
});
