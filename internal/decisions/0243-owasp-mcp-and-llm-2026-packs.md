# ADR-0243: OWASP MCP Top 10 pack and the OWASP LLM Top 10 2026 edition

- **Status**: Accepted (implemented)
- **Date**: 2026-11-07
- **Closes**: PENDING.md row P24 (§2g, AI security tools from the 2026 roadmap scan, owner 2026-11-07)
- **Related**: ADR-0058/0087 (packs as versioned rows, the version diff), ADR-0215 (framework imports, licence
  policy), ADR-0097/0100 (MCP admission and the scheduled re-scan), ADR-0043 (egress guard), ADR-0060 (hash-chained
  audit), ADR-0176 (open source first, licences), ADR-0180 (secure by default), ADR-0182 (the ISACA pack pattern)
- **Migrations**: none. Seed packs are code (`DEFAULT_COMPLIANCE_PACKS`) and install as draft rows through the existing
  idempotent `POST /v1/compliance/packs/seed`.

## Context

The owner approved P24 on 2026-11-07: a pack for the OWASP MCP Top 10, the OWASP LLM Top 10 mapping moved to the 2026
edition without editing the old one, and optionally the CSA AI Controls Matrix as a bridge to ISO/IEC 42001.

What the repository had before this ADR: no OWASP **pack** at all. The OWASP ids (`owasp:llm:01`…`10`,
`owasp:agentic:asi01`…`10`) existed only as the evaluator-catalog vocabulary vendored from promptfoo (ADR-0177 row 5),
and that vocabulary follows the 2025 numbering. So "keep the old edition's pack versions intact" is met by shipping the
2025 edition as `owasp-llm-top-10@1` and the 2026 edition as `@2`, side by side.

Sources, checked on 2026-11-07:

| Source | Licence | What we may ship |
|---|---|---|
| OWASP MCP Top 10, 2025 list (owasp.org/www-project-mcp-top-10), beta, phase 3 of 5 | CC BY-NC-SA 4.0 (the project page states it) | identifiers only |
| OWASP Top 10 for LLM Applications 2025 (genai.owasp.org/llm-top-10) | CC BY-SA 4.0 (site-wide statement) | identifiers only |
| OWASP Top 10 for LLM Applications 2026 (genai.owasp.org/resource/owasp-genai-llm-top-10-2026, dated 2026-08-03) | CC BY-SA 4.0 (same statement) | identifiers only |
| CSA AI Controls Matrix v1.1 | CSA licence: free to download for internal use; customisation and commercial use need a CSA licence | nothing; cite by reference |

The 2026 crosswalk, from the edition's coverage (CSA blog, 2026-10-21, and Help Net Security, 2026-08-06):
LLM01→LLM01, LLM02→LLM02, LLM06→LLM03 (Excessive Agency), LLM03→LLM04, LLM04→LLM05, LLM10→LLM06, LLM09→LLM07,
LLM07→LLM08 (renamed and widened from system prompts to hidden context), LLM08→LLM09, LLM05→LLM10.

## Decision

1. **Three new pack versions, authored data in `packages/shared/src/owasp-packs.ts`**, appended to
   `DEFAULT_COMPLIANCE_PACKS` and seeded as drafts:
   - `owasp-mcp-top-10@1`: one control per MCP01:2025…MCP10:2025;
   - `owasp-llm-top-10@1`: the 2025 edition;
   - `owasp-llm-top-10@2`: the 2026 edition. v1 is never edited. An admin reviews v1→v2 with the ADR-0087 diff and
     activates it the ordinary way.
2. **Cited by ID only.** Both licences are share-alike (MCP also non-commercial), so under ADR-0215 decision 2 every
   title begins with the OWASP identifier (`MCP03:2025`, `LLM03:2026`) and the rest of every title, description and
   note is regulAIt's own wording. No OWASP risk name or text is stored; a test asserts the published names are absent.
   The licence is recorded in each pack's provenance and in `packages/shared/THIRD_PARTY.md`.
3. **Control refs name the risk, not the number.** The 2026 edition reuses numbers for different risks (LLM03 was Supply
   Chain, now Excessive Agency). Everything that matches by `controlRef` (the ADR-0087 diff, the ADR-0215 import merge,
   attestations, reports) would carry one risk's mapping and attestations onto another if the ref were `LLM03`. So refs
   are stable risk slugs in our own words (`owasp-llm-top-10:agent-overreach`), the edition number lives in the title,
   and `OWASP_LLM_EDITIONS` is the one crosswalk table. The v1→v2 diff is then ten title changes and one description
   change (the widened hidden-context risk), with no control added or removed and no mapping moved.
4. **The ADR-0215 importer is not used for these sources.** Under an ID-only licence an import carries identifiers and no
   text, so it would add nothing the authored pack lacks, and its ref-matched merge is exactly where renumbering would
   cause harm. The versioned seed is the path; a later edition is another version with its own diff.
5. **Honest coverage.** Every class is our self-assessment against enforcing code; every `audit_decisions` filter names
   a rule id or object type the gateway or its shared rule-id constants write (guard test).
   - MCP: MCP03 tool metadata → MCP admission (`mcp-admission-`: held, cleared, drift re-held, re-scan sweeps);
     MCP02 → per-person default-deny tool grants, evidenced by grant recertification (`grant-cert-`); MCP04 → release
     quarantine (`mcp-release-`); MCP05 → sandbox placements of stdio servers (`isolation_placements`); MCP06 →
     prompt-injection detector at block; MCP07 → identity assertions (`mcp-identity-assertion-`); MCP08 → every MCP
     tool decision in the hash-chained ledger (`objectType: mcp_tool`); MCP09 → shadow-AI discovery (`shadow-`), with
     the egress guard named in the note; MCP10 → content trust (`content-trust-`). MCP01 is partly met but no collector
     counts it, so it is attestation-required.
   - LLM: training-data poisoning is **unaddressed** and attestation-required (regulAIt does not train or fine-tune);
     unsafe use of output is partial and attestation-required (a downstream system's handling is its own). The rest are
     partial except resource exhaustion (budgets and rate limits enforced at the gateway).
6. **No CSA AICM pack.** Its licence requires a CSA licence for customisation and commercial use, which a shipped pack
   is. It is cited by reference here only; ISO/IEC 42001 keeps its existing pack. Re-check if CSA publishes the matrix
   under an open licence.
7. **No claims.** `provenance.reviewedBy` and `reviewedOn` are null until a domain review; each description says the pack
   is a mapping and not a certification.

## Consequences

- An admin can report against the MCP Top 10 and either LLM edition today, and move from 2025 to 2026 by reviewing a diff
  whose every line is a renumbering or the one scope change.
- The evaluator catalog's `owasp:llm:NN` ids still follow 2025 numbering (promptfoo's vocabulary). Moving them is a
  separate change to vendored data and is not made here.
- The MCP list is a beta. When OWASP finalises it, the final list becomes `owasp-mcp-top-10@2`.
- UI: the console's framework label map does not name the two new frameworks yet (it falls back to the id); posted on
  #453.

## Tests

`packages/shared/src/owasp-packs.test.ts` (22): each version parses and is seeded once; refs are unique and prefixed;
no review or compliance claim; licences are ID-only and named in provenance; no OWASP risk name appears; each edition
cites its ten identifiers exactly once and the crosswalk agrees with the titles (no orphaned IDs, every v1 control has
its v2 successor); the v1→v2 diff adds and removes nothing, changes only titles plus the one description, and moves no
mapping; matching by number instead would carry LLM03:2025's mapping onto LLM03:2026; the honest-coverage checks; the
guard that every audit filter names evidence the gateway writes. `compliance-packs.test.ts`, `isaca-pack.test.ts` and
`trust-dimensions.test.ts` are updated for the new frameworks and versions.
