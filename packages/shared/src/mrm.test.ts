import { describe, expect, it } from "vitest";
import {
  assessBiasFairness,
  assessCardCompleteness,
  cardState,
  daysUntilExpiry,
  effectiveApprovalStatus,
  evaluateMrmGate,
  isLiveApproval,
  mrmPosture,
  requestModelCardSignOffSchema,
  createModelCardSchema,
  attachModelCardEvidenceSchema,
  type MrmApprovalLike,
} from "./mrm.js";

/**
 * ADR-0045 — the MRM registry's pure half, proved by attack.
 *
 * The thing these tests exist to make impossible to fake: an EXPIRY THAT IS
 * DECORATIVE. Every assertion about a live sign-off is paired with one about a
 * lapsed one, and the lapsed cases deliberately leave the STORED status set to
 * 'approved' — because the whole design rests on the gate recomputing from
 * `validUntil` rather than trusting a status a sweep may never have refreshed.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
const future = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const past = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function approval(over: Partial<MrmApprovalLike> & { id?: string } = {}) {
  return {
    id: over.id ?? "a1",
    status: over.status ?? "approved",
    validUntil: "validUntil" in over ? over.validUntil! : future(30),
  } as MrmApprovalLike & { id: string };
}

describe("effectiveApprovalStatus — the stored status is a cache, never the truth", () => {
  it("an approved record inside its window reads approved", () => {
    expect(effectiveApprovalStatus(approval({ validUntil: future(1) }), NOW)).toBe("approved");
  });

  it("an approved record PAST validUntil reads expired even though the column still says approved", () => {
    const stale = approval({ status: "approved", validUntil: past(1) });
    expect(stale.status).toBe("approved"); // the sweep never ran
    expect(effectiveApprovalStatus(stale, NOW)).toBe("expired");
    expect(isLiveApproval(stale, NOW)).toBe(false);
  });

  it("expiry at exactly validUntil is EXPIRED, not the last live instant", () => {
    expect(effectiveApprovalStatus(approval({ validUntil: NOW }), NOW)).toBe("expired");
    expect(effectiveApprovalStatus(approval({ validUntil: new Date(NOW.getTime() + 1) }), NOW)).toBe(
      "approved",
    );
  });

  it("a null validUntil never expires (the explicitly acknowledged case)", () => {
    expect(effectiveApprovalStatus(approval({ validUntil: null }), NOW)).toBe("approved");
    expect(daysUntilExpiry(approval({ validUntil: null }), NOW)).toBeNull();
  });

  it("time passing never PROMOTES a record — pending/denied/revoked are returned untouched", () => {
    for (const s of ["pending", "denied", "revoked", "superseded", "draft"] as const) {
      expect(effectiveApprovalStatus({ status: s, validUntil: past(10) }, NOW)).toBe(s);
      expect(effectiveApprovalStatus({ status: s, validUntil: future(10) }, NOW)).toBe(s);
    }
  });

  it("an unknown stored status degrades to draft rather than being trusted", () => {
    expect(effectiveApprovalStatus({ status: "nonsense", validUntil: null }, NOW)).toBe("draft");
  });

  it("ISO-string timestamps are handled identically to Date instances", () => {
    expect(effectiveApprovalStatus({ status: "approved", validUntil: past(1).toISOString() }, NOW)).toBe(
      "expired",
    );
    expect(
      effectiveApprovalStatus({ status: "approved", validUntil: future(1).toISOString() }, NOW),
    ).toBe("approved");
  });

  it("daysUntilExpiry goes negative once lapsed", () => {
    expect(daysUntilExpiry(approval({ validUntil: future(10) }), NOW)).toBe(10);
    expect(daysUntilExpiry(approval({ validUntil: past(3) }), NOW)).toBeLessThan(0);
  });
});

describe("cardState — a reviewer's single actionable state", () => {
  it("no records at all = unsigned", () => {
    expect(cardState([], NOW, 30).state).toBe("unsigned");
  });

  it("a live record beyond the warn window = approved", () => {
    expect(cardState([approval({ validUntil: future(90) })], NOW, 30).state).toBe("approved");
  });

  it("a live record INSIDE the warn window = expiring (work, not an outage)", () => {
    const s = cardState([approval({ validUntil: future(5) })], NOW, 30);
    expect(s.state).toBe("expiring");
    expect(s.daysLeft).toBe(5);
  });

  it("a lapsed record does NOT fall back to an older still-valid one", () => {
    const s = cardState(
      [
        approval({ id: "new", status: "approved", validUntil: past(1) }),
        approval({ id: "old", status: "superseded", validUntil: future(365) }),
      ],
      NOW,
      30,
    );
    expect(s.state).toBe("expired");
    expect(s.live).toBeNull();
  });

  it("a pending request with no live acceptance = pending", () => {
    expect(cardState([approval({ status: "pending", validUntil: future(30) })], NOW, 30).state).toBe(
      "pending",
    );
  });

  it("a revoked acceptance = revoked, never approved", () => {
    expect(cardState([approval({ status: "revoked", validUntil: future(365) })], NOW, 30).state).toBe(
      "revoked",
    );
  });
});

describe("evaluateMrmGate — the dispatch decision", () => {
  const card = (id: string, approvalsForCard: Array<MrmApprovalLike & { id: string }>) => ({
    id,
    intendedUse: `use-${id}`,
    approvals: approvalsForCard,
  });

  it("not enforced = allowed, whatever the registry says (byte-identical default)", () => {
    const d = evaluateMrmGate({ enforced: false, cards: [], now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("not_enforced");
  });

  it("enforced with NO card = refused with mrm-no-card", () => {
    const d = evaluateMrmGate({ enforced: true, cards: [], now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_card");
    expect(d.ruleId).toBe("mrm-no-card");
  });

  it("enforced with a card but no sign-off = refused with mrm-approval-required", () => {
    const d = evaluateMrmGate({ enforced: true, cards: [card("c1", [])], now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("mrm-approval-required");
    expect(d.cardId).toBe("c1");
  });

  it("enforced with a LIVE sign-off = allowed, and names the card + approval", () => {
    const live = approval({ id: "ok", validUntil: future(10) });
    const d = evaluateMrmGate({ enforced: true, cards: [card("c1", [live])], now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("approved");
    expect(d.cardId).toBe("c1");
    expect(d.approvalId).toBe("ok");
  });

  it("enforced with a LAPSED sign-off = refused with mrm-approval-expired, distinct from never-reviewed", () => {
    const stale = approval({ id: "old", status: "approved", validUntil: past(2) });
    const d = evaluateMrmGate({ enforced: true, cards: [card("c1", [stale])], now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("expired");
    expect(d.ruleId).toBe("mrm-approval-expired");
    expect(d.approvalId).toBe("old");
    expect(d.detail).toContain("LAPSED");
  });

  it("a revoked sign-off refuses with its own ruleId", () => {
    const d = evaluateMrmGate({
      enforced: true,
      cards: [card("c1", [approval({ id: "r", status: "revoked", validUntil: future(365) })])],
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.ruleId).toBe("mrm-approval-revoked");
  });

  it("ONE live card among several is enough — a second unsigned purpose does not block", () => {
    const d = evaluateMrmGate({
      enforced: true,
      cards: [card("c1", []), card("c2", [approval({ id: "ok", validUntil: future(5) })])],
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(d.cardId).toBe("c2");
  });

  it("a pending request is NOT an acceptance — it still refuses", () => {
    const d = evaluateMrmGate({
      enforced: true,
      cards: [card("c1", [approval({ id: "p", status: "pending", validUntil: future(30) })])],
      now: NOW,
    });
    expect(d.allowed).toBe(false);
  });

  it("the refusal ruleIds are the three STABLE strings the audit trail is queried by", () => {
    const ids = new Set(
      [
        evaluateMrmGate({ enforced: true, cards: [], now: NOW }),
        evaluateMrmGate({ enforced: true, cards: [card("c", [])], now: NOW }),
        evaluateMrmGate({
          enforced: true,
          cards: [card("c", [approval({ id: "x", validUntil: past(1) })])],
          now: NOW,
        }),
      ].map((d) => d.ruleId),
    );
    expect(ids).toEqual(new Set(["mrm-no-card", "mrm-approval-required", "mrm-approval-expired"]));
  });
});

describe("assessBiasFairness — a DECLARATION check, and it says so", () => {
  it("an empty slot list is never complete: 'we did not look' must not read as 'we looked'", () => {
    const a = assessBiasFairness([]);
    expect(a.declared).toBe(0);
    expect(a.complete).toBe(false);
  });

  it("an assessed slot with no resultRef is unevidenced and blocks completeness", () => {
    const a = assessBiasFairness([
      { dimension: "dialect", method: "counterfactual set", status: "assessed" },
    ]);
    expect(a.unevidenced).toBe(1);
    expect(a.complete).toBe(false);
  });

  it("assessed + evidenced, or explicitly waived, is complete", () => {
    const a = assessBiasFairness([
      { dimension: "dialect", method: "counterfactual set", status: "assessed", resultRef: "run-1" },
      { dimension: "age", method: "n/a for this use", status: "waived" },
    ]);
    expect(a.complete).toBe(true);
    expect(a.waived).toBe(1);
  });

  it("an in-progress slot blocks completeness", () => {
    expect(
      assessBiasFairness([{ dimension: "d", method: "m", status: "in_progress" }]).complete,
    ).toBe(false);
  });

  it("the disclaimer is ALWAYS present and never claims a measurement", () => {
    for (const entries of [[], [{ dimension: "d", method: "m", status: "assessed" as const, resultRef: "r" }]]) {
      const a = assessBiasFairness(entries);
      expect(a.disclaimer).toContain("does not measure bias");
      expect(a.disclaimer).toContain("never that the model is fair");
    }
  });
});

describe("assessCardCompleteness", () => {
  it("names every missing section of a bare card", () => {
    const c = assessCardCompleteness({ intendedUse: "summarize tickets", biasFairness: [] });
    expect(c.complete).toBe(false);
    expect(c.missing).toEqual(
      expect.arrayContaining(["limitations", "data_claims", "bias_fairness", "evidence"]),
    );
  });

  it("a fully authored card with evidence is complete", () => {
    const c = assessCardCompleteness({
      intendedUse: "summarize tickets",
      limitations: "no legal advice",
      dataClaims: { training: "vendor-stated" },
      biasFairness: [{ dimension: "d", method: "m", status: "assessed", resultRef: "run-1" }],
      standardRefs: ["nist-ai-rmf:MEASURE-2.11"],
      evidenceCount: 1,
    });
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
  });
});

describe("mrmPosture — the honest label", () => {
  it("enforced says ENFORCED", () => {
    expect(mrmPosture({ enforced: true, cardCount: 0, approvedCount: 0 }).posture).toBe("enforced");
  });
  it("cards but no toggle says DECLARED but NOT enforced", () => {
    const p = mrmPosture({ enforced: false, cardCount: 3, approvedCount: 1 });
    expect(p.posture).toBe("declared");
    expect(p.label).toContain("NOT enforced");
  });
  it("no cards says so plainly — an empty registry enforces nothing", () => {
    const p = mrmPosture({ enforced: false, cardCount: 0, approvedCount: 0 });
    expect(p.posture).toBe("absent");
    expect(p.label).toContain("enforces nothing");
  });
});

describe("input shapes refuse the ambiguous cases", () => {
  it("a card must name exactly one subject", () => {
    expect(createModelCardSchema.safeParse({ intendedUse: "x" }).success).toBe(false);
    expect(
      createModelCardSchema.safeParse({
        intendedUse: "x",
        agentId: "11111111-1111-1111-1111-111111111111",
        customProviderId: "22222222-2222-2222-2222-222222222222",
      }).success,
    ).toBe(false);
    expect(
      createModelCardSchema.safeParse({
        intendedUse: "x",
        agentId: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("a sign-off must carry a recertification date, or explicitly accept having none", () => {
    const approver = { approverUserId: "11111111-1111-1111-1111-111111111111" };
    expect(requestModelCardSignOffSchema.safeParse(approver).success).toBe(false);
    expect(
      requestModelCardSignOffSchema.safeParse({ ...approver, validUntil: "2027-01-01T00:00:00.000Z" })
        .success,
    ).toBe(true);
    expect(
      requestModelCardSignOffSchema.safeParse({ ...approver, acknowledgeNoExpiry: true }).success,
    ).toBe(true);
    // both is a contradiction, not a convenience
    expect(
      requestModelCardSignOffSchema.safeParse({
        ...approver,
        validUntil: "2027-01-01T00:00:00.000Z",
        acknowledgeNoExpiry: true,
      }).success,
    ).toBe(false);
  });

  it("evidence must match its kind", () => {
    expect(
      attachModelCardEvidenceSchema.safeParse({ kind: "eval_run", externalRef: "http://x" }).success,
    ).toBe(false);
    expect(
      attachModelCardEvidenceSchema.safeParse({
        kind: "eval_run",
        evalRunId: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(true);
    expect(attachModelCardEvidenceSchema.safeParse({ kind: "external", externalRef: "report-7" }).success).toBe(
      true,
    );
  });
});
