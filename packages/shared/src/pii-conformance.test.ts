import { describe, expect, it } from "vitest";
import { detectPII, type PiiCategory } from "./pii.js";
import {
  ALL_INTERNATIONAL_CATEGORIES,
  DEFAULT_INTERNATIONAL_CATEGORIES,
  INTERNATIONAL_DETECTORS,
} from "./pii-international.js";
import {
  DOCUMENTED_MISSES,
  NEGATIVE_VECTORS,
  PII_VECTOR_SET_VERSION,
  POSITIVE_VECTORS,
  REALISTIC_CORPUS_RATES,
  type PiiVector,
} from "./pii-vectors.js";

/**
 * ADR-0117 — THE MEASURED PII CONFORMANCE CONTRACT.
 *
 * METHOD, stated so the number can be reproduced and argued with:
 *
 *  1. every vector in `pii-vectors.ts` is embedded in a CARRIER string
 *     alongside a PROBE identifier of an unrelated category;
 *  2. `detectPII` is run over the carrier with EVERY category enabled;
 *  3. a POSITIVE passes when its own category is counted at least once;
 *  4. a NEGATIVE passes when its own category is counted exactly ZERO times
 *     AND the probe is counted exactly once. The probe assertion is not
 *     decoration — M-033: `count === 0` is satisfied by a detector that never
 *     ran at all, by an empty carrier, or by a typo in the vector text. The
 *     probe proves the detector ran over THIS string with THIS configuration.
 *  5. the score is pinned below. It may only move with a deliberate edit, and
 *     the vectors may not be tuned to improve it: `DOCUMENTED_MISSES` records
 *     what is NOT detected and is asserted just as hard.
 *
 * Date of measurement and the suite/build numbers are in ADR-0117.
 */

const EMAIL_PROBE = "conformance.probe@regulait.invalid";
const SSN_PROBE = "123-45-6789";

/** The probe for a vector: always a DIFFERENT category from the one under
 * test, so the probe can never itself satisfy or mask the assertion. */
function probeFor(v: PiiVector): { text: string; category: PiiCategory } {
  return v.category === "email"
    ? { text: SSN_PROBE, category: "ssn" }
    : { text: EMAIL_PROBE, category: "email" };
}

function carrierFor(v: PiiVector): string {
  return `case ${v.id} probe ${probeFor(v).text} value ${v.text} end`;
}

function countOf(text: string, category: PiiCategory): number {
  const hits = detectPII(text, ALL_INTERNATIONAL_CATEGORIES);
  return hits.find((h) => h.category === category)?.count ?? 0;
}

/** Runs one vector and reports both halves: did its own category fire, and did
 * the probe fire (i.e. was the detector actually exercised on this input). */
function measure(v: PiiVector): { fired: number; probeFired: number } {
  const carrier = carrierFor(v);
  const probe = probeFor(v);
  return { fired: countOf(carrier, v.category), probeFired: countOf(carrier, probe.category) };
}

describe(`ADR-0117 PII conformance — vector set ${PII_VECTOR_SET_VERSION}`, () => {
  describe("the vector set itself", () => {
    it("every vector id is unique, so a failure names exactly one line", () => {
      const ids = [...POSITIVE_VECTORS, ...NEGATIVE_VECTORS, ...DOCUMENTED_MISSES].map((v) => v.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("every vector declares a legitimate provenance — no unsourced identifier ships here", () => {
      for (const v of [...POSITIVE_VECTORS, ...NEGATIVE_VECTORS, ...DOCUMENTED_MISSES]) {
        expect(["published", "constructed", "reserved"]).toContain(v.source);
        expect(v.note.length).toBeGreaterThan(20);
      }
    });

    it("every category the detector can emit has at least one POSITIVE and one NEGATIVE vector", () => {
      const all: PiiCategory[] = ["email", "ssn", "credit_card", "phone", ...ALL_INTERNATIONAL_CATEGORIES];
      const pos = new Set(POSITIVE_VECTORS.map((v) => v.category));
      const neg = new Set(NEGATIVE_VECTORS.map((v) => v.category));
      expect([...all].filter((c) => !pos.has(c))).toEqual([]);
      expect([...all].filter((c) => !neg.has(c))).toEqual([]);
    });
  });

  describe("positives", () => {
    for (const v of POSITIVE_VECTORS) {
      it(`${v.id} (${v.category}, ${v.source}) is DETECTED`, () => {
        const { fired, probeFired } = measure(v);
        // the probe pairs with the positive too: if the carrier were malformed
        // the positive could pass for the wrong reason
        expect(probeFired).toBe(1);
        expect(fired).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe("negatives — each paired with a positive probe on the SAME input", () => {
    for (const v of NEGATIVE_VECTORS) {
      it(`${v.id} (${v.category}) does NOT fire, and the detector demonstrably ran`, () => {
        const { fired, probeFired } = measure(v);
        // POSITIVE half: the detector ran over this exact carrier with this
        // exact configuration and found the probe. Without this, `fired === 0`
        // proves nothing (M-033).
        expect(probeFired).toBe(1);
        expect(fired).toBe(0);
      });
    }
  });

  describe("documented misses — the honest limits, asserted", () => {
    for (const v of DOCUMENTED_MISSES) {
      it(`${v.id} (${v.category}) is still NOT detected — update ADR-0117's limits if this reddens`, () => {
        const { fired, probeFired } = measure(v);
        expect(probeFired).toBe(1);
        expect(fired).toBe(0);
      });
    }
  });

  describe("THE SCORE", () => {
    it("is pinned, and moving it requires editing this number on purpose", () => {
      const posDetected = POSITIVE_VECTORS.filter((v) => measure(v).fired >= 1).length;
      const negSilent = NEGATIVE_VECTORS.filter((v) => measure(v).fired === 0).length;
      const missesStillMissed = DOCUMENTED_MISSES.filter((v) => measure(v).fired === 0).length;

      // Measured 2026-10-03 against vector set 2026-10-03.1 (the 2026-09-19.2
      // set plus the nine every-digit separator negatives of AER-006).
      expect(POSITIVE_VECTORS.length).toBe(36);
      expect(NEGATIVE_VECTORS.length).toBe(48);
      expect(DOCUMENTED_MISSES.length).toBe(9);
      expect(posDetected).toBe(36);
      expect(negSilent).toBe(48);
      expect(missesStillMissed).toBe(9);
    });
  });

  describe("the upgrade posture, as a test rather than a promise", () => {
    it("the shipped default set is EMPTY — an install that upgrades detects exactly what it did before", () => {
      expect(DEFAULT_INTERNATIONAL_CATEGORIES).toEqual([]);
    });

    it("with no categories passed, EVERY international positive goes undetected and the four base ones still fire", () => {
      let internationalDetected = 0;
      for (const v of POSITIVE_VECTORS) {
        const hits = detectPII(carrierFor(v)); // no second argument: the shipped call
        const own = hits.find((h) => h.category === v.category)?.count ?? 0;
        const isBase = (["email", "ssn", "credit_card", "phone"] as string[]).includes(v.category);
        if (isBase) {
          // the load-bearing four are NOT configurable and must not regress
          expect(own).toBeGreaterThanOrEqual(1);
        } else if (own > 0) {
          internationalDetected++;
        }
      }
      expect(internationalDetected).toBe(0);
    });

    it("enabling ONE jurisdiction enables exactly that one", () => {
      const cpf = POSITIVE_VECTORS.find((v) => v.id === "p.cpf.bare")!;
      const bsn = POSITIVE_VECTORS.find((v) => v.id === "p.bsn.bare")!;
      const text = `${cpf.text} and ${bsn.text}`;
      const onlyCpf = detectPII(text, ["cpf"]);
      expect(onlyCpf.some((h) => h.category === "cpf")).toBe(true);
      expect(onlyCpf.some((h) => h.category === "bsn")).toBe(false);
      const onlyBsn = detectPII(text, ["bsn"]);
      expect(onlyBsn.some((h) => h.category === "bsn")).toBe(true);
      expect(onlyBsn.some((h) => h.category === "cpf")).toBe(false);
    });

    it("no configuration can switch a BASE detector off", () => {
      const hits = detectPII(`ssn ${SSN_PROBE} mail ${EMAIL_PROBE}`, []);
      expect(hits.map((h) => h.category).sort()).toEqual(["email", "ssn"]);
    });
  });

  describe("counts-only contract — a result may never carry the matched text", () => {
    it("no vector's own value appears anywhere in the serialised hits", () => {
      for (const v of [...POSITIVE_VECTORS, ...NEGATIVE_VECTORS]) {
        const serialised = JSON.stringify(detectPII(carrierFor(v), ALL_INTERNATIONAL_CATEGORIES));
        // POSITIVE half (M-033): the serialised result is non-trivial and names
        // at least the probe's category, so `not.toContain` is not vacuous.
        expect(serialised).toContain(probeFor(v).category);
        expect(serialised).not.toContain(v.text);
      }
    });
  });

  describe("MEASURED false-positive rates — the number that decides a jurisdiction", () => {
    /** mulberry32, so the measurement is deterministic and reproducible. */
    function rng(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    it("each detector's declared falsePositivePct matches a fresh measurement over 40k random strings", () => {
      const r = rng(20260919);
      const D = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
      const L = () => ALPHA[Math.floor(r() * 26)] ?? "A";
      const shapes: Record<string, () => string> = {
        aadhaar: () => D(12),
        cpf: () => D(11),
        bsn: () => D(9),
        sin: () => D(9),
        tfn: () => D(9),
        steuer_id: () => D(11),
        nir: () => D(15),
        dni_nie: () => D(8) + L(),
        codice_fiscale: () => L() + L() + L() + L() + L() + L() + D(2) + L() + D(2) + L() + D(3) + L(),
        nino: () => L() + L() + D(6) + L(),
      };
      const N = 40000;
      for (const detector of INTERNATIONAL_DETECTORS) {
        const shape = shapes[detector.category];
        expect(shape).toBeDefined();
        let hits = 0;
        for (let i = 0; i < N; i++) if (detector.count(shape!()) > 0) hits++;
        const pct = (100 * hits) / N;
        // POSITIVE half: a detector that accepted NOTHING would trivially
        // satisfy an upper bound, so assert the rate is in a two-sided band
        // around the declared figure.
        expect(pct).toBeGreaterThan(detector.falsePositivePct * 0.6);
        expect(pct).toBeLessThan(detector.falsePositivePct * 1.4 + 0.05);
      }
    });

    it("REALISTIC shapes: the rates a deployment actually pays, re-measured over 100k draws each", () => {
      const r = rng(7);
      const D = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join("");
      const N = 100000;
      const byCat = Object.fromEntries(INTERNATIONAL_DETECTORS.map((d) => [d.category, d]));
      const draw: Record<string, () => string> = {
        "r.nl_mobile_bsn": () => `mobile +31 6${D(8)}`,
        "r.order9_tfn": () => `order ${D(9)}`,
        "r.order9_sin": () => `order ${D(9)}`,
        "r.part12_aadhaar": () => `part ${D(12)}`,
        "r.order9_any": () => `ref ${D(9)}`,
      };
      for (const row of REALISTIC_CORPUS_RATES) {
        const make = draw[row.id];
        expect(make).toBeDefined();
        let hits = 0;
        for (let i = 0; i < N; i++) {
          const text = make!();
          if (row.category === "any_of_three") {
            if (
              byCat["bsn"]!.count(text) > 0 ||
              byCat["sin"]!.count(text) > 0 ||
              byCat["tfn"]!.count(text) > 0
            )
              hits++;
          } else if (byCat[row.category]!.count(text) > 0) {
            hits++;
          }
        }
        const pct = (100 * hits) / N;
        // Two-sided: a detector that fired on NOTHING would satisfy a bare
        // upper bound, and the whole point of this table is that the rate is
        // NOT zero (M-033).
        expect(pct).toBeGreaterThan(row.pct * 0.8);
        expect(pct).toBeLessThan(row.pct * 1.2);
      }
    });

    it("enabling all three 9-digit jurisdictions COMPOUNDS — the combined rate exceeds any one of them", () => {
      const combined = REALISTIC_CORPUS_RATES.find((x) => x.id === "r.order9_any")!;
      const tfn = REALISTIC_CORPUS_RATES.find((x) => x.id === "r.order9_tfn")!;
      const sin = REALISTIC_CORPUS_RATES.find((x) => x.id === "r.order9_sin")!;
      expect(combined.pct).toBeGreaterThan(Math.max(tfn.pct, sin.pct));
      // and it is nearer their SUM than their max — independent shots, not one
      expect(combined.pct).toBeGreaterThan(tfn.pct + sin.pct - 2);
    });

    it("a single decimal check digit cannot do better than ~10%, and the registry says so out loud", () => {
      const oneCheckDigit = ["aadhaar", "bsn", "sin", "tfn"];
      for (const d of INTERNATIONAL_DETECTORS) {
        if (oneCheckDigit.includes(d.category)) expect(d.falsePositivePct).toBeGreaterThan(5);
        if (d.category === "nir") expect(d.falsePositivePct).toBeLessThan(0.5);
      }
    });
  });
});
