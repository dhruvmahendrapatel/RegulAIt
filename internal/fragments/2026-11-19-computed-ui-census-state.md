<!-- fold: state-recap -->
**2026-11-19 - The known-UI-gap count is computed ([ADR-0252](../decisions/0252-merge-queue-and-merge-time-numbering.md) addendum, owner "Computed counter", branch `builder/hotfix-computed-ui-census`).**
`KNOWN_UI_GAPS_MAX` and its test pin are removed. The route census's known gaps are one JSON file per ADR and lane in
`scripts/known-ui-gaps/`, each naming its owner lane and tracking issue or ADR. The count is the number of entries, so
two PRs that add API-only routes no longer conflict (M-118, superseded). A route with no screen and no entry still
fails, and an entry whose route now has a screen fails as "stale entry: delete it".
