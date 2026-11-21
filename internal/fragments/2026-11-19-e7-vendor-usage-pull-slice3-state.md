<!-- fold: state-recap -->

**2026-11-19 - ADR-0322 slice 3: GitHub Copilot and Cursor connectors for the vendor usage pull (builder lane E7).**
Two more vendors on the slice 2 engine, with no new route and no migration (the vendor CHECK already allowed both).
GitHub Copilot reads the enhanced billing usage report (organisation or enterprise, one request per day, Copilot
lines only; the token's scope cannot be verified, so it is stored as `unverified`). Cursor reads the Admin API's
filtered usage events (Basic auth with an `admin:*` key, so `write_capable` with the acknowledgement) and sums
charged cents per day, user email or service account, model, kind and product; users resolve by email. The gateway
meters neither vendor, so neither has a metered-overlap exclusion. Fake-vendor tests only; live keys wait for lane E11.
