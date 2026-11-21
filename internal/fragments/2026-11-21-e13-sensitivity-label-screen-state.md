<!-- fold: state-recap -->
**Sensitivity labels screen (builder lane E13, 2026-11-21; ADR-0363 slice 1 UI).** A new "Sensitivity labels" page under
Policies & gates (`/admin/sensitivity-labels`) closes the four `/v1/sensitivity-labels` KNOWN_UI_GAPS entries. The labels
synced from the tenant show as a tree (a child under its parent), each with what happens today; an unmapped label shows the
fallback it follows. A new mapping opens on block and restricted. Loosening a mapping, a fallback or removing a mapping is
confirmed first and then step-up'd by the gateway (its own `labelPolicyRelaxes` rule, mirrored in the page model);
tightening is a plain save. The classifier editor and review (six `/v1/classifiers` routes) follow in the next PR.
