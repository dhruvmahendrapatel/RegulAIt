#!/usr/bin/env bash
# One-line-per-PR status for open non-dependabot PRs: head, draft, mergeable, failing checks, READY/verdicts at head.
R=repos/${REPO:-dhruvmahendrapatel/RegulAIt}
gh api "$R/pulls?state=open&per_page=100" --jq '.[]|select(.user.login!="dependabot[bot]")|"\(.number) \(.head.sha) \(.draft) \(.title[:46])"' | while read n sha dr title; do
  cm=$(gh api "$R/issues/$n/comments?per_page=100" --jq '[.[].body|split("\n")[0]|select(test("^(READY|APPROVE|REQUEST CHANGES|SECURITY APPROVE|SECURITY REQUEST CHANGES|SUPERSEDED) "))]')
  v=$(echo "$cm" | jq -r --arg s "$sha" '[.[]|select(contains($s))|sub(" at .*";"")|sub("SECURITY ";"S-")|sub("REQUEST CHANGES";"RC")]|unique|join("+")')
  f=$(gh api "$R/commits/$sha/check-runs?per_page=100" --jq '[.check_runs[]|select(.conclusion=="failure")|.name]|length')
  p=$(gh api "$R/commits/$sha/check-runs?per_page=100" --jq '[.check_runs[]|select(.status!="completed")]|length')
  echo "#$n ${sha:0:8} d=$dr fail=$f pend=$p [$v] $title"
done
