/**
 * ADR-0190 slice I5, review LOW-4: the gateway holds at most ENGINE_TASK_OUTPUT_BUFFER_MAX_BYTES of unacknowledged
 * output per engine task AND at most ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES across every task it holds. Past either bound
 * the task is refused `output_overflow` (which, on the product path, ends its run not_run: MEDIUM-2). No database.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES } from "@regulait/shared";
import { EngineTask, engineTaskBufferedBytes, setEngineTaskOutputTotalCapForTest } from "./engine-tasks.js";
import { StdioSession } from "./executor-stdio.js";

const task = () => {
  const session = new StdioSession(randomUUID(), randomUUID(), { command: "/usr/local/bin/node", args: ["/app/dist/task-main.js"] });
  return { session, task: new EngineTask(randomUUID(), randomUUID(), randomUUID(), session.offerId, session, []) };
};
const line = (n: number) => JSON.stringify({ t: "end", code: 0, pad: "x".repeat(n) });

afterEach(() => setEngineTaskOutputTotalCapForTest(null));

describe("review LOW-4: a gateway-wide cap on held task output", () => {
  it("the shipped total cap is 512 MiB", () => {
    expect(ENGINE_TASK_OUTPUT_TOTAL_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it("past the total cap the next task's line is refused output_overflow; acknowledging and forgetting free the bytes", () => {
    const base = engineTaskBufferedBytes();
    setEngineTaskOutputTotalCapForTest(base + 4_000);
    const a = task();
    const b = task();
    a.session.onLine!(line(2_500));
    expect(a.task.refusal).toBeNull();
    const held = engineTaskBufferedBytes() - base;
    expect(held).toBeGreaterThan(2_500);
    // the second task alone is far under the per-task bound, but the process is at its cap
    b.session.onLine!(line(2_500));
    expect(b.task.refusal).toBe("output_overflow");
    expect(b.session.closed).toBe(true);
    expect(engineTaskBufferedBytes() - base).toBe(held);
    // the runner acknowledges a's frame: the bytes are free again
    expect(a.task.ack(1)).toBe(true);
    expect(engineTaskBufferedBytes()).toBe(base);
    const c = task();
    c.session.onLine!(line(2_500));
    expect(c.task.refusal).toBeNull();
    // a forgotten task's held output no longer counts, and nothing more is held for it
    c.task.release();
    expect(engineTaskBufferedBytes()).toBe(base);
    c.session.onLine!(line(10));
    expect(engineTaskBufferedBytes()).toBe(base);
  });
});
