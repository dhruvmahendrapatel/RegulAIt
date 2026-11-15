<!-- fold: state-decisions -->

Owner decision (2026-11-15): ADR-0322 (opt-in, per-tenant read-only vendor usage/cost pull) is accepted. It amends
ADR-0069 and ADR-0076: an admin may store a read-only vendor usage/cost credential (MFA step-up, audited, encrypted with
the data key, rotatable, never returned or logged); a scheduled pull through the guarded fetch writes imported lines
only; the feature is off by default and refused under `air_gapped`; file import is unchanged.
