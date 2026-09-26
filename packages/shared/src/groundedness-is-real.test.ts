/**
 * INDEPENDENT adversarial check by the reviewing session, not the author.
 * The question is not "does it score" but "could a constant pass this".
 * Every assertion is a PAIR over the SAME context: a grounded answer must
 * score high AND a fabricated one must score low. A metric that returns a
 * plausible constant, or that cannot tell the two apart, fails here.
 *
 * The corpus is deliberately not the author's.
 */
import { describe, it, expect } from "vitest";
import { scoreClaimSupport, scoreContextPrecision, scoreAnswerRelevance } from "@regulait/shared";

// three chunks from an imaginary ops runbook
const CONTEXT = [
  "The nightly backup runs at 02:00 UTC and writes an encrypted dump to the archive bucket.",
  "Restoring a dump requires the data key fingerprint recorded at boot; the gateway refuses to start on a mismatch.",
  "Certificate rotation is automated and runs thirty days before expiry.",
];

const QUESTION = "When does the nightly backup run and what does restoring need?";

const GROUNDED =
  "The nightly backup runs at 02:00 UTC and writes an encrypted dump to the archive bucket. " +
  "Restoring a dump requires the data key fingerprint recorded at boot.";

// same shape, same register, same topic — but the facts are invented
const FABRICATED =
  "The nightly backup runs at 06:45 UTC and writes a compressed dump to the glacier tier. " +
  "Restoring a dump requires a quorum of three operator smartcards issued by the vault.";

describe("ADVERSARIAL: groundedness metrics actually discriminate", () => {
  it("claim_support separates a grounded answer from a fabricated one over the SAME context", () => {
    const good = scoreClaimSupport(GROUNDED, CONTEXT);
    const bad = scoreClaimSupport(FABRICATED, CONTEXT);
    expect(good.ratio).toBeGreaterThan(0.8);
    expect(bad.ratio).toBeLessThan(0.5);
    expect(good.ratio - bad.ratio).toBeGreaterThan(0.4);
  });

  it("names the actual unsupported claims — a number alone is not auditable", () => {
    const bad = scoreClaimSupport(FABRICATED, CONTEXT);
    const unsupported = JSON.stringify(bad);
    // the fabricated specifics must appear in what a reviewer reads
    expect(unsupported).toMatch(/06:45|smartcard|glacier/i);
  });

  it("context_precision is not a constant — padding the context lowers it", () => {
    const tight = scoreContextPrecision(GROUNDED, CONTEXT.slice(0, 2));
    const padded = scoreContextPrecision(GROUNDED, [
      ...CONTEXT,
      "The office coffee machine is descaled monthly.",
      "Parking permits renew each January.",
      "The fire drill is held every second Tuesday.",
    ]);
    expect(tight.score).toBeGreaterThan(padded.score);
  });

  it("answer_relevance separates an on-topic answer from an off-topic one", () => {
    const on = scoreAnswerRelevance(QUESTION, GROUNDED);
    const off = scoreAnswerRelevance(QUESTION, "Parking permits renew each January at the front desk.");
    expect(on.score).toBeGreaterThan(off.score);
    expect(on.score - off.score).toBeGreaterThan(0.3);
  });

  it("DOCUMENTED BLIND SPOT, pinned: a fluent falsehood still scores relevant", () => {
    // this is the metric behaving as designed, not a bug — relevance is not truth.
    // pinned so it cannot silently start being claimed as a hallucination check.
    const fluentLie = scoreAnswerRelevance(QUESTION, FABRICATED);
    expect(fluentLie.score).toBeGreaterThan(0.5);
  });
});
