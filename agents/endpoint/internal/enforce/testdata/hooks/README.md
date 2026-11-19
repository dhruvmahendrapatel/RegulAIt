# Versioned hook contract fixtures (ADR-0330)

Layout: `<agent>/<contract-version>/`, one directory per vendor contract as checked. The version is the adapter's
`Contract.Version` (the date the contract was checked against the vendor's documentation). Each directory holds:

- one file per hook input, exactly as the agent writes it to the hook's stdin;
- `cases.json`, which lists every input with the test policy (`enforce`, `audit`, or `none`, meaning no valid policy)
  and the expected answer: `none` (no output, exit 0), `allow` (an explicit allow, exit 0), or `deny` (the agent's
  deny JSON and exit 2).

Rules, which the shared tests enforce:

- **Coverage.** Every adapter has a directory for its current contract version, every input file is listed in
  `cases.json`, and every version has at least one deny and one no-policy case.
- **No edits in place.** When a vendor's contract changes, add a new version directory and bump the adapter's
  `Contract.Version`. Never edit an old directory's input files. Old directories stay, and they keep passing, so a
  contract change cannot silently break agents still on the older version. An expected answer in `cases.json` changes
  only when an ADR changes what we decide: ADR-0350 made built-in shell calls governed, so four old cases changed
  (`builtin-bash`/`builtin-shell` with no policy now deny; Cursor's `shell-event` is now decided).
- **Arguments stay private.** Inputs carry `"secret-argument"` inside tool arguments (or, for Cursor, inside the stdio
  launch command), and the tests assert that it never reaches hook output.

**Provenance.** Where a vendor's docs give a literal example, it is used as is. `copilot-cli/2026-11-15/builtin-bash.json`
is the docs' own test payload, and it carries no argument marker. The other vendors document only a field table or a
template, so their inputs fill those documented fields with made-up values.
