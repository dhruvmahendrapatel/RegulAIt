<!-- fold: pending -->

**P-01a — Approvals screen: filter by the `model_call` kind (ADR-0251, 2026-11-14, lane L1).** Model calls matched by
an approval rule are now held as `model_call` approvals. `ApprovalsAdminPage.tsx` mirrors the approval kinds for its
filter and does not list `model_call` (nor the other kinds added since the list was written). The rows are in the
queue and decidable; only the kind filter cannot reach them. For the UI builder on #453: add the missing kinds, or read
the list from the API.
