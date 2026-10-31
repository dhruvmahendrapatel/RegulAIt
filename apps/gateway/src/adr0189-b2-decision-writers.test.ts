/**
 * ADR-0189 B2, round-10 entry condition 4237346656: fact and capture-status capture sit behind ONE shared,
 * transaction-aware audit writer, used by every `receiptClass: "decision"` writer, and B2 lists them all.
 *
 * The shared writer is `appendChainedAuditRows` (`packages/db/src/audit-chain.ts`), which every
 * `insert(auditLog)` on a `createDb` handle passes through and which calls `captureDecisionFacts`. Two
 * guards make a bypass fail:
 *  - at runtime, migration 0189 refuses to commit a receipt-eligible audit row with no capture-status
 *    marker (`zz-adr0189-b2-facts.test.ts` attacks it with a raw insert);
 *  - here, statically: the decision writers are exactly the listed modules, none writes `audit_log` with
 *    raw SQL, and no module outside `packages/db` builds its own database handle or pool.
 * A new decision writer fails this test until it is added to the list, which is the moment to check that it
 * goes through `insert(auditLog)` on a chained handle.
 */
import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewaySrc = here;
const dbSrc = path.resolve(here, "../../../packages/db/src");

/** every gateway module that writes a `receiptClass: "decision"` audit row (B2's list) */
const DECISION_WRITERS = [
  "agents-connectors.ts", // agent dispatch: lifecycle, PII, egress and fallback refusals
  "app.ts", // advisory evaluate callouts and builder approval resumes
  "approval-signatures.ts", // approval decisions (objectType approval)
  "builder-runtime.ts", // builder turns
  "compaction.ts",
  "compat-core.ts", // the compat model surfaces
  "compiled-egress.ts",
  "connection-egress.ts",
  "connector-call.ts", // connector invoke
  "decompose.ts", // orchestration lead entitlement
  "delegated-evaluate.ts", // ADR-0188 delegated dispatch
  "engine-runs.ts",
  "engine-tasks.ts", // ADR-0190 I5: an engine run's task start (its entitlement decision, with its engine_worker placement)
  "governed-evaluate.ts", // the `governance-policy-changed` refusal row of the MCP tool, MCP protocol and connector paths
  "guardrails.ts",
  "mcp-identity-assertion.ts", // ADR-0188 S8: an opted-in server's call refused because no identity assertion can be made
  "mcp-protocol.ts", // MCP protocol methods
  "mcp-proxy.ts", // MCP tool calls (governed-evaluate.ts decides; its callers write the decision row)
  "model-rate-limits.ts", // ADR-0212: a dispatch refused by a per-model rate limit (insert(auditLog) on the chained handle)
  "outbound-audience.ts",
  "playground.ts",
  "privacy-ops.ts", // ADR-0224: the processing limit's dispatch refusal
  "redteam.ts",
  "use-case-gate.ts",
  "use-cases.ts",
  "workbench.ts",
].sort();

/** every production .ts file under `dir`, RECURSIVELY (paths relative to `dir`); tests are not writers */
function sources(dir: string, rel = ""): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") out.push(...sources(dir, name));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push({ file: name, text: readFileSync(path.join(dir, name), "utf8") });
    }
  }
  return out;
}

/**
 * A `receiptClass` the scan cannot read: a computed value (`receiptClass: cls`), a shorthand
 * (`receiptClass,` / `{ receiptClass }`), or a computed key (`["receiptClass"]`). Each would let a
 * module become a decision writer without appearing in the list, so each is refused. The one SQL read
 * of the field (`detail->>'receiptClass'` in the receipt sweep) is not a writer.
 */
function unreadableReceiptClass(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/->>\s*'receiptClass'/.test(line)) continue;
    if (/\[\s*["'`]receiptClass["'`]\s*\]/.test(line)) out.push(line.trim());
    else if (/\breceiptClass\s*:/.test(line) && !/\breceiptClass\s*:\s*"(?:decision|configuration|excluded)"/.test(line)) out.push(line.trim());
    else if (/[{,]\s*receiptClass\s*[,}]/.test(line)) out.push(line.trim());
  }
  return out;
}

it("the decision writers are exactly the listed modules, found recursively", () => {
  const all = sources(gatewaySrc);
  expect(all.some((s) => s.file.includes("/")), "the scan reaches subdirectories").toBe(true);
  const found = all
    .filter((s) => /receiptClass:\s*"decision"/.test(s.text))
    .map((s) => s.file)
    .sort();
  expect(found).toEqual(DECISION_WRITERS);
});

it("every receiptClass in production code is a literal the scan can read", () => {
  const offenders = sources(gatewaySrc).flatMap((s) => unreadableReceiptClass(s.text).map((l) => `${s.file}: ${l}`));
  expect(offenders).toEqual([]);
  // NEGATIVE CONTROLS: the scan does flag each unreadable form, and passes the literal ones
  expect(unreadableReceiptClass('detail: { receiptClass: cls },')).toHaveLength(1);
  expect(unreadableReceiptClass('detail: { phase, receiptClass },')).toHaveLength(1);
  expect(unreadableReceiptClass('detail["receiptClass"] = "decision";')).toHaveLength(1);
  expect(unreadableReceiptClass('detail: { receiptClass: "decision" },')).toEqual([]);
  expect(unreadableReceiptClass("sql`${auditLog.detail}->>'receiptClass' = 'decision'`")).toEqual([]);
});

it("no production module writes audit_log with raw SQL or builds a handle that skips the shared writer", () => {
  const offenders: string[] = [];
  for (const s of [...sources(gatewaySrc), ...sources(dbSrc).map((x) => ({ ...x, file: `db/${x.file}` }))]) {
    if (/insert\s+into\s+"?audit_log"?/i.test(s.text)) offenders.push(`${s.file}: raw insert into audit_log`);
    // a drizzle handle or pg pool built anywhere but createDb / the BOM session lock would not chain or capture
    const builds = /\bdrizzle\(|new\s+pg\.Pool\(|new\s+Pool\(/.test(s.text);
    if (builds && s.file !== "db/index.ts" && s.file !== "db/bom-session-lock.ts") offenders.push(`${s.file}: builds its own database handle`);
  }
  expect(offenders).toEqual([]);
});

it("the shared writer calls the fact capture in the chained append, and the two handle builders wrap with it", () => {
  const chain = readFileSync(path.join(dbSrc, "audit-chain.ts"), "utf8");
  expect(chain).toMatch(/await captureDecisionFacts\(tx as never, rows\);/);
  expect(readFileSync(path.join(dbSrc, "index.ts"), "utf8")).toMatch(/withAuditChain\(drizzle\(pool/);
  expect(readFileSync(path.join(dbSrc, "bom-session-lock.ts"), "utf8")).toMatch(/withAuditChain\(drizzle\(client/);
});
