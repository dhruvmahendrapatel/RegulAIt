<!-- fold: state-recap -->
**C1, CI gateway build handoff (ADR-0350, 2026-11-17).** The existing base job's workspace build produces a same-run
artifact of gateway and package outputs; the five gateway shards and the web-only reader runner verify its exact
artifact ID, archive digest, source, lockfile and runtime before restoring it. No shard compiler or cache fallback
remains. Existing shard, exact-once coverage, uniqueness and required aggregate gates stay in place. This removes
repeated compilation but makes shards wait for the base job; hosted timings, not local fixtures, determine the net
scheduling effect. The PR's builder report carries the measured runs and validation results.
