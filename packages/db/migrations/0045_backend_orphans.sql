-- Migration 0045 — the remaining "backend orphans" DDL (ADR-0027), grouped:
-- each section is additive with behaviour-preserving defaults.

-- O6 cert-rotation lifecycle: one cert_rotations row PER ATTEMPT (created at
-- propose, advanced by /decide to rotated/denied/failed). `reason` carries
-- the approver's denial reason or the provider's failure message. The status
-- enums (cert_inventory rotation_denied/rotation_failed, cert_rotations
-- denied) are drizzle-side text enums — no DDL needed for them.
ALTER TABLE "cert_rotations" ADD COLUMN "reason" text;
