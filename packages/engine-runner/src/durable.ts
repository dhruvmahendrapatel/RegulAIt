/**
 * PR #205 review round 13 [96]: THE durable write every persisted runner file goes through (the
 * runner token, the pending enrolment record, a retained result envelope). A crash or power loss at
 * any point leaves either the old file or the new one, complete — never a truncated one.
 *
 * Open-source check (ADR-0176): `write-file-atomic` (npm's own, ISC) writes a temp file beside the
 * target, fsyncs it, sets its mode and renames it over the target. It does not fsync the containing
 * directory, so the rename itself could be lost on a power cut; that one step is added here. Nothing
 * else is hand-written.
 */
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import writeFileAtomic from "write-file-atomic";

/** fsync a directory, so a rename or unlink inside it survives a power cut */
export async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch (e) {
    // a filesystem that cannot sync a directory (some network and overlay mounts) offers no stronger
    // guarantee to ask for; the file itself was already fsynced
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw e;
  } finally {
    await handle.close();
  }
}

/** write `file` durably (temp file, fsync, rename, fsync the directory), 0600 in a 0700 directory */
export async function writeFileDurable(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, content, { mode: 0o600, fsync: true });
  await fsyncDir(dir);
}

/** remove `file` durably (the unlink is fsynced with its directory) */
export async function removeFileDurable(file: string): Promise<void> {
  await rm(file, { force: true });
  await fsyncDir(path.dirname(file)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
