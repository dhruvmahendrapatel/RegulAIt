<!-- fold: state-recap -->

**2026-11-15 - ADR-0322 slice 2: vendor usage/cost pull foundation, Anthropic and OpenAI (builder lane E7).**
Off by default (org policy singleton, step-up to turn on, refused when air-gapped); connectors start disabled;
credentials are encrypted, write-capable keys need an acknowledgement, never returned. Anthropic cost report (guarded
fetch) and OpenAI costs (official SDK) pull into imported lines (`origin = 'pull'`), upserted per vendor fact; lines
billed to the gateway's own workspace, key or project are excluded from the consolidated imported side and disclosed.
Migration `pending/vendor_usage_pull.sql` (numbered at merge). Nine API-only routes, known UI gaps on #453.
