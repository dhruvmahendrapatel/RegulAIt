/**
 * ADR-0187 B5-M — `downloadArtifact`: an already-aborted signal fetches nothing (PR #212 review
 * [4234946096]); a body over the lease's size, short, or with another sha256 is refused and removed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactFetchError, downloadArtifact } from "./artifact.js";

const bytes = Buffer.from("model bytes");
const artifact = { id: "a1", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
const deadlineAt = () => new Date(Date.now() + 60_000).toISOString();

describe("downloadArtifact", () => {
  it("PR #212 review [4234946096]: an already-aborted signal makes no request and writes no file", async () => {
    const dest = path.join(await mkdtemp(path.join(tmpdir(), "art-")), "a.bin");
    let fetched = 0;
    const aborted = new AbortController();
    aborted.abort();
    const err = await downloadArtifact({
      gatewayUrl: "http://g",
      token: "rge_x",
      artifact,
      destPath: dest,
      deadlineAt: deadlineAt(),
      signal: aborted.signal,
      fetch: async () => {
        fetched += 1;
        return new Response(new Uint8Array(bytes), { status: 200 });
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactFetchError);
    expect((err as ArtifactFetchError).code).toBe("artifact_aborted");
    expect(fetched).toBe(0);
    expect(existsSync(dest)).toBe(false);
  });

  it("writes exactly the named bytes; a tampered or longer body is refused and removed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "art-"));
    const ok = await downloadArtifact({ gatewayUrl: "http://g", token: "rge_x", artifact, destPath: path.join(dir, "ok"), deadlineAt: deadlineAt(), fetch: async () => new Response(new Uint8Array(bytes)) });
    expect(ok).toEqual({ bytes: bytes.length, sha256: artifact.sha256 });
    const tampered = Buffer.from(bytes);
    tampered[0] = tampered[0]! ^ 1;
    for (const [name, body] of [["tampered", tampered], ["longer", Buffer.concat([bytes, Buffer.from("x")])]] as const) {
      const e = await downloadArtifact({ gatewayUrl: "http://g", token: "rge_x", artifact, destPath: path.join(dir, name), deadlineAt: deadlineAt(), fetch: async () => new Response(new Uint8Array(body)) }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ArtifactFetchError);
      expect(existsSync(path.join(dir, name))).toBe(false);
    }
  });
});
