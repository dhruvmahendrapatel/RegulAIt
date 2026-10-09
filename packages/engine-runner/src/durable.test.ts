/**
 * PR #205 review round 13 [96]: every persisted runner file is written durably — a temp file,
 * fsynced, renamed over the target, and the directory fsynced — so a crash at any point leaves the
 * old file or the new one, complete, never a truncated one.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { mkdtemp, open, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineLease } from "@regulait/shared";
import { writeFileDurable } from "./durable.js";
import { FileRunnerTokenStore } from "./loop.js";
import { RETAINED_RESULT_FILE, runOnce, RunnerClient, type RunnerHttp } from "./runner.js";

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

/** count fsyncs of files (fs.fsync, what write-file-atomic calls) and of directories (FileHandle.sync) */
async function spySyncs() {
  const counts = { file: 0, dir: 0 };
  const realFsync = fs.fsync;
  (fs as { fsync: typeof fs.fsync }).fsync = ((fd: number, cb: (e: NodeJS.ErrnoException | null) => void) => {
    counts.file++;
    return realFsync(fd, cb);
  }) as typeof fs.fsync;
  restore.push(() => ((fs as { fsync: typeof fs.fsync }).fsync = realFsync));
  const probe = await open(tmpdir(), "r");
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const realSync = proto.sync;
  proto.sync = function (this: unknown) {
    counts.dir++;
    return realSync.call(this);
  };
  restore.push(() => (proto.sync = realSync));
  return counts;
}

describe("PR #205 round 13 [96]: durable writes", () => {
  it("writeFileDurable fsyncs the file and its directory, writes 0600 and leaves no temp file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-"));
    const counts = await spySyncs();
    const file = path.join(dir, "state", "f.json");
    await writeFileDurable(file, "{\"a\":1}");
    expect(counts.file).toBeGreaterThanOrEqual(1);
    expect(counts.dir).toBeGreaterThanOrEqual(1);
    expect(await readFile(file, "utf8")).toBe("{\"a\":1}");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["f.json"]);
  });

  it("a crash before the rename leaves the previous token complete (never a truncated one)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-"));
    const store = new FileRunnerTokenStore(path.join(dir, "runner-token"));
    const first = `rge_${"1".repeat(64)}`;
    await store.save(first);
    const realRename = fs.rename;
    (fs as { rename: typeof fs.rename }).rename = ((_a: fs.PathLike, _b: fs.PathLike, cb: (e: NodeJS.ErrnoException | null) => void) =>
      cb(Object.assign(new Error("simulated crash"), { code: "EIO" }))) as typeof fs.rename;
    restore.push(() => ((fs as { rename: typeof fs.rename }).rename = realRename));
    await expect(store.save(`rge_${"2".repeat(64)}`)).rejects.toThrow(/simulated crash/);
    restore.pop()!();
    expect(await store.load()).toBe(first);
  });

  it("the token store and the pending record are written durably", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "durable-"));
    const store = new FileRunnerTokenStore(path.join(dir, "runner-token"));
    const counts = await spySyncs();
    await store.save(`rge_${"3".repeat(64)}`);
    await store.savePending({ secret: `rge_${"4".repeat(64)}`, supersedes: null });
    expect(counts.file).toBeGreaterThanOrEqual(2);
    expect(counts.dir).toBeGreaterThanOrEqual(2);
  });

  it("an undelivered result envelope is written durably", async () => {
    const lease: EngineLease = {
      runId: "33333333-3333-4333-8333-333333333333",
      engineId: "promptfoo",
      engineVersion: "0.123.1",
      spec: { config: { sets: ["basic"], params: {} }, trials: 3 },
      target: null,
      judge: null,
      artifacts: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      budgetUsd: null,
    };
    const http: RunnerHttp = async (url) => {
      const p = new URL(url).pathname;
      if (p.endsWith("/lease")) return { status: 200, json: async () => lease };
      if (p.endsWith("/heartbeat")) return { status: 200, json: async () => ({ cancel: false }) };
      throw new Error("ECONNRESET");
    };
    const client = new RunnerClient({ gatewayUrl: "http://gateway.test", http });
    client.useToken("rge_test");
    const work = await mkdtemp(path.join(tmpdir(), "durable-work-"));
    const retain = await mkdtemp(path.join(tmpdir(), "durable-retain-"));
    const counts = await spySyncs();
    const out = await runOnce(client, async () => ({ status: "completed" as const, items: [], notRun: [], rawReport: null }), {
      engineId: "promptfoo",
      engineVersion: "0.123.1",
      imageDigest: `sha256:${"a".repeat(64)}`,
      workRoot: work,
      retainRoot: retain,
      retryBaseMs: 1,
      maxResultAttempts: 1,
    });
    expect(out).toMatchObject({ outcome: "undelivered" });
    expect(counts.file).toBeGreaterThanOrEqual(1);
    expect(counts.dir).toBeGreaterThanOrEqual(1);
    expect(await readdir(path.join(retain, lease.runId))).toEqual([RETAINED_RESULT_FILE]);
  });
});
