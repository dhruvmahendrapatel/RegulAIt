<!-- fold: pending -->

- **Move the four older engines onto engine-runner's shared helpers (ADR-0242 L4.4, #874 review).** garak, spikee,
  modelscan and promptfoo each still carry their own job-directory exchange (`jobDirRunId`, staging to live, the cancel
  poll, release, reconcile) in `src/exchange.ts`, and garak and spikee their own worker self-test in `src/selftest.ts`.
  Replace them with `@regulait/engine-runner`'s `JobExchange` and worker self-test helpers (`workerSelfTestSchema`,
  `observeWorkerSandbox`, `writeWorkerSelfTestFile`, `readWorkerSelfTest`, `workerSelfTestFresh`,
  `workerIsolationFailures`), keeping each engine's done-file schema, job files and switches in its package. Note the
  shared `release` also removes the run's results directory, which none of the four copies does today (decide per engine whether its worker or the runner owns that removal).
