/**
 * ADR-0190 slice I5 — AN ENGINE TASK'S READ-ONLY INPUT, executor side.
 *
 * The executor fetches the task's input manifest and each file from the gateway (`GET …/offers/:id/input[/:n]`)
 * after accepting the offer and before starting the sandbox, writes them into a directory IT owns, and the backend
 * mounts that directory read-only at the profile's input path. Every file is checked while it is written: its size
 * may not exceed the manifest's, and at its end its size and SHA-256 must be the manifest's (a mismatch removes
 * everything and refuses the placement: nothing starts on other bytes). The digest the per-placement report names is
 * computed from what was WRITTEN (`engineTaskInputDigest`), so the gateway's check covers the bytes the sandbox sees.
 *
 * Node standard library only. Paths come from the shared manifest schema (relative, at most four plain segments, no
 * `.` or `..`) and are checked again to stay under the task's directory.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { engineTaskInputDigest, engineTaskInputManifestSchema, type EngineTaskInputFile, type EngineTaskInputManifest } from "@regulait/shared";

/** what the offer handler hands the backend: the manifest and a way to read each file's bytes */
export interface SandboxTaskInput {
  manifest: EngineTaskInputManifest;
  open(n: number): Promise<AsyncIterable<Uint8Array>>;
}

export class TaskInputError extends Error {}

/** write the input under `root` (created fresh), verified file by file; returns the digest of what was written */
export async function writeTaskInput(root: string, input: SandboxTaskInput): Promise<string> {
  const parsed = engineTaskInputManifestSchema.safeParse(input.manifest);
  if (!parsed.success) throw new TaskInputError("the task's input manifest is not valid");
  const manifest = parsed.data;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o755 });
  const written: EngineTaskInputFile[] = [];
  try {
    for (const [n, f] of manifest.files.entries()) {
      const target = path.resolve(root, f.path);
      const rel = path.relative(root, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new TaskInputError(`input path ${f.path} leaves the input directory`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      const fh = await open(target, "wx", 0o600);
      const h = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of await input.open(n)) {
          size += chunk.length;
          if (size > f.size) throw new TaskInputError(`input ${f.path} is longer than its manifest says`);
          // review LOW-2: the digest covers the bytes the file actually holds (a short write is continued, never assumed)
          let off = 0;
          while (off < chunk.length) {
            const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
            if (bytesWritten <= 0) throw new TaskInputError(`input ${f.path} could not be written`);
            h.update(chunk.subarray(off, off + bytesWritten));
            off += bytesWritten;
          }
        }
        await fh.sync();
      } finally {
        await fh.close();
      }
      const sha256 = h.digest("hex");
      if (size !== f.size || sha256 !== f.sha256) throw new TaskInputError(`input ${f.path} is not the file its manifest names`);
      await chmod(target, 0o444);
      written.push({ path: f.path, size, sha256 });
    }
    await lockDirs(root);
  } catch (e) {
    await removeTaskInput(root);
    throw e;
  }
  return engineTaskInputDigest(written);
}

/** every directory read-only too (0555): nothing under the input can be added or removed from inside */
async function lockDirs(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await lockDirs(path.join(dir, e.name));
  await chmod(dir, 0o555);
}

/**
 * Review LOW-2: at executor start, remove every task input a previous run of this executor left under its input
 * directory (a crash between the write and the sandbox's end). Only the entries `isOurs` names are touched; returns
 * how many were removed.
 */
export async function reconcileTaskInputs(dir: string, isOurs: (name: string) => boolean): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !isOurs(e.name)) continue;
    await removeTaskInput(path.join(dir, e.name));
    n += 1;
  }
  return n;
}

/** remove a task's input (its directories are read-only, so they are opened up first) */
export async function removeTaskInput(root: string): Promise<void> {
  const open_ = async (dir: string): Promise<void> => {
    try {
      const st = await lstat(dir);
      if (!st.isDirectory()) return;
      await chmod(dir, 0o755);
      for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await open_(path.join(dir, e.name));
    } catch {
      // already gone
    }
  };
  await open_(root);
  await rm(root, { recursive: true, force: true });
}
