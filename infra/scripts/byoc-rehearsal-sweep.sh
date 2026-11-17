#!/usr/bin/env bash
# Rehearsal clean-up around `terraform destroy` (ADR-0325). regulait-dev only.
#
#   byoc-rehearsal-sweep.sh pre-destroy  <prefix>   empty what Terraform cannot:
#       the rehearsal audit bucket (GOVERNANCE locks, bypassed: the rehearsal
#       role may, the gateway role may not) and the pull-through cache repos.
#   byoc-rehearsal-sweep.sh leftovers    <prefix>   list anything still tagged
#       purpose=rehearsal besides the standing role, boundary and provider;
#       exit 1 if there is any.
#
# Refuses any prefix that is not regulait-rehearsal*, so it can never empty a
# real audit bucket.
set -uo pipefail
cmd="${1:-}" prefix="${2:-}"
case "$prefix" in regulait-rehearsal*) ;; *) echo "refusing prefix '$prefix': rehearsal prefixes only" >&2; exit 2 ;; esac
export AWS_PAGER=""
account="$(aws sts get-caller-identity --query Account --output text)" || exit 2

case "$cmd" in
  pre-destroy)
    bucket="$prefix-audit-anchors-$account"
    if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
      mode="$(aws s3api get-object-lock-configuration --bucket "$bucket" --query ObjectLockConfiguration.Rule.DefaultRetention.Mode --output text 2>/dev/null)"
      if [ "$mode" != "GOVERNANCE" ]; then echo "bucket $bucket is $mode, not GOVERNANCE: not touching it" >&2; exit 1; fi
      # Each pass lists from the start (no continuation token) and deletes
      # what it listed, so the next pass sees the rest. That is correct only
      # because every pass deletes; stop as soon as a pass finds nothing.
      while :; do
        batch="$(aws s3api list-object-versions --bucket "$bucket" --max-items 500 --output json \
          --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] }')"
        n="$(jq '.Objects | length' <<<"$batch")"
        [ "$n" -gt 0 ] || break
        aws s3api delete-objects --bucket "$bucket" --bypass-governance-retention --delete "$(jq -c '. + {Quiet: true}' <<<"$batch")" >/dev/null || exit 1
        echo "deleted $n object versions from $bucket"
      done
    fi
    for r in $(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName, '$prefix-ecr-public/')].repositoryName" --output text); do
      aws ecr delete-repository --repository-name "$r" --force >/dev/null && echo "deleted cache repository $r"
    done
    ;;
  leftovers)
    left="$(aws resourcegroupstaggingapi get-resources --tag-filters Key=purpose,Values=rehearsal \
      --query 'ResourceTagMappingList[].ResourceARN' --output json |
      jq -r '.[] | select(test(":role/gh-actions-regulait-rehearsal$|:policy/regulait-rehearsal-byoc-(workload-)?boundary$|:oidc-provider/token.actions.githubusercontent.com$") | not)')"
    # Roles are global and the tagging API can miss them: list the prefix too.
    left="$left"$'\n'"$(aws iam list-roles --query "Roles[?starts_with(RoleName, '$prefix-')].Arn" --output text | tr '\t' '\n')"
    # The tagging API keeps deleted resources for a while; confirm a few kinds directly.
    live=""
    for arn in $left; do
      case "$arn" in
        *":log-group:"*) aws logs describe-log-groups --log-group-name-prefix "${arn##*:log-group:}" --query 'logGroups[0]' --output text 2>/dev/null | grep -qv None && live+="$arn"$'\n' ;;
        *) live+="$arn"$'\n' ;;
      esac
    done
    if [ -n "${live//[$'\n']/}" ]; then printf 'still tagged purpose=rehearsal:\n%s' "$live"; exit 1; fi
    echo "no rehearsal resources left"
    ;;
  *) echo "usage: $0 pre-destroy|leftovers <prefix>" >&2; exit 2 ;;
esac
