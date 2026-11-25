/** ADR-0364 S3 review (N-B): the runner resends an evidence chunk on 503 `evidence_busy`, bounded; any other error fails */
import { describe, expect, it } from "vitest";
import { RobotChannelError, RobotGatewayClient } from "./channel.js";

const RUN = "00000000-0000-4000-8000-000000000001";
const CHUNK = { item: 0, kind: "screenshot", step: 0, contentType: "image/jpeg", chunk: 0, last: true, sha256: "a".repeat(64), size: 1, dataBase64: "AA==" } as const;

function client(answers: Array<() => Response>) {
  const sent: string[] = [];
  let t = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body));
    return answers.shift()!();
  }) as unknown as typeof fetch;
  const c = new RobotGatewayClient("http://127.0.0.1:4000", RUN, fetchImpl, async (ms) => {
    t += ms;
  }, () => t);
  return { c, sent, elapsed: () => t };
}
const busy = (ms = 250) => () => new Response(JSON.stringify({ error: "evidence_busy", retryAfterMs: ms }), { status: 503 });

describe("evidence backpressure", () => {
  it("resends the same chunk after evidence_busy, then succeeds", async () => {
    const { c, sent, elapsed } = client([busy(), busy(), () => new Response(null, { status: 204 })]);
    await c.evidence(CHUNK);
    expect(sent.length).toBe(3);
    expect(new Set(sent).size).toBe(1);
    expect(elapsed()).toBe(500);
  });
  it("gives up when the gateway stays busy, and a 503 that is not evidence_busy fails at once", async () => {
    const stuck = client(Array.from({ length: 400 }, () => busy(2_000)));
    await expect(stuck.c.evidence(CHUNK)).rejects.toThrow(/stayed busy/);
    const other = client([() => new Response(JSON.stringify({ error: "nope" }), { status: 503 })]);
    await expect(other.c.evidence(CHUNK)).rejects.toBeInstanceOf(RobotChannelError);
    expect(other.sent.length).toBe(1);
  });
});
