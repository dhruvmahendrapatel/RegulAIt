/**
 * The gateway suite's config with ONE change: the files named in
 * `REGULAIT_VITEST_LAST` (comma-separated basenames) run after every other
 * file in the run, in the order given.
 *
 * WHY. Every file shares one database (vitest.config.ts, `fileParallelism:
 * false`), and vitest's default order is not fixed: with no results cache it
 * runs larger files first, with one it runs failed-then-slower files first. A
 * file that creates shared state (an egress allow entry, an org setting, a
 * fleet-wide rule) and does not remove it is therefore masked in SOME orders
 * and exposed in others — the way setup-status.test.ts's leftover
 * `127.0.0.1` allow entry let 15 unrelated suites pass whenever it happened
 * to run first (M-068). The proof that nothing inherits a file's state is to
 * run that file LAST on a fresh database:
 *
 *   REGULAIT_VITEST_LAST=setup-status.test.ts \
 *     pnpm exec vitest run --dir src --config vitest.run-last.config.ts
 *
 * Everything else — timeouts, setup files, the env — is the base config.
 */
import { defineConfig, mergeConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import base from "./vitest.config.ts";

const LAST = (process.env.REGULAIT_VITEST_LAST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

class RunNamedFilesLast extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const rank = (f: TestSpecification) => LAST.findIndex((name) => f.moduleId.endsWith(`/${name}`));
    const rest = sorted.filter((f) => rank(f) === -1);
    const last = sorted.filter((f) => rank(f) !== -1).sort((a, b) => rank(a) - rank(b));
    return [...rest, ...last];
  }
}

export default mergeConfig(base, defineConfig({ test: { sequence: { sequencer: RunNamedFilesLast } } }));
