/**
 * ADR-0187 B5-M (decision 104) — the SCANNER's own self-test, reported through the runner.
 *
 * The gateway can only read the runner's report, and the runner's egress probe runs in the runner's
 * container (on the internal `engines` network). The container that matters most here is the
 * scanner's: it parses hostile bytes and must have no network at all. So the scanner probes egress
 * from inside its own container (the same probe, name resolution, a TCP connect by name, and a
 * public literal address) and writes the outcome, with the modelscan version it runs, to
 * `results/.scanner-selftest.json`. The runner reads it when it builds its self-test and reports
 * the switch `REGULAIT_MODELSCAN_SCANNER_ISOLATED` (the manifest's one usage-data entry for this
 * engine) as true only when that report is fresh, names the pinned version, and shows nothing
 * reachable. A missing, stale or failing scanner report fails the self-test, so the engine cannot
 * be enabled (fail closed).
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { probeEgress, type EgressProbeOptions, type EgressProbeResult } from "@regulait/engine-runner";
import { isPublicAddress, MODELSCAN_ENGINE_VERSION } from "@regulait/shared";

export const SCANNER_SELF_TEST_FILE = ".scanner-selftest.json";
/** the manifest's usage-data entry the runner derives from the scanner's report */
export const SCANNER_ISOLATED_SWITCH = "REGULAIT_MODELSCAN_SCANNER_ISOLATED";
/** how old a scanner report may be (the scanner rewrites it every hour) */
export const SCANNER_SELF_TEST_MAX_AGE_MS = 2 * 3600 * 1000;

const reportSchema = z
  .object({
    at: z.string().datetime(),
    modelscanVersion: z.string().max(64),
    egress: z
      .object({
        host: z.string().max(253),
        dnsResolved: z.boolean(),
        connected: z.boolean(),
        address: z.string().max(45).nullable(),
        addressConnected: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ScannerSelfTest = z.infer<typeof reportSchema>;

/** the scanner writes its report (atomically) */
export async function writeScannerSelfTest(resultsRoot: string, args: { modelscanVersion: string; egress?: EgressProbeOptions; now?: Date }): Promise<ScannerSelfTest> {
  const egress: EgressProbeResult = await probeEgress(args.egress);
  const report: ScannerSelfTest = { at: (args.now ?? new Date()).toISOString(), modelscanVersion: args.modelscanVersion, egress };
  const file = path.join(resultsRoot, SCANNER_SELF_TEST_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(report), { mode: 0o640 });
  await rename(tmp, file);
  return report;
}

/** the runner's judgement of the scanner's report: every condition must hold, and each failure is named */
export async function judgeScannerSelfTest(resultsRoot: string, now = new Date()): Promise<{ isolated: boolean; failures: string[] }> {
  let report: ScannerSelfTest;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(await readFile(path.join(resultsRoot, SCANNER_SELF_TEST_FILE), "utf8")));
    if (!parsed.success) return { isolated: false, failures: ["scanner_report_invalid"] };
    report = parsed.data;
  } catch {
    return { isolated: false, failures: ["scanner_report_missing"] };
  }
  const failures: string[] = [];
  const age = now.getTime() - Date.parse(report.at);
  if (!(age >= -300_000 && age <= SCANNER_SELF_TEST_MAX_AGE_MS)) failures.push("scanner_report_stale");
  if (report.modelscanVersion !== MODELSCAN_ENGINE_VERSION) failures.push("scanner_version_mismatch");
  if (report.egress.dnsResolved) failures.push("scanner_dns_resolved");
  if (report.egress.connected) failures.push("scanner_connected");
  if (!isPublicAddress(report.egress.address)) failures.push("scanner_address_missing");
  else if (report.egress.addressConnected) failures.push("scanner_address_connected");
  return { isolated: failures.length === 0, failures };
}
