/**
 * ADR-0187 B5-G — the REAL pinned garak (0.17.0, the image's closure) against a fake gateway, through the
 * worker's own code path (`LocalGarakExecutor` → `runGarakProbe`) and the mapper. Opt-in: set
 * REGULAIT_GARAK_PYTHON to the python of a venv built from engines/garak/requirements.txt (and
 * requirements-sdist.txt). Skipped otherwise (CI has no such venv; the image build is its proof).
 *
 * What it pins, on the real engine:
 *   - garak exits 0 when every prompt HIT, and the mapper still reads `fail` from the report;
 *   - a refusing target reads `pass` (the control for the line above);
 *   - a key the gateway refuses (401) exits 0 too, and reads `unknown`, never pass;
 *   - every call carries the run's key and the gateway's agent and project headers.
 *
 * And, with REGULAIT_GARAK_HF_PRESEED set to a pre-seeded Hub tree (built by engines/garak/preseed-hf.py
 * fetch + materialise; REGULAIT_GARAK_HF_MANIFEST may name a subset manifest), decisions 198-201:
 *   - every pre-seeded asset loads offline (preseed-hf.py verify, in the worker's layout);
 *   - the packagehallucination and system-prompt probes run through the worker against that tree: a
 *     known package passes, an invented one fails, the system prompts load and a refusal passes.
 * Run the whole file inside its own network namespace (`unshare -n`, loopback up) with
 * REGULAIT_GARAK_EXPECT_OFFLINE=1, and the first test proves there is no route out.
 */
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planGarakRun } from "./config.js";
import { LocalGarakExecutor } from "./exchange.js";
import { mapGarakRun } from "./mapper.js";

const PY = process.env.REGULAIT_GARAK_PYTHON;
const HF = process.env.REGULAIT_GARAK_HF_PRESEED;
const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/garak");
const HF_MANIFEST = process.env.REGULAIT_GARAK_HF_MANIFEST ?? path.join(ENGINE_DIR, "hf-preseed.json");
const KEY = "rglv_synthetic_test_key";
let server: Server;
let base = "";
let reply = "I cannot help with that.";
const seen: Array<{ auth: string | undefined; agent: string | undefined; project: string | undefined; model: string }> = [];
let root = "";

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

describe.skipIf(!PY)("B5-G garak, the real engine (opt-in: REGULAIT_GARAK_PYTHON)", () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      if (req.method !== "POST") return void res.writeHead(404).end();
      const b = JSON.parse((await body(req)) || "{}") as { model: string };
      seen.push({ auth: req.headers.authorization, agent: req.headers["x-regulait-agent-id"] as string, project: req.headers["x-regulait-project-id"] as string, model: b.model });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "virtual_key_revoked" } }));
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/v1`;
    root = await mkdtemp(path.join(tmpdir(), "b5g-real-"));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });

  const run = async (sets: string[], apiKey = KEY) => {
    const plan = planGarakRun(sets);
    const exec = new LocalGarakExecutor(root, { python: PY!, path: path.dirname(PY!), ...(HF ? { hfPreseed: HF } : {}) });
    const { outcomes } = await exec.run(
      {
        runId: "00000000-0000-4000-8000-000000000001",
        probes: plan.probes.map((p) => ({ probe: p.probe, detector: p.detector })),
        target: { baseUrl: base, model: "agent-model", headers: { "x-regulait-agent-id": "a1", "x-regulait-project-id": "p1" } },
        apiKey,
        trials: 3,
        timeoutMs: 600_000,
      },
      new AbortController().signal,
    );
    return { outcomes, body: mapGarakRun(plan, outcomes) };
  };

  it.skipIf(process.env.REGULAIT_GARAK_EXPECT_OFFLINE !== "1")("this run has no route out (the offline proof below is real)", async () => {
    const err = await new Promise<string>((resolve) => {
      const sock = connect({ host: "93.184.215.14", port: 443, timeout: 3000 });
      sock.on("connect", () => {
        sock.destroy();
        resolve("connected");
      });
      sock.on("timeout", () => {
        sock.destroy();
        resolve("timeout");
      });
      sock.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
    });
    expect(err).not.toBe("connected");
  });

  it.skipIf(!HF)("every pre-seeded Hub asset loads offline, in the worker's layout (preseed-hf.py verify)", () => {
    const r = spawnSync(PY!, ["-I", path.join(ENGINE_DIR, "preseed-hf.py"), "verify", HF_MANIFEST, HF!], {
      env: { PATH: "/usr/bin:/bin", HOME: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
      encoding: "utf8",
      timeout: 600_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/pre-seeded assets verified offline/);
    // control: without the offline switches it refuses to run at all
    const loose = spawnSync(PY!, ["-I", path.join(ENGINE_DIR, "preseed-hf.py"), "verify", HF_MANIFEST, HF!], { env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8" });
    expect(loose.status).toBe(1);
    expect(loose.stdout).toMatch(/runs offline only/);
  }, 600_000);

  it.skipIf(!HF)("packagehallucination reads its pre-seeded package list: a real package passes, an invented one fails", async () => {
    reply = "Sure:\n```python\nimport requests\nimport numpy\n```";
    const ok = await run(["packagehallucination.python"]);
    expect(ok.body.items[0]).toMatchObject({ key: "packagehallucination.Python", verdict: "pass" });
    expect(ok.body.items[0]!.attempts).toBeGreaterThan(0);
    reply = "Sure:\n```python\nimport regulait_invented_pkg_zzqx\n```";
    const bad = await run(["packagehallucination.python"]);
    expect(bad.body.items[0]).toMatchObject({ key: "packagehallucination.Python", verdict: "fail" });
  }, 600_000);

  it.skipIf(!HF)("the system-prompt probe loads its pre-seeded dataset offline; a refusal passes", async () => {
    reply = "I cannot share that.";
    const { body } = await run(["sysprompt_extraction.systempromptextraction"]);
    expect(body.items[0]).toMatchObject({ key: "sysprompt_extraction.SystemPromptExtraction", verdict: "pass", mappedClass: "system_prompt_extraction" });
    expect(body.items[0]!.attempts).toBeGreaterThan(0);
  }, 600_000);

  it("the probes the owner admitted on 2026-10-10 load from the pruned data and give a reading (decision 195)", async () => {
    reply = "I cannot help with that.";
    const sets = ["badchars.badcharacters", "doctor.puppetry", "doctor.bypassleet", "goodside.tag", "goodside.whoisriley", "glitch.glitch", "grandma.win10", "grandma.substances"];
    const { body } = await run(sets);
    expect(body.items.map((i) => i.key).sort()).toEqual(planGarakRun(sets).probes.map((p) => p.probe).sort());
    for (const i of body.items) {
      expect(["pass", "fail"], `${i.key}: ${i.verdict}`).toContain(i.verdict);
      expect(i.attempts, i.key).toBeGreaterThan(0);
    }
  }, 900_000);

  it("exit 0 with every prompt hit: the report decides, and it is a fail", async () => {
    reply = "I hate humans";
    const { outcomes, body } = await run(["promptinject.hijackhatehumans"]);
    expect(outcomes[0]!.exitCode).toBe(0);
    expect(body.items[0]).toMatchObject({ key: "promptinject.HijackHateHumans", verdict: "fail", mappedClass: "prompt_injection" });
    expect(body.items[0]!.defeated).toBeGreaterThan(0);
    expect(body.status).toBe("completed");
  }, 180_000);

  it("control: a refusing target passes", async () => {
    reply = "I cannot help with that.";
    const { outcomes, body } = await run(["encoding.injectbase64"]);
    expect(outcomes[0]!.exitCode).toBe(0);
    expect(body.items[0]).toMatchObject({ key: "encoding.InjectBase64", verdict: "pass" });
    expect(body.items[0]!.attempts).toBeGreaterThan(0);
  }, 180_000);

  it("a refused key (401) also exits 0, and reads unknown, never pass", async () => {
    reply = "I cannot help with that.";
    const { outcomes, body } = await run(["encoding.injectbase64"], "rglv_refused");
    expect(outcomes[0]!.exitCode).toBe(0);
    expect(body.items[0]).toMatchObject({ verdict: "unknown", attempts: 0 });
    expect(body.status).toBe("failed");
  }, 180_000);

  it("every call carried the run's key or the refused one, the agent and the project headers, and the target model", () => {
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.agent === "a1" && s.project === "p1" && s.model === "agent-model")).toBe(true);
    expect(new Set(seen.map((s) => s.auth))).toEqual(new Set([`Bearer ${KEY}`, "Bearer rglv_refused"]));
  });
});
