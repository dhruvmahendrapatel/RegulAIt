<!-- fold: state-recap -->
**2026-11-17 - lane E44 slice 1: customer sensitivity labels at the gateway ([ADR-0363](../decisions/0363-classification-interop-and-ai-app-risk.md), migration `sensitivity_labels` (pending, numbered at merge)).**
Purview labels are read from attached files (OOXML LabelInfo/custom properties, PDF metadata, the email header) without
the MIP SDK, and the label list is read read-only by the `idp_entra` scan when the app holds
`InformationProtectionPolicy.Read.All`. One gate in `dispatchAttempt` allows, redacts or blocks each file before any
provider work; unmapped, foreign-tenant, encrypted and unreadable files block by default (relaxing is a step-up). A label
mapped to a compliance profile pulls that profile's PII mode and guardrail floor into the call. Four admin routes are
API-only (#453). Slices 2 (customer classifiers) and 3 (AI app risk attributes) follow.
