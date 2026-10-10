/**
 * ADR-0190 I3 — the executor key file: created 0600 in a 0700 directory,
 * loaded back as the same key, and refused when another user could read it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExecutorKey, loadOrCreateExecutorKey } from "./keys.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the executor key file", () => {
  it("is generated once, 0600 in a 0700 directory, and loads back as the same key", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "exec-key-"));
    dirs.push(root);
    const file = path.join(root, "state", "executor.pem");
    const first = await loadOrCreateExecutorKey(file);
    expect(first.created).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const second = await loadOrCreateExecutorKey(file);
    expect(second.created).toBe(false);
    expect(second.key.thumbprint).toBe(first.key.thumbprint);
    expect(second.key.publicJwk).toEqual(first.key.publicJwk);
  });

  it("refuses a key file readable by others (fail closed)", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "exec-key-"));
    dirs.push(root);
    const file = path.join(root, "executor.pem");
    await loadOrCreateExecutorKey(file);
    chmodSync(file, 0o644);
    await expect(loadExecutorKey(file)).rejects.toThrow(/mode 0600/);
  });

  it("is null when absent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "exec-key-"));
    dirs.push(root);
    expect(await loadExecutorKey(path.join(root, "none.pem"))).toBeNull();
  });
});
