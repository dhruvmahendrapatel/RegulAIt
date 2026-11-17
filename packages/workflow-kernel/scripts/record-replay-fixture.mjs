#!/usr/bin/env node
/**
 * ADR-0349 slice 1: record a NEW replay fixture from a scenario file.
 *
 *   pnpm --filter @regulait/workflow-kernel build
 *   node packages/workflow-kernel/scripts/record-replay-fixture.mjs <scenario.json>
 *
 * The scenario is `{ "name", "note", "definition", "events" }`, the events in the exact shape the gateway stores in
 * `workflow_events.event`. The definition is validated (and stored with its defaults applied, as an instance's
 * snapshot is), the events are replayed through the built kernel, and the result is written to
 * `replay-fixtures/<name>.json` for review. An existing fixture is never overwritten: a fixture records what an
 * in-flight instance did, and re-recording one to make CI pass would hide exactly the change the check exists to
 * catch (ADR-0349 decision 1).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = await import(path.join(here, "..", "dist", "index.js"));
const file = process.argv[2];
if (!file) {
  console.error("usage: record-replay-fixture.mjs <scenario.json>");
  process.exit(2);
}
const scenario = JSON.parse(readFileSync(file, "utf8"));
if (typeof scenario.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.name) || scenario.name.length > 80) {
  console.error("name must be lower-case words joined by hyphens (at most 80 characters)");
  process.exit(2);
}
if (typeof scenario.note !== "string" || scenario.note.length === 0) {
  console.error("note must say what the history records");
  process.exit(2);
}
const out = path.join(here, "..", "replay-fixtures", `${scenario.name}.json`);
if (existsSync(out)) {
  console.error(`${out} exists: a recorded fixture is never re-recorded (ADR-0349 decision 1)`);
  process.exit(1);
}
const definition = kernel.validateDefinition(scenario.definition);
// what today's kernel makes of the events, event by event; the kernel's refusal stops the recording
const statuses = [];
let state = kernel.initialState(definition);
for (const [i, event] of scenario.events.entries()) {
  try {
    state = kernel.transition(definition, state, event).state;
  } catch (err) {
    console.error(`the kernel refuses event ${i} (${event.kind}): ${err instanceof Error ? err.message : "refused"}`);
    process.exit(1);
  }
  statuses.push(state.status);
}
// and the fixture must replay under the one replayer the CI check uses (ADR-0342 replayHistory)
const history = scenario.events.map((event, i) => ({ event, at: new Date(Date.UTC(2026, 0, 1) + i * 1000) }));
const replayed = kernel.replayHistory(definition, history, state);
if (replayed.status !== "ok") {
  console.error(`replayHistory does not reproduce the recording: ${replayed.status}`);
  process.exit(1);
}
const result = { state, statuses };
const fixture = {
  fixture: 1,
  name: scenario.name,
  note: scenario.note,
  definition,
  events: scenario.events,
  expected: { state: result.state, statuses: result.statuses },
};
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`recorded ${out}: ${result.state.status} at stage ${result.state.currentStageIndex}`);
