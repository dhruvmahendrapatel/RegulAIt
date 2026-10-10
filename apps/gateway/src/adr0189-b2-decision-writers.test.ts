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
  "guardrails.ts",
  "mcp-protocol.ts", // MCP protocol methods
  "mcp-proxy.ts", // MCP tool calls (governed-evaluate.ts decides; its callers write the row)
  "outbound-audience.ts",
  "playground.ts",
  "redteam.ts",
  "use-case-gate.ts",
  "use-cases.ts",
  "workbench.ts",
].sort();

const sources = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));

it("the decision writers are exactly the listed modules", () => {
  const found = sources(gatewaySrc)
    .filter((s) => /receiptClass:\s*"decision"/.test(s.text))
    .map((s) => s.file)
    .sort();
  expect(found).toEqual(DECISION_WRITERS);
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
