<!-- fold: pending -->

- **E22 sub-process catalogue: canvas palette.** Calling a sub-process from the builder's palette (and showing a call
  stage as one node) follows once the canvas (#893, #895) is on `main`. Until then a call stage is written in the
  stage's Advanced JSON or through the API.
- **E22: which template-version store is canonical** (ADR-0341 owner question 4): `workflow_template_versions` or E21's
  `config_versions` (#894). Sub-process pins key to `workflow_template_versions` meanwhile.
- **E22: the `all JS` ceiling** (owner question on #893) also covers this screen (+3 kB).
