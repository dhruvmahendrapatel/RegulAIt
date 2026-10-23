/**
 * The ordered steps of `demo:prepare` (demo task C16), in ONE place. Two runners read this list:
 *
 *  - `demo-prepare.ts`, the native command (`pnpm --filter @regulait/gateway demo:prepare [--live]`);
 *  - the image's start script (apps/gateway/docker-start.sh) in Docker demo mode (REGULAIT_DEMO_LICENSE=1), which
 *    asks `node dist/demo-prepare.js --steps` for the demo list and runs each line itself, so the Docker demo is
 *    prepared in exactly the native order (demo-readiness scan finding #1) and a step added here reaches both.
 *
 * Side-effect free: no process, no database, no environment read.
 */

export interface DemoPrepareStep {
  /** the name a log line and a failure message carry */
  name: string;
  /** the built script under apps/gateway/dist */
  file: string;
  /** its arguments; none contains whitespace, because the start script splits them on spaces */
  args: string[];
}

/**
 * ADR-0197 decision 7: the Shadow-AI discovery dataset runs twice. Its first phase comes BEFORE the seed, in
 * first-admin setup, because enabling a discovery source is a step-up the bootstrap credential gives only until an
 * admin can step up (B4S-06); its second phase, after demo:intake, acts as the personas. Without it (`--live`) the
 * seed is the first step, so its own first-admin-setup acts (the personas' one-time passwords, both admins' TOTP)
 * still run inside that window.
 *
 * ADR-0181 FX3: the seed runs only on an explicit demo signal; this command IS the demo, so it says so. B4S-06: and
 * the seed opens the assurance run's guardrail window during first-admin setup (see seed.ts), which demo:intake
 * keeps and closes.
 */
export function demoPrepareSteps(live: boolean): DemoPrepareStep[] {
  const seed: DemoPrepareStep = { name: "seed", file: "seed.js", args: ["--seed-demo", "--open-assurance-window"] };
  return live
    ? [
        seed,
        { name: "demo:setup", file: "demo-setup.js", args: [] },
        { name: "demo:intake --live", file: "demo-intake-seed.js", args: ["--live"] },
        { name: "demo:traffic", file: "demo-traffic.js", args: [] },
        { name: "demo:check --live", file: "demo-check.js", args: ["--live"] },
      ]
    : [
        { name: "demo:shadow (first-admin setup)", file: "demo-shadow-seed.js", args: ["--setup"] },
        seed,
        { name: "demo:setup", file: "demo-setup.js", args: [] },
        { name: "demo:intake", file: "demo-intake-seed.js", args: [] },
        { name: "demo:shadow", file: "demo-shadow-seed.js", args: [] },
        { name: "demo:traffic", file: "demo-traffic.js", args: [] },
        { name: "demo:check", file: "demo-check.js", args: [] },
      ];
}

/**
 * `demo-prepare.js --steps`: one line per step, `<name> TAB <file> TAB <args joined by spaces>`, for the start
 * script's `while IFS=<tab> read -r name file args` loop. Only the demo list is ever printed this way: the Docker
 * path never prepares a live database.
 */
export function formatDemoPrepareSteps(steps: DemoPrepareStep[]): string {
  return steps.map((s) => `${s.name}\t${s.file}\t${s.args.join(" ")}`).join("\n");
}
