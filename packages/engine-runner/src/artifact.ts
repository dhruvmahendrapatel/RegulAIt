/**
 * ADR-0187 B5-M — fetch a run's model artifact from the gateway
 * (`GET /v1/engine-runner/artifacts/:artifactId`, the runner's self token) into a file, streaming, with every
 * guarantee checked here rather than trusted:
 *   - the bytes written never exceed the size the lease named (a longer body is cut off and refused);
 *   - the sha256 of what was written must equal the lease's, and the length its size;
 *   - the file is created exclusively (0600) and removed on any failure;
 *   - the request is bounded by the run's deadline (and the abort signal).
 * Any failure throws `ArtifactFetchError`; the adapter reports the run `failed`, never clean.
 *
 * A separate module: the request itself is the runner client's (`RunnerClient.artifact`, ADR-0188 S7:
 * its DPoP-bound self token, never a bearer value), handed in by the caller. Stdlib only here.
 */
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";

export class ArtifactFetchError extends Error {
  constructor(
    readonly code: "artifact_http" | "artifact_too_long" | "artifact_short" | "artifact_sha256_mismatch" | "artifact_timeout" | "artifact_no_credential" | "artifact_aborted",
    message: string,
  ) {
    super(message);
  }
}

/** who fetches the artifact: the runner client (`RunnerClient` has this method), or a test's stand-in */
export interface ArtifactSource {
  artifact(artifactId: string, signal: AbortSignal): Promise<Response>;
}

export interface ArtifactFetchOptions {
  /** ADR-0188 S7: the runner client (its self token), or null when the runner holds no key */
  source: ArtifactSource | null;
  artifact: { id: string; sha256: string; size: number };
  destPath: string;
  deadlineAt: string;
  signal?: AbortSignal;
}

export async function downloadArtifact(opts: ArtifactFetchOptions): Promise<{ bytes: number; sha256: string }> {
  if (!opts.source) throw new ArtifactFetchError("artifact_no_credential", "the runner holds no key to fetch the artifact with");
  // PR #212 review [4234946096]: a signal that is ALREADY aborted never fires its event, so it is
  // checked here: nothing is opened and nothing is fetched
  if (opts.signal?.aborted) throw new ArtifactFetchError("artifact_aborted", "the run was cancelled before the artifact was fetched");
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const remaining = Math.max(1, Date.parse(opts.deadlineAt) - Date.now());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, remaining);
  const source = opts.source;
  const fh = await open(opts.destPath, "wx", 0o600);
  let ok = false;
  try {
    let res: Response;
    try {
      res = await source.artifact(opts.artifact.id, abort.signal);
    } catch (e) {
      if (timedOut) throw new ArtifactFetchError("artifact_timeout", "the artifact did not arrive before the run's deadline");
      throw e;
    }
    if (res.status !== 200 || !res.body) throw new ArtifactFetchError("artifact_http", `the gateway answered ${res.status} for the artifact`);
    const hash = createHash("sha256");
    let written = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (written + value.length > opts.artifact.size) {
          throw new ArtifactFetchError("artifact_too_long", "the gateway sent more bytes than the lease named");
        }
        hash.update(value);
        await fh.write(value);
        written += value.length;
      }
    } catch (e) {
      if (timedOut) throw new ArtifactFetchError("artifact_timeout", "the artifact did not arrive before the run's deadline");
      throw e;
    } finally {
      reader.releaseLock();
    }
    if (written !== opts.artifact.size) throw new ArtifactFetchError("artifact_short", `the artifact was ${written} bytes, the lease named ${opts.artifact.size}`);
    const sha256 = hash.digest("hex");
    if (sha256 !== opts.artifact.sha256) throw new ArtifactFetchError("artifact_sha256_mismatch", "the artifact's sha256 is not the one the lease named");
    await fh.sync();
    ok = true;
    return { bytes: written, sha256 };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    await fh.close();
    if (!ok) await rm(opts.destPath, { force: true });
  }
}
