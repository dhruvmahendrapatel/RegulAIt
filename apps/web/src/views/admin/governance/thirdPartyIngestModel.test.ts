import { describe, expect, it } from "vitest";
import { eventLabel, limitLines, setupNote, spanWords } from "./thirdPartyIngestModel";

describe("third-party ingest model", () => {
  it("states a span in its largest whole unit", () => {
    expect(spanWords(86_400)).toBe("1 day");
    expect(spanWords(7_200)).toBe("2 hours");
    expect(spanWords(300)).toBe("5 minutes");
    expect(spanWords(90)).toBe("90 seconds");
  });

  it("states the ingest limits as sentences", () => {
    expect(
      limitLines({ maxBodyBytes: 1_048_576, maxRecordsPerRequest: 512, maxRecordsPerHour: 100_000, maxAgeSeconds: 900, maxFutureSeconds: 300, schemaFamily: "v8" }),
    ).toEqual([
      "At most 1.0 MB and 512 records per request.",
      `At most ${(100_000).toLocaleString()} records per hour from each source.`,
      "A record older than 15 minutes, or more than 5 minutes in the future, is rejected.",
    ]);
  });

  it("says how to set the token up, with the body bound in bytes, and never repeats the token", () => {
    const note = setupNote({ token: "rgti_x", header: "Authorization: Bearer <token>", path: "/v1/third-party-ingest/defenseclaw/records" }, 1_048_576);
    expect(note).toContain('"Authorization: Bearer <token>" to /v1/third-party-ingest/defenseclaw/records');
    expect(note).toContain("batch.max_export_batch_bytes at 1,048,576 or less");
    expect(note).toContain("turn redaction on");
    expect(note).not.toContain("rgti_x");
  });

  it("states an event as words, falling back to the bucket", () => {
    expect(eventLabel({ eventName: "hook.decision", bucket: "enforcement.action" })).toBe("Hook decision");
    expect(eventLabel({ eventName: null, bucket: "security.finding" })).toBe("Security finding");
  });
});
