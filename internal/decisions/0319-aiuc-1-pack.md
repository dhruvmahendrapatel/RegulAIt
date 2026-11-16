# ADR-0319: An AIUC-1 control-mapping pack, cited by identifier only

- **Status**: Accepted (gap G11 of the 2026-11 market analysis, PR #844; master brief 2026-11-15; built by builder lane L8)
- **Date**: 2026-11-15
- **Index**: AIUC-1 pack `aiuc-1@1`, every live requirement of the 15 October 2026 release, ID-only (gap G11)
- **Migration**: none

## Context

AIUC-1 is the AI agent standard published by the Artificial Intelligence Underwriting Company, with an accredited
audit and certification behind it. Enterprise buyers now ask for it alongside SOC 2 and ISO/IEC 42001, and the market
analysis lists the missing mapping as gap G11. The standard is revised every quarter. The release current on
15 November 2026 is the one of 15 October 2026 (Q4 2026); the next is due on 15 January 2027.

The primary source is the standard's own site (standard.aiuc-1.com): its requirement index and its changelog. The
site's terms reserve all rights in its content and grant no licence to reproduce it. So, as for the ISO packs
(ADR-0295) and the ADR-0176 and ADR-0215 rules, requirements may be cited by identifier only.

Open source first: there is no permissively licensed, machine-readable form of AIUC-1. The publisher's changelog
repository is a comparison of releases, not a licensed control catalogue. The pack is authored data on the existing
pack framework (ADR-0058, ADR-0215) and needs no new code and no new collector.

## Decision

1. **`aiuc-1@1`** maps all 50 live requirements of the 15 October 2026 release: A001–A009, B001–B010, C001–C010,
   D001, D003, D004, E001–E006, E008–E013, E015–E018, F001 and F002. Each title is `AIUC-1 <id> — ` followed by
   regulAIt's own description. No AIUC-1 requirement text, control text or evidence template is stored. The
   identifiers were checked against the published requirement index, and the provenance names the source and the
   release.
2. **Mapped per requirement, not per numbered control.** The audit runs against the numbered controls (A001.1 and so
   on) and their evidence. Each control here says which platform evidence bears on one requirement, and its owner
   note says what is left to the organisation.
3. **Retired requirements are not controls.** C011, C012, D002, E007 and E014 are listed in `AIUC_1_RETIRED` and
   tested to be absent. Their scope was folded into C010 and D004, or they were retired outright.
4. **Unmapped requirements are left as gaps, not guessed.**
   - **Evidenced (24 controls).** Each counts a collector the platform already has, with the same collector settings
     the reviewed OWASP and ISACA packs use: guardrail configuration, the PII, retention and budget cascade, access
     recertification, tool-call decisions, approvals, eval runs, the risk register, the governance monitor, user
     feedback, sandbox placements, model cards, agent stewardship, API keys, policy acknowledgements and the audit
     ledger.
   - **Enforced (2 controls).** Only B007 (access recertification) and E015 (the hash-chained audit ledger) are
     claimed as enforced.
   - **Attestation-required, partial (10 controls).** The platform supports part of each, and the note says which
     part.
   - **Attestation-required, not addressed (16 controls).** These are:
     - the organisational requirements (output terms, technical disclosure, internal review, quality management, AI
       disclosure, transparency policy);
     - IP infringement in output (A007);
     - topic scope (C004);
     - agent-specific high-risk output (C005);
     - cyber misuse (F001);
     - catastrophic misuse (F002);
     - the five third-party testing requirements.
5. **Third-party testing is never auto-evidenced.** A009, B001, C010, D004 and E018 need an evaluation by an
   independent party. regulAIt's own eval and red-team runs are first-party, so these controls are attestation-required
   and `unaddressed`, and the note asks for the report and its date.
6. **Trust dimension by principle.** Each requirement takes its principle's dimension: A privacy, B security, C safety,
   D reliability, E compliance, F safety. The pack adds no bias control.
7. **A new AIUC-1 release is a new pack version** (`aiuc-1@2`) with the ADR-0087 diff. v1 is pinned by content hash
   and never edited (ADR-0058).

## Consequences

- The pack picker and the trust radar gain AIUC-1. An organisation preparing for an AIUC-1 audit sees which
  requirements the platform evidences, which it partly supports, and which are its own.
- This is a mapping, not AIUC-1 certification and not an audit. The disclaimer on every report says so. The pack has
  had no domain review.
- Not done:
  - per-control mapping (the numbered controls);
  - mapping AIUC-1's own crosswalks to the other packs;
  - a detector for cyber misuse (F001) or catastrophic misuse (F002);
  - a topic-scope filter (C004);
  - an AI disclosure mechanism in the customer's product (E016);
  - verification of an open-weight model's source and licence (E006.2).
- The pack needs refreshing every quarter. 15 January 2027 is the next release to check.
