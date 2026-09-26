# ADR-0071: Shadow-AI evidence format adapters — read the customer's file, refuse the line you cannot

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: **none, and that is a decision** — see §6
- **Slice**: [COMPETITIVE_PARITY_PLAN.md](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice E (the
  last slice of the parity wave)
- **Parity target**: Witness AI, Harmonic, Zscaler/Netskope AI modules — **on ingestion only.** Their
  discovery comes from a network/CASB position we do not have and do not claim.
- **Extends**: [ADR-0055](0055-shadow-ai-discovery.md) (the evidence model, the pipeline and the
  coverage honesty, all unchanged), [ADR-0069](0069-cross-vendor-cost-consolidation.md) (the adapter
  registry pattern this copies deliberately), [ADR-0042](0042-guardrail-engine.md) (the ingest
  posture, also unchanged)

## Scope, stated before anything else

This slice adds **a parser in front of an importer**. It reads a file a customer's administrator
uploaded, and turns it into the evidence rows ADR-0055 has accepted since migration 0068. It makes
no outbound request of any kind, sits on no network path, holds no CASB or SIEM credential, and
discovers nothing. **RegulAIt still ships no collector.**

Nothing in this ADR changes what shadow-AI discovery can see. It changes how much manual work a
customer does before RegulAIt will look at what they already have.

## Context

### What already existed, and why this slice is small

[ADR-0055](0055-shadow-ai-discovery.md) shipped essentially all of shadow-AI discovery: four
evidence kinds (`egress_log`, `code_scan`, `saas_export`, `self_reported`), `dry_run`/`apply` modes
with `planned`/`applied`/`refused` statuses, payload SHA-256 fingerprints, row counts, per-row
provenance, a pre-parse escalation screen over `SHADOW_AI_FORBIDDEN_KEYS`, strict bounded zod row
schemas, an admin-owned signature catalogue that is data rather than code, severity-by-implication,
confidence-by-distinct-source, cross-import correlation and a coverage scorecard that states in the
response what the deployment cannot see.

**The parity plan's original Slice E paragraph asked for "importers for proxy/firewall logs, CASB
exports, SSO app-access reports". Almost all of that was already built.** The paragraph was
corrected in the plan file on 2026-08-07 before this slice started — the same mistake Slice D made,
caught this time by checking the codebase first.

### The one genuine gap

ADR-0055 accepts rows **already normalised to its zod schemas**. So the workflow was:

> Export your proxy log → write a script that turns CEF into RegulAIt's JSON row shape → post it.

That script is the product gap. It is not hard to write, which is exactly why nobody writes it
carefully: it is the kind of ten-minute `split("|")` that works on the first three lines of the
sample and silently mis-parses the escaped ones for ever afterwards. A pre-slice grep confirmed
there was **no format adapter of any kind** in the repository — nothing that read a CEF or LEEF
record, a W3C/Squid/NCSA proxy line, or a mapped CSV into evidence rows.

### The failure mode this ADR is organised around

> Parse what you can. Skip the lines that do not fit. Return the findings.

That produces a **smaller inventory that looks complete**, which is strictly worse than no inventory
at all: the customer reads "3 findings" and does not read "and 1,400 lines we quietly could not
parse". For a discovery product whose entire honest claim is *coverage equals what you exported*,
silently shrinking the export is the one unrecoverable lie.

So the two rules this ADR is built around, and the ones the tests attack:

> **1. Every line is either read or REFUSED WITH ITS FILE LINE NUMBER. There is no third outcome.**
>
> **2. Implementing a published grammar and having tested a vendor's real export are different
> claims, and the API must not blur them.**

## Decision

**Add a provider-agnostic evidence-format adapter registry in `@regulait/shared`, and one new route
that puts a raw file through an adapter and into the EXISTING ADR-0055 pipeline.** Five adapters
ship: `cef`, `leef`, `w3c_extended`, `proxy_common` and `generic_mapped`.

### 1. An adapter layer, not a subsystem

The load-bearing structural claim, and the thing that keeps this slice small enough to be safe:

- **No new table.** No new evidence kind. No new severity, confidence or correlation logic.
- **`processEvidenceImport` is now ONE function** in `apps/gateway/src/shadow-ai.ts`, extracted from
  the body of `POST /v1/shadow-ai/imports`. Both routes end in it. A raw import cannot reach a code
  path the row-shaped import cannot, cannot skip the escalation screen or the strict row schemas,
  and cannot write anything the row-shaped import could not write.
- **Every adapter validates its own output against ADR-0055's own row schemas** (`egressLogRowSchema`
  and siblings) before returning it. An adapter cannot invent a row shape, because the shape is
  checked against the schema the route will check again. Running the check twice is not redundancy:
  it is what turns a whole-file zod error with a `rows.417.destinationHost` path into a refusal
  naming **line 418 of the file the operator has open**.
- The suite proves the reuse rather than asserting it: the same observation is sent through the raw
  CEF route and through the row-shaped JSON route, and `observed`, `matched`, `unmatched`, `dropped`
  and the entire `findings` array are asserted **identical**.

An adapter's whole vocabulary is the four row schemas. There is no field in any adapter's output
that names a user, role, grant, entitlement, agent, approval, severity or disposition — which is why
ADR-0055's invariant *"an import cannot mint governance"* survives untouched, and is now true for a
stronger reason: the escalation screen cannot fire on file content because file content has nowhere
to land.

### 2. The escapes ARE the slice

`CEF:0|Acme\|Corp|Proxy\\Gateway|4.2|100|Egress to AI\|Model|5|dhost=… suser=alice\=admin cnt=3`

A `split("|")` reads the vendor as `Acme\` and shifts **every subsequent header field by one**. A
`split("=")` over the extension reads the user as `alice\`. Both produce a plausible, confident,
wrong parse — and for CEF specifically, a shifted header means the severity column is read out of
the event name.

So: `splitUnescaped` splits on unescaped separators only and honours a split limit so the extension
keeps its own pipes; `parseCefExtension` finds unescaped `=` signs, takes the key back to the last
space, and gives everything up to the next key to the value (which is how a CEF value may legally
contain spaces); LEEF honours its 2.0 delimiter field and an escaped delimiter inside a value. The
unit suite asserts the correct answer **and asserts the naive `split()` gives a different one**, so
a regression to string-splitting fails a test rather than shipping.

**Not one regular expression is evaluated over file content anywhere in this slice.** That is
ADR-0055's "NO REGEX FROM DATA" rule (see the `ai_endpoint_signatures` note at `schema.ts`:4538)
applied verbatim: a CEF extension is precisely the attacker-shaped string that turns a lazy
alternation into a ReDoS. Every parser here is a character scan.

### 3. A refusal names its locus, and the default refuses the whole file

Two levels, both loud:

- **Whole-file** (`EvidenceFormatError` → 422 `unreadable_evidence_file`): "this is not a W3C log",
  "no `#Fields:` directive", "the file does not carry the mapped column `destinationHost -> 'fqdn'`",
  "the destination column is ambiguous". Kept distinct so an operator is told *wrong adapter / wrong
  file* once, rather than receiving five thousand identical row errors.
- **Per row**: `{row, reason, field}` where `row` is the **true 1-based line number of the physical
  line**, never the index among the lines that happened to parse. `rows + refusals === rowsParsed`
  is asserted on every adapter over a file that contains a bad line.

And the posture that follows from the failure mode above: **`onMalformedRow` defaults to
`refuse_file`.** One unreadable line refuses the whole import, names the line, writes a `refused`
row in `shadow_ai_imports` and an audit deny, and writes **no finding**. `report_and_continue` is
the explicit opt-in for a genuinely ragged 5,000-line export; it still returns every refusal with
its line number, and still records the counts on the import row.

Examples of things that refuse rather than guess, each with the reason stated to the caller:

| Situation | Outcome |
|---|---|
| `rt=last tuesday` | row refused naming `rt` — never stamped with the import time |
| an epoch of 12 digits | refused: neither seconds nor milliseconds, and we will not guess the unit |
| `07/08/2026` | refused (ADR-0069's `parseDateCell`) — a guess moves evidence between windows |
| a W3C line with 2 tokens where `#Fields:` declares 3 | refused naming both counts |
| an NCSA line whose target is `/v1/chat` | refused: an origin-server log names no destination |
| a LEEF 2.0 sixth field that is not a delimiter | refused rather than assumed to be TAB |
| a LEEF record declaring `devTimeFormat` | refused rather than guess a custom strftime pattern |
| a CSV with both `host` and `url` | refused as ambiguous — supply an explicit mapping |
| a CEF record with no `dhost`/`request`/`dst` | refused, listing the keys sought **and the keys present** |

### 4. Three honesty fields, not one

ADR-0069 gave each cost adapter a `limits` string the API returns. This slice needs one more axis,
because "we implement the CEF specification" is a claim we can support and "we tested a Zscaler
export" is not. So every adapter carries **three** fields, all returned by
`GET /v1/shadow-ai/adapters`:

- `capabilities` — what the format can express at all (`destinationHost`, `sourceIdentity`,
  `perRowTimestamp`, `requestCount`, `selfDescribing`, and which evidence `kinds` it produces).
- `formatBasis` — `published-spec` | `declared-format` | `operator-mapped`. Machine-readable, so a
  UI or a buyer's questionnaire can filter on it rather than reading prose.
- `verification` — the sentence. Every `published-spec` adapter says outright: *"It has NOT been run
  against a real export from any vendor's product by this project."* A unit test asserts that
  sentence is present on every one of them, so it cannot be quietly softened later.
- `limits` — what the adapter discards, refuses and cannot do.

### 5. No vendor-named preset, deliberately

ADR-0069 shipped `openai_console`, `anthropic_console` and `aws_cur` against **declared** header sets
and disclosed that nobody had verified them — and named that the biggest honest gap in the slice.
This ADR declines to repeat it. There is no `zscaler_nss`, no `netskope`, no `okta_app_access`
adapter, and a test asserts no adapter id contains any of those vendor names.

The reasoning: a cost export has a small, stable, documented column set, so a declared preset is a
reasonable bet. A CASB or SSO app-access export has **no published format at all**, differs between
tenants of the same product, and changes between releases. A preset built from a screenshot in a
vendor's documentation would carry a vendor's name — which is the part a buyer reads — while being
no more likely to work than `generic_mapped`, which asks. So `generic_mapped` is the answer for
those, it produces **all four evidence kinds**, and its header inference refuses on ambiguity rather
than guessing.

### 6. No migration — and the reasoning, since a migration was budgeted

Number 0083 was reserved for this slice and is **deliberately unused**. The temptation was
`shadow_ai_imports.adapter`, `.rows_parsed`, `.rows_refused` and a `refusals` column, mirroring
ADR-0069's `cost_import_batches`.

It is not needed. `shadow_ai_imports.summary` is already `jsonb NOT NULL` and already carries the
per-import analysis; the adapter id, the format, the format basis, the fields actually read, the
three row counts, the count of rows with no timestamp of their own, and the bounded refusal list all
live there, and `rowCount` continues to mean *rows that were accepted* exactly as it did before.
Adding four columns to an existing table to store what a jsonb column already stores would be
migration cost with no query that needs it — nothing in the product filters imports by adapter.

If a future slice wants "show me every import from adapter X" as an indexed query, that is the
moment to add the column, with a reason. Inventing one now to make the slice look substantial is the
opposite of the discipline this project runs on.

### 7. PII and content posture: ADR-0055's, unchanged

Evidence rows carry hostnames and usernames — `sourceIdentity` is frequently a person. That is not
incidental; it is what makes a finding actionable. ADR-0055 handles it by **bounded, strict,
privilege-free row schemas and nothing else**: no free-text dump, no retention of unmapped columns,
key fragments capped and redacted.

This slice adds **no new posture and relaxes none**. The fields an adapter emits are exactly the
fields ADR-0055 already stores, and the adapters **discard every unmapped field** — a CEF record's
`msg`, `cs1Label`, `requestClientApplication` and everything else never reach the database. The
storage surface after this slice is therefore **strictly narrower** than what a customer's own
hand-written transform would have produced, since a hand-written transform is free to put anything
in a row.

Deliberately **not** added: ADR-0069's `detectPII` + `evaluateGuardrails` ingest scan. That gate
exists on the cost path because a vendor invoice carries arbitrary free-text description columns. An
evidence row has no such column, and adding a scan whose only possible finding is the username in
`sourceIdentity` — the field the feature exists to record — would be theatre that refuses a
customer's proxy log at `block` mode.

### 8. Coverage honesty is preserved, and re-stated at the new surface

`GET /v1/shadow-ai/adapters` returns `EVIDENCE_ADAPTER_POSTURE`, which says: an adapter reads a file
you exported; RegulAIt ships no collector, sits on no network path and discovers nothing; **coverage
remains exactly what you exported**. `GET /v1/shadow-ai/findings` still returns ADR-0055's coverage
scorecard statement with every number. The integration suite asserts both strings survive.

Nothing in the adapter surface implies discovery. The word "scan" appears nowhere in it.

### 9. Default-deny, provider-agnostic, nothing production

Both new routes are admin-only through `app.ts`'s default-deny gate — neither is in
`NON_ADMIN_ROUTES`, and the suite asserts a member gets a 403 from both. The adapter set is
grammar-based rather than vendor-based, which is provider-agnosticism at this layer. Nothing here
takes a `prod` or `production` designation.

## Alternatives rejected

**Skip the lines that will not parse and return what worked.** Rejected — it is the failure mode the
whole ADR is organised around. A quietly smaller inventory that looks complete is worse than a
refusal, because the customer's next act is to believe it.

**Refuse the file only, with no per-line detail.** Rejected. "Your file is malformed" for a
5,000-line export is unactionable. The refusal names the line, the reason and the field, so the
operator can look at it.

**Sniff the format instead of naming an adapter.** Rejected. CEF and LEEF announce themselves, but
Squid and NCSA do not, and a mis-sniffed positional layout reads the client-IP column as the
destination — silently inventing egress from a machine that made none. `proxy_common.layout` is a
required operator assertion with no default.

**Ship `zscaler`, `netskope` and `okta` presets.** Rejected — §5. The vendor name is the part a buyer
trusts, and we would be putting it on something nobody here has tested against that vendor.

**Regex-based field extraction, which is how every log parser is written.** Rejected. ADR-0055's
schema note already names an admin-editable regex over imported strings as a ReDoS primitive; a
regex over an attacker-influenced CEF extension is the same primitive with a lower bar. Character
scans throughout.

**Normalise the destination host inside the adapter.** Rejected. `normalizeEvidenceHost` already
exists in ADR-0055's pipeline and is applied there; doing it twice would create two places for the
dot-boundary rule to drift. The adapter hands over the destination as the file spelled it.

**Add `shadow_ai_imports.adapter` and friends (migration 0083).** Rejected — §6. `summary` is already
jsonb and no query needs the column.

**Add a PII/guardrail ingest scan on the evidence path.** Rejected — §7. It would refuse the field
the feature exists to record, and ADR-0055's bounded schemas already do the real work.

**A file-upload (multipart) endpoint.** Rejected for this slice: the content rides as a JSON string
field, so the existing 2 MB `EVIDENCE_MAX_BYTES` bound and the existing body-size machinery apply
unchanged. Disclosed below as a real limit.

## What this explicitly does NOT give you

Read this before citing any of it.

1. **Nothing here has been run against a real export from any vendor's product by this project.**
   The grammars are implemented from their published specifications. A real Zscaler NSS feed, a real
   QRadar LEEF stream or a real Netskope CSV may carry quirks — vendor-specific keys, a non-standard
   delimiter, a wrapped record — that these adapters refuse. They will refuse *loudly and by line*,
   which is the designed behaviour, but expect to check. **This is the biggest gap in the slice and
   the owner's first follow-up.**
2. **There is no vendor-named adapter at all** (§5). For a CASB, SSO or app-access export the answer
   is `generic_mapped` with an explicit mapping. That is a genuine ergonomic gap versus what the
   parity plan's original paragraph implied.
3. **Only a fixed key list is read from CEF and LEEF.** Custom label pairs (`cs1Label=DestHost` /
   `cs1=…`) are **discarded**, so a product that puts the destination in a custom slot produces a
   "names no destination" refusal on every line. There is no way to configure the key list.
4. **One record must be one line.** No multi-line record reassembly, no syslog fragment joining, no
   gzip, no multipart upload, no streaming. The whole file rides inline in a JSON body under the
   existing 2 MB bound.
5. **The row bound is ADR-0055's 5,000 candidate lines per import.** A real proxy log has millions.
   A customer must chunk or pre-aggregate, and neither this slice nor ADR-0055 helps them do it. For
   the log grammars each line is one request (only CEF's `cnt`, and a non-standard LEEF `cnt`, carry
   an aggregate), so a pre-aggregated export needs `generic_mapped` with the count column mapped.
6. **Re-posting the same file re-imports it.** ADR-0055 has no duplicate-payload guard (ADR-0069's
   409 on `payload_sha256` has no counterpart here), and `upsertFindings` **adds** to
   `observationCount`. So importing the same log twice does not create a second finding — correlation
   is correct — but it does double that finding's observation count. This is pre-existing ADR-0055
   behaviour, unchanged here deliberately; adapters make it easier to hit, so it is named.
7. **A row whose destination does not normalise is still DROPPED, not refused.** ADR-0055's
   `observationsFromImport` drops an unparseable host and reports a `dropped` count. That is a
   weaker posture than this slice's refuse-by-line rule, and it was left alone on purpose: changing
   it would change an accepted ADR's contract from inside a slice about a different layer, exactly
   as ADR-0067 left `llm_as_judge` alone. The count is reported in every response. **Named follow-up
   for the owner.**
8. **A naive timestamp is read as UTC.** That is correct for W3C (the specification requires GMT) and
   for epoch columns, but a `generic_mapped` CSV carrying local wall-clock times will be off by the
   offset, silently. Refusing every naive timestamp would refuse most real files; this is the one
   place the slice takes a documented assumption instead of a refusal.
9. **`devTimeFormat` refuses.** A QRadar feed using the common `MMM dd yyyy HH:mm:ss` device-time
   format has **every row refused**. That is deliberate (guessing a strftime pattern moves evidence
   between windows) but it means an otherwise-readable LEEF file can be entirely unusable.
10. **`report_and_continue` is a real hole if an operator always sets it.** The default protects
    them; the opt-in does not, beyond reporting. There is no policy knob forcing the strict default,
    and no alerting on an import with a high refusal rate.
11. **The log grammars produce `egress_log` only.** `code_scan`, `saas_export` and `self_reported`
    come from `generic_mapped` alone.
12. **No SPA page.** `/admin` still shows ADR-0055's shadow-AI page unchanged; the adapters are API
    only, matching ADR-0066 and ADR-0069.
13. **Adapters do not improve detection.** A destination the admin catalogue does not name is still
    an unmatched observation. Emptying the catalogue makes every adapter match nothing — asserted in
    the integration suite, because "detection is data" had to stay true at the new surface too.

## Consequences

- **Verified end-to-end** (real Postgres, real HTTP): a raw CEF file with escaped separators in both
  the header and the extension reaches `shadow_ai_findings` with the **unescaped** identity as the
  subject, `provider: openai`, severity `high` computed by ADR-0055's analyzer from the admin
  catalogue (**not** from the CEF record's own `severity=5`, which is discarded), and
  `observationCount = 3` from the CEF `cnt`. The same evidence through the row-shaped route produces
  a byte-identical analysis. W3C, LEEF 2.0, Squid and a CASB-shaped CSV each reach a finding, with a
  negative twin in the same file (`github.com`, `atlassian.net`) asserted **not** flagged.
- **Verified structurally**: the refusal paths, the 413/422 bodies, the audit rule ids and the
  `refused` import rows.
- **Not verified**: everything in §"What this explicitly does NOT give you" item 1 — no real vendor
  export has been through this code.
- **Tests**: gateway **1,907 → 1,926 across 110 → 111 files**; `packages/shared` **500 → 550**.
  policy-kernel 129, model-provider 122, infra-provider 174, training-provider 58 unchanged.
- **Migration**: none. Next available number remains **0083**.
- **Files**: `packages/shared/src/evidence-adapters.ts` (+ its unit suite),
  `apps/gateway/src/shadow-ai.ts` (pipeline extraction + two routes),
  `apps/gateway/src/shadow-ai-adapters.test.ts`, `apps/gateway/src/openapi-registry.ts`.

---

## Amendment — 2026-08-09: the SPA surface exists

*This section is appended. Nothing above it has been edited; the Accepted decision stands
unchanged, and this records only that one of its stated gaps has been closed.*

Disclosure 12, **"No SPA page — `/admin` still shows ADR-0055's shadow-AI page unchanged"**, is now
obsolete. `ShadowAiPage.tsx` gained an **Import a raw log file (format adapters)** card that drives
`GET /v1/shadow-ai/adapters` and `POST /v1/shadow-ai/imports/raw`. It is an addition to the existing
page rather than a second one — the same structural claim §1 makes about the routes. **No contract
changed and no migration was written.**

The three things §3 and §4 required the screen to carry, all asserted in a browser:

- **Each adapter's `verification` sentence is printed VERBATIM**, from the registry, before an
  operator can import. For `cef`, `leef`, `w3c_extended` and `proxy_common` that sentence says
  outright that the adapter **has not been run against a real export from any vendor's product**.
  The spec asserts the string is on screen and that changing adapter changes it, so the honesty
  field cannot decay into UI copy that drifts from the code.
- **`formatBasis` is a badge, not prose**: *published grammar* / *declared format (unverified)* /
  *you mapped it*. The registry table below the form lists all five with their verification claims,
  and the page states plainly that **no vendor-named preset ships, deliberately**.
- **The safe default is the default, and the opt-out is labelled as one.** `refuse_file` is
  pre-selected; choosing `report_and_continue` raises an inline warning that the resulting inventory
  will be smaller than the file. Both paths list every refusal with its 1-based line number — the
  spec drives a three-line CEF file whose second line is not a CEF record and asserts the screen
  names line 2 in both modes, and that the accepted lines really did reach ADR-0055's inventory.

**Still not closed by this amendment**: disclosures 1–11 and 13 stand exactly as written. In
particular **nothing has been run against a real export from any vendor's product** — the page makes
that visible, it does not make it untrue.

Evidence: `apps/web/src/views/admin/governance/ShadowAiPage.tsx`, driven in Chromium by
`apps/web/e2e/phase6-parity-ui.spec.ts` (four tests, zero console errors, screenshots
`phase6-12`…`phase6-15`).
