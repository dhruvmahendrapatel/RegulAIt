# Fragments (ADR-0252)

STATE.md and PENDING.md are not edited on a branch any more where several lanes append to the same place. Add one
file here per entry instead. After the merge, the assign-at-merge step (`scripts/assign-at-merge.mjs`) moves each
fragment to its marker and deletes the file, in one bot pull request.

- Name: `<YYYY-MM-DD>-<lane-or-pr>-<slug>.md`. Fragments for one marker go in name order (newest first where the
  marker says so), so the date prefix keeps them in time order.
- First line: the marker the fragment goes to, then the text.

| First line | Goes to |
|---|---|
| `<!-- fold: state-recap -->` | STATE.md, the top of "Where we are" (newest first) |
| `<!-- fold: state-decisions -->` | STATE.md, the end of "Decisions" |
| `<!-- fold: pending -->` | PENDING.md, §0 "New items" (newest first) |

The ADR index needs no fragment: the step adds the row from the ADR file's own header (`# ADR-NNNN: Title`,
`- **Status**:`, `- **Date**:`, or `- **Index**:` for a shorter title cell).

Edits to an existing paragraph or row stay ordinary edits; only appends move here.
