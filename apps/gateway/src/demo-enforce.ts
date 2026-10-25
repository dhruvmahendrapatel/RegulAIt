/**
 * `pnpm --filter @regulait/gateway demo:enforce`
 *
 * The "Enforce it" beat (ADR-0202 lane F; see demo-enforce-lib.ts). Live by default: Dana's real governed calls go
 * through the running gateway's MCP route, the deny is audited, the write is queued for Avery and mirrored to every
 * enabled ChatOps channel, and it executes only once approved. On the beat's fallback (lane L's switch, read from its
 * `GET /v1/demo/beats` with the bootstrap token) it prints the simulated decision instead. It refuses to run against a
 * gateway that does not show it is a demo one (demo-beat-switch.ts). Exits 0 when the beat ran as scripted, 1 when
 * something answered differently, 2 on a setup error or a refusal.
 *
 * Environment: REGULAIT_DEMO_ENFORCE_URL (default http://127.0.0.1:3000), REGULAIT_BOOTSTRAP_TOKEN, and optionally
 * REGULAIT_DEMO_ENFORCE_WAIT_SECONDS (default 300).
 */
import { type DemoBeatsProbe, ENFORCE_IT_BEAT_ID, demoTargetRefusal, readDemoBeat } from "./demo-beat-switch.js";
import { ENFORCE_DEFAULTS, runEnforceBeat } from "./demo-enforce-lib.js";

const bootstrapToken = process.env.REGULAIT_BOOTSTRAP_TOKEN;
if (!bootstrapToken) {
  console.error("demo:enforce: REGULAIT_BOOTSTRAP_TOKEN is not set");
  process.exit(2);
}
const baseUrl = process.env.REGULAIT_DEMO_ENFORCE_URL ?? "http://127.0.0.1:3000";
// read once per run: the switch is flipped only between runs, and the guard and the switch must see the same answer
let probe: Promise<DemoBeatsProbe> | undefined;
const readSwitch = () => (probe ??= readDemoBeat(baseUrl, bootstrapToken, ENFORCE_IT_BEAT_ID));
const waitSeconds = Number(process.env.REGULAIT_DEMO_ENFORCE_WAIT_SECONDS ?? ENFORCE_DEFAULTS.waitMs / 1000);
const result = await runEnforceBeat({
  baseUrl,
  bootstrapToken,
  verifyTarget: async (userEmails) => demoTargetRefusal(await readSwitch(), userEmails),
  isSimulated: async () => (await readSwitch()).simulated,
  waitMs: Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1000 : ENFORCE_DEFAULTS.waitMs,
  log: (line) => console.log(line),
});
process.exit(result.exitCode);
