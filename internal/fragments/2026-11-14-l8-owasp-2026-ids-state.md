<!-- fold: state-recap -->

**2026-11-14 - P24 closed: the evaluator catalog on OWASP LLM 2026 numbering ([ADR-0297](../decisions/0297-sector-packs-and-owasp-2026-ids.md) part 2, builder lane L8).**
The catalog cites `owasp:llm:2026:NN`; 2025 ids (`owasp:llm:NN`) remain aliases of the same risk wherever an id is
read (required-test policies, the strict defaults, decision-regression goldens, pack controls), so nothing stored
changes meaning. No migration.
