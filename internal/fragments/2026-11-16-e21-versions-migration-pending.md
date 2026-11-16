<!-- fold: pending -->

**E21 — versions and migration follow-ups (ADR-0340 slice 3, 2026-11-16).** (1) An instance merged from several templates cannot migrate; decide whether a multi-template migration (re-merging every template's pinned version) is wanted. (2) Canary promotion uses ADR-0048's eval gate, which workflow templates have no eval for, so promotion needs an override with a reason (or a direct activation); a workflow-specific promotion signal (completion and failure rates of canary instances) is a follow-up. (3) Screens for template versions and migration review are #453.
