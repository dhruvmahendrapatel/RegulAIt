/** ADR-0364 S3 — the robot runner image's entry point: one run, then exit (the sandbox is destroyed after it). */
import { runRobot } from "./run.js";

const code = await runRobot({ env: process.env, stdout: process.stdout, stdin: process.stdin });
process.exit(code);
