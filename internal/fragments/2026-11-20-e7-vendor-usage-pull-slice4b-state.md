<!-- fold: state-recap -->

**2026-11-20 - ADR-0322 slice 4b: ChatGPT Enterprise and Codex usage for the vendor usage pull (builder lane E7).**
A new `openai_codex` connector reads ChatGPT Enterprise's Daily Usage endpoint (ChatGPT, Codex and Work usage, per
user, day and client) through the guarded fetch, checked against the vendor's OpenAPI document 2.5.43. Credit-priced
usage is recorded at the vendor's USD estimate and marked as an estimate; native USD usage is recorded as reported;
a row with credits and no estimate is counted in the batch summary, not imported. People resolve by exact email. The
key's scope cannot be read back, so storing it needs the unverified-scope attestation. Owner decisions 2026-11-20 in
the ADR; no route, migration or dependency added. The AWS principal mode and Parquet are slice 4c.
