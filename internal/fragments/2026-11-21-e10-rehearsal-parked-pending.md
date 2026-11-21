<!-- fold: pending -->

**E10 — BYOC rehearsal parked (ADR-0325, 2026-11-21, lane E10).** Owner question open: rehearsal role deferred
2026-11-18 (D-2026-11-18-09). The owner has not applied the one-time rehearsal role
(`docs/ops/BYOC_REHEARSAL_ROLE.md`), so items (3) and (4) of the 2026-11-15 E10 pending fragment (the first
rehearsal in regulait-dev and the `aws:FederatedProvider` check) are parked. No AWS step and no `terraform apply` has
been run. When the owner applies the role and sets the `regulait-dev` account alias, the lane runs `byoc-rehearsal`
and reports timing and snags in a PR. Item (2b), operator backups to S3, needs no AWS access and is still open.
