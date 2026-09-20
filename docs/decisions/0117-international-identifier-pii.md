# ADR-0117 — International national-identifier PII: enforced on every governed path, opt-in per jurisdiction, and "checksum-backed" is not a safety rating

- **Status**: Accepted
- **Date**: 2026-09-20
- **Relates to**: [ADR-0042](0042-guardrail-engine.md) (the guardrail engine and its `pii` registration),
  [ADR-0020](0020-ide-interception-compat-endpoints.md) (the compat/IDE shims as a translation
  layer over one governed core, and its deterministic agent tie-break),
  [ADR-0107](0107-unordered-single-row-reads.md) (a read whose result depends on unstated ordering),
  [ADR-0108](0108-test-side-unordered-reads.md) (a negative assertion is satisfied by absence)
- **Migration**: **0110** — `org_settings.pii_international_categories`, jsonb, default `'[]'`.

## Context

### What prompted it, and the claim that was not true

A customer-facing deck states: *"A user pastes a **national identity number** into a prompt → the
request is refused before any model is called, recorded in the audit trail, and costs nothing."*

The detector behind that sentence (`packages/shared/src/pii.ts:13`) recognised exactly four
categories — `email`, `ssn`, `credit_card`, `phone` — and two of them are **US-specific by
construction**: the SSN pattern encodes US area/group/serial issuance rules, and the phone pattern
is a US format. A UK National Insurance number, an Aadhaar, a Steuer-ID, a CPF or a BSN passed
through untouched. The claim was true of a US Social Security number and of nothing else.

### A second claim that had no referent at all

The same slide's speaker notes cited *"measured 22/25 on the suite's own PII contract"*. **That
string does not exist anywhere in this repository.** It appears to have been carried across from a
sibling product. There was no measured PII contract for this product — not a failing one, not a
stale one; none. This ADR creates one, and the number it creates is deliberately not 22/25.

## The finding that changed the decision

An initial draft shipped ten jurisdictions and defaulted to "the checksum-backed ones", on the
reasoning that a checksum distinguishes an identifier from an arbitrary digit run. **Three of its
checksums were wrong, and the reasoning itself was wrong.**

Each defect was verified against a published authority before being changed:

- **Verhoeff (Aadhaar)** used the *generation* permutation offset inside the *validation* loop. It
  rejected the published worked example and disagreed with a table-driven reference on ~18% of
  random 12-digit input **while still accepting ~10% of it** — a checksum-shaped function that was
  not the checksum. This is the dangerous failure mode: it looked like it worked.
- **The German IdNr structural rule was inverted.** Where a digit occurs three times in the first
  ten, the published rule is that the three must **not** stand in directly consecutive positions;
  the draft required that they did. The single published example carries a non-adjacent pair, so
  **the one test value available could not see the bug**.
- **The French NIR key runs 01..97, not 00..96.** Reducing `97 - (body mod 97)` modulo 97 both
  missed every real NIR keyed 97 and accepted a fabricated one keyed 00 — about one in ninety-seven,
  in each direction.

Separately, the digit-run anchor was satisfied by a scheme's own separator, so a space-grouped
16-digit card offered its first twelve digits as an Aadhaar candidate with only the check digit in
the way.

### Why "checksum-backed" was retired as a safety rating

Measured, not assumed: **a single decimal check digit divides the candidate space by ten and no
more.** On random digit runs of the right length —

| jurisdiction | measured false-positive rate |
|---|---|
| BSN (Netherlands) | **9.03%** |
| TFN (Australia) | **9.00%** |
| NINO (United Kingdom) | **8.47%** |
| SIN (Canada) | **8.09%** |
| Aadhaar (India) | **8.03%** |
| DNI/NIE (Spain) | 3.87% |
| Codice Fiscale (Italy) | 3.87% |
| CPF (Brazil) | 1.02% |
| Steuer-ID (Germany) | **0.23%** |
| NIR (France) | **0.06%** |

A scheme with one check digit and no other structure rejects nine in ten arbitrary digit runs and
accepts the tenth. In `block` mode that is not a detection nuance — **it refuses legitimate work,
and the user cannot route around it.** An order number, a part number or a timestamp of the right
length is a coin toss with nine sides.

So the phrase "checksum-backed" is not used in this product as a safety claim. The rate is recorded
per jurisdiction in the registry and is what an administrator should be choosing against.

## Decision

1. **Ten jurisdictions are implemented** — Aadhaar, CPF, BSN, SIN, TFN, Steuer-ID, NIR, DNI/NIE,
   Codice Fiscale, NINO — with checksum or structural validation where the scheme defines one.

2. **The shipped default is EMPTY.** `org_settings.pii_international_categories` defaults to `'[]'`.
   An existing installation detects exactly what it detected before and refuses exactly what it
   refused before until an administrator acts. Given the rates above, defaulting any jurisdiction on
   would start refusing traffic on upgrade — this repo's standing posture forbids that, and here the
   posture and the measurement agree.

3. **Selection is per jurisdiction, org-wide.** A German deployment turns on Steuer-ID at 0.23% and
   does not inherit BSN at 9.03%. The rate belongs next to the switch.

4. **The four base categories always run** and no configuration can reach them. The default
   disables nothing that previously worked, and that is asserted rather than assumed.

5. **`enforcePII` takes the enabled jurisdictions as a REQUIRED argument.** Not optional, not
   defaulted. A dispatch path added next month cannot silently enforce less than the org configured,
   because the compiler asks. The type error is the enumeration: ten call sites had to be updated —
   model dispatch input and output, the pre-dispatch project gate, the cached-output gate, connector
   invoke input and output, MCP `tools/call` arguments and tool result, the training-corpus scan and
   the cost/roster ingest scan.

## Every producer, asserted separately — and why that shape was necessary

M-035's rule is that a guarantee watching one of several producers passes while another is open.
The conformance file enumerates six paths and asserts each against **the same identifier**, and
**a probe proved the shape was needed**: the first draft had one test for "model dispatch input"
driven through the HTTP route, and it **stayed green when `executeGovernedDispatch`'s own gate was
neutralised**, because the route gate ahead of it refused first. The dispatch core's gate is the one
that covers orchestration and worker-node dispatch, which never touch the route handler. It now has
an assertion that calls it directly.

Each path is also asserted to **allow** the same string under the shipped default. That pairing is
what makes the enforcement assertions non-vacuous: a path that refused everything, or one whose gate
never ran, fails one half or the other.

### The compat path was passing for the wrong reason

`POST /v1/messages` resolved its agent by the `mock-balanced` **model string**. In the shared suite
database that is ambiguous, and ADR-0020's tie-break — lowest tier, then oldest, then id — correctly
selects another file's agent carrying the same model, whereupon the caller is refused with
`agent_denied`. An assertion asking only for "not 200" was satisfied by a refusal that had nothing
to do with PII, so the enforcement claim on the IDE path was never tested in a full run. **The
product was behaving correctly; the test was trusting a coincidence.** Both call sites now name the
agent, and PATH 5 requires the refusal to name the PII reason (M-026). Probe: removing the pin
reddens exactly those two cases and leaves the rest green.

## The measured contract

Vectors live in `packages/shared/src/pii-vectors.ts` — **in this repository**, so a fresh clone
reproduces the score. (A sibling product keeps its vector file in a different repo, where its
conformance test fails by design from a clean checkout and no customer can reproduce the number.)

**36 positives, 39 negatives, 9 documented misses.** Roughly half the set is near-miss strings that
must stay silent. Every negative is paired with a positive probe on the same input proving the
detector ran at all — a negative assertion is otherwise satisfied by a detector that never fired
(M-033/ADR-0108). False-positive rates are pinned two-sided, per jurisdiction and per realistic
input shape, so an improvement that quietly widens a pattern fails too.

**The misses are asserted as firmly as the hits.** They are not tuned away: a CPF grouped with
spaces instead of its printed dots and hyphen is not detected, because widening the separator set
would make every space-grouped 11-digit reference a CPF candidate — the wrong trade at a 1.02% base
rate. Predicted as a miss before it was run, and recorded as one.

## Honest limits

- **The guardrail-engine `pii` registration stays base-only.** Its detector interface takes no
  deployment configuration, so it does not see the international set. Its limits string now says so
  rather than implying parity with the dispatch path. This is a real asymmetry, disclosed rather
  than papered over.
- **Nine documented misses**, each with a stated reason.
- **The rates are measured against random digit runs and a set of realistic input shapes**, not
  against a customer's actual corpus. A deployment whose traffic is full of 9-digit part numbers
  will experience BSN differently from one that is not.
- **Detection is not classification.** A detected identifier is refused, logged or warned per the
  project's mode; nothing here claims to know whose identifier it is.
- **Only the dispatch surface is covered.** Data at rest, imported corpora already stored, and
  historical rows are untouched by this ADR.

## What the deck may now say

Instead of *"a national identity number"*:
> *"A user pastes an identifier the deployment recognises — a German tax ID, a UK NI number, an
> Aadhaar, and seven others — and the request is refused before any model is called. Jurisdictions
> are switched on per deployment, each with its measured false-positive rate published next to the
> switch, because a single check digit rejects nine arbitrary digit runs in ten and accepts the
> tenth."*

Instead of *"measured 22/25 on the suite's own PII contract"*:
> *"A conformance contract of 36 positives and 39 negatives, with nine known misses documented and
> asserted, and per-jurisdiction false-positive rates measured and pinned — reproducible from a
> clean checkout of the product."*
