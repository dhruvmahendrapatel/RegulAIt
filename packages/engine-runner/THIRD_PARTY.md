# Third-party components — `@regulait/engine-runner`

Open-source components this package ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained; pinned;
works air-gapped). npm dependencies are pinned through `pnpm-lock.yaml`. The package runs inside every engine image (the
promptfoo image lists the same rows in `engines/promptfoo/THIRD_PARTY.md`).

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `write-file-atomic` (npm, github.com/npm/write-file-atomic, © npm, Inc.) | `8.0.0` (exact; released 2026-05-08) | ISC | ADR-0187 decision 96 (PR #205 review round 13). Every persisted runner file — the runner token, the pending enrolment record, a retained result envelope — is written to a temp file beside the target, fsynced, given mode 0600 and renamed over the target (`src/durable.ts`), so a crash never leaves a truncated file. The one step it does not take, fsyncing the containing directory after the rename, is added in `src/durable.ts`. Pure JavaScript, no install script, no network. |
| `signal-exit` (npm, github.com/tapjs/signal-exit, © Ben Coe and contributors) | `4.1.0` (as locked; released 2023-07-29) | ISC | The only dependency of `write-file-atomic` (removes its temp file if the process exits mid-write). Transitive and unchanged since 2023: a small, stable module with no open advisory, maintained under the same npm/tapjs maintainers; already in our lockfile through other packages. Recorded here because it ships; re-checked with `write-file-atomic` upgrades. |
