<!-- fold: state-decisions -->
**ADR-0242 (builder, 2026-11-07, Proposed): Cisco mcp-scanner and skill-scanner as offline admission-scan engines
(PENDING P23), phase 1.** Two ADR-0187 engines of a new kind `admission_scan` (`mcpscanner` 4.8.7, `skillscanner` 2.3.2),
registered off with no digest, so they cannot be enabled until phase 2 publishes the images. Our driver per engine
builds only the local analyzers, refuses any cloud/LLM/AI Defense/VirusTotal key, sets litellm's local price map
(measured: six connects without it, none with it) and checks the baked rule digest; the images are hash-locked, pass a
licence gate and an in-image `--network=none` smoke scan (built and run locally). yara-python is built from its sdist
without OpenSSL (its wheel bundles EOL 1.1.1w); pcodedmp (GPL-3.0) is excluded. Verdicts land in
`admission_engine_scans` (pending migration `admission_engine_scans`) and flow into the MCP and skill admission states and audit; with an engine
on, only a `pass` for the current digest admits (fail closed). Skills enter through builder create, SKILL.md import,
update, template seeding and agent-bundle import; there is no plugin upload yet. Phase 2: the runner stage and
`subject` target, queueing, publish, UI (#453). Four owner questions in the ADR.
