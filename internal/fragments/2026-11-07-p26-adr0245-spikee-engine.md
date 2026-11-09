<!-- fold: state-decisions -->
**ADR-0245 (builder, 2026-11-07): Spikee and PyRIT as sidecar red-team engines (backlog P26).** Spikee 0.9.4
(Apache-2.0, indirect prompt injection in documents) is built as an ADR-0187 / ADR-0190 I5 engine: a pinned,
hash-locked, licence-gated image built in CI, a gateway-only workspace target, off and `not_built` until its first
signed publish (a null lock entry, so nothing can enable it before then). Its unused `datasets` requirement and the 18
packages only it needs are left out of the image (fsspec CVE-2026-104851), removed rather than allow-listed. PyRIT
1.1.0 is designed in the ADR (attacker and scorer = the run's judge through the gateway, every attack `offensive`) but
NOT built: two builder attempts were stopped by a content-safety filter; the partial work is on
`builder/p26-pyrit-wip`, and `pyrit` is in no runtime list. The pending migration `spikee_engine_and_engine_retest`
widens `engines_id_check`, seeds spikee and gives the ADR-0217 auto re-test a third kind, `engine`
(`mrm_retest_runs.engine_run_id`), which repeats a person's red-team engine runs of any engine after a model change and
settles in the transaction that ends the run. The lock reader treats an engine missing from an older base lock as never
published. The agentic_security coverage diff added nothing (multimodal recorded as the one gap). Open: finishing
PyRIT, owner confirmation of the eight reused licence acceptances, Spikee's LLM judge through the gateway, a governed
multimodal route, and the UI (#453).
