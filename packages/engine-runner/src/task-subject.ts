/**
 * ADR-0242 L4.3 / §6.1 — a SUBJECT task (an admission scan) on the task bridge, the names both sides agree on.
 *
 * A subject run's only input is the file the GATEWAY builds from its own records (`tools.json` or `SKILL.md`) and
 * places at the input root (the #843 security review: the runner adds no files and names the root path only). So:
 *
 *  - runner side: the run's job directory holds exactly one file, `subject.json` (`{"path": "<root name>"}`), which
 *    the bridge turns into a task input with no files, no artifact, no secret and `subject: {path}`;
 *  - sandbox side: the input root holds exactly that one file and no run directory, so the task cannot know its run
 *    id. It writes its results under the fixed directory `subject/` instead, and the bridge (which knows the run)
 *    writes those frames under `<runId>/` in its results directory, exactly where the exchange expects them.
 *
 * Nothing here reads or writes a file; both sides import it (it never reaches a process spawn).
 */
import { isEngineTaskPath } from "@regulait/shared";

/** the runner's marker in a subject run's job directory (its only entry) */
export const SUBJECT_JOB_FILE = "subject.json";
/** the results directory a subject task writes under (the bridge maps it to the run's own) */
export const SUBJECT_TASK_RUN_DIR = "subject";

/** a subject file's place: one plain segment at the input root (never nested, never `subject.json` itself) */
export function isSubjectRootName(name: unknown): name is string {
  return typeof name === "string" && isEngineTaskPath(name) && !name.includes("/") && name !== SUBJECT_JOB_FILE;
}

/** the marker's content for one subject file (the bridge parses it back with `parseSubjectJob`) */
export function subjectJobJson(file: string): string {
  if (!isSubjectRootName(file)) throw new TypeError("a subject file is one plain name at the input root");
  return JSON.stringify({ path: file });
}

/** the marker parsed strictly, or null */
export function parseSubjectJob(text: string): { path: string } | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const keys = Object.keys(j);
  const p = (j as { path?: unknown }).path;
  return keys.length === 1 && keys[0] === "path" && isSubjectRootName(p) ? { path: p } : null;
}
