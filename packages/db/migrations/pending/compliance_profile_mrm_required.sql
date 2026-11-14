-- ADR-0290: a compliance profile can require model risk management (ADR-0045) for the projects it classifies.
-- NULL and false are both "no requirement"; true makes the ADR-0045 dispatch gate enforce on that project's
-- dispatches even where the org-wide mrm_enforced toggle was relaxed (ADR-0021 ceiling, OR-composed).
ALTER TABLE "compliance_profiles" ADD COLUMN "mrm_required" boolean;
