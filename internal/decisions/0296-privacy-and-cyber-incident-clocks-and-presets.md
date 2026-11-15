# ADR-0296: GDPR, NIS2, DORA and CRA incident clocks, and privacy-law presets

- **Status**: Accepted (P18 lanes B2 and B3, master brief 2026-11-14; built by builder lane L8 in two PRs)
- **Date**: 2026-11-14
- **Index**: GDPR, NIS2, DORA and CRA incident clocks; GDPR, CCPA, DPDP and LGPD presets (P18 B2, B3)
- **Backlog**: [PENDING, P18](../product/PENDING.md); audit [2026-11-07 P18 coverage](../reviews/2026-11-07-p18-framework-coverage.md) lanes B2, B3
- **Migration**: `pending/incident_clock_regimes_gdpr_nis2_dora_cra.sql` (numbered at merge, ADR-0252)

## Context

The P18 audit rated NIS2 and the CRA "missing", DORA "missing (one feed item)" and GDPR, CCPA/CPRA, the DPDP Act and
LGPD "partial". Its overlap note: the GDPR, NIS2, DORA and CRA breach and incident clocks all fit the pluggable regimes
of `incident-clocks.ts` (ADR-0182 A12), and the privacy laws share the ADR-0224 DSR and RoPA machinery. Open source
first: as ADR-0182 found, no maintained library encodes regulation-specific notification periods (STIX 2.1 and CSAF 2.0
model neither), so the catalogue stays data.

## Decision

### Part 1 — incident clocks (first PR)

1. **Four regimes, fourteen clocks**, each quoting its paragraph verbatim from the act's Publications Office text
   (retrieved 2026-11-14), with its source URL; a test reads each period back out of its own quote.
   - GDPR (Regulation (EU) 2016/679): Art. 33(1) 72 hours to the supervisory authority (Art. 33(4) allows the
     information in phases, so an initial report is allowed); Art. 33(2) processor to controller and Art. 34(1) data
     subjects, "without undue delay" (no number: due at the start, the strict reading).
   - NIS2 (Directive (EU) 2022/2555) Art. 23(4): early warning 24 hours, incident notification 72 hours, final report
     one month.
   - DORA: the time limits are in Delegated Regulation (EU) 2025/301 Art. 5(1): initial notification four hours from
     classification (the strict reading: listing the criterion is the classification), intermediate report 72 hours,
     final report one month.
   - CRA (Regulation (EU) 2024/2847) Art. 14, applying from 11 September 2026: actively exploited vulnerability, early
     warning 24 hours and notification 72 hours; severe incident, early warning 24 hours, notification 72 hours and
     final report one month.
2. **Five new criteria start them**: `personal_data_breach`, `significant_cyber_incident`, `major_ict_incident`,
   `exploited_vulnerability`, `severe_product_incident`. None is an Art. 3(49) criterion, so none makes an incident
   serious or starts an EU AI Act clock.
3. **Two new due kinds**: `hours` (exact) and `months` (UTC calendar months, clamped to the shorter month's last day).
   A later report the text counts from an earlier one ("one month after the submission of the incident notification")
   is counted from the awareness time, the earliest it can fall due — the catalogue's existing strict reading.
4. **Role and applicability are the organisation's.** regulAIt does not know whether the organisation is a controller
   or processor, an essential or important entity, a financial entity or a manufacturer, so every clock of the regime
   starts and an admin sets aside what does not apply, with a reason (the HIPAA pattern). Each clock carries the caveat
   "confirm with counsel".
5. **Secure by default (ADR-0180).** The strict org setting enables all six regimes; the migration widens the three
   CHECK lists, sets the column default and adds the four regimes to every existing org (they are new regimes, not an
   admin's choice). Turning one off is the existing audited relaxation.
6. **Not encoded:** CRA Art. 14(2)(c) (14 days after a corrective measure is available: a start the register does not
   record), NIS2 Art. 23(4)(c) and (e) (on request; ongoing incidents) and DORA Art. 5(4) (a weekend extension, never
   earlier).

### Part 2 — privacy-law presets (second PR)

GDPR, CCPA/CPRA, DPDP and LGPD as presets on the ADR-0224 DSR and RoPA machinery. Recorded with that PR.

## Consequences

- An incident can now carry the clocks of six regimes; the register, sweep, export and close rules are unchanged.
- The web incident model's regime and criterion lists were synced (a model file, no screen change), because enabling
  a regime in the console rebuilt the list from the old two entries and would have dropped the new four. The
  criteria picker and clock cards for the new regimes are UI work (#453).
- **Owner question open (A5, EU legal text):** these clocks quote short passages of EU acts verbatim, as ADR-0182's EU
  AI Act clocks already do. If the owner rules that EUR-Lex text may be cited by identifier only, the quotes become
  paraphrases and the period test reads the number from a separate field.
