# demo-sandbox / gitlab: a demo group's repositories for real-account repo
# discovery (ADR-0197 decision 5). Runbook: docs/deployment/DEMO_REAL_ACCOUNTS.md.
#
# The group is created by its owner in the GitLab UI first (a top-level group
# on gitlab.com belongs to a person and carries the subscription). This stack
# creates four private projects in it, seeded from infra/demo-fixtures/gitlab
# (fictional demo company, AI SDKs, env-var NAMES only), and a group access
# token with read_api and read_repository only, output as a sensitive value
# that the owner copies into RegulAIt (where it is stored encrypted).
#
# GitLab.com: group access tokens need the group on a Premium or Ultimate
# subscription and are not available on a trial. Without one, set
# create_group_access_token = false and use the fallback in the runbook.
#
# Cost: none (private projects, CI disabled on every project).

module "demo_repos" {
  source = "../../../modules/gitlab-seeded-projects"

  group_full_path = var.gitlab_group_full_path
  fixtures_root   = "${path.root}/../../../demo-fixtures/gitlab"

  projects = {
    "support-assistant" = {
      description = "Larkfield Outfitters (fictional): support reply drafter."
      fixture_dir = "support-assistant"
    }
    "invoice-summariser" = {
      description = "Larkfield Outfitters (fictional): supplier invoice summariser."
      fixture_dir = "invoice-summariser"
    }
    "catalog-enrichment" = {
      description = "Larkfield Outfitters (fictional): product catalogue enrichment."
      fixture_dir = "catalog-enrichment"
    }
    "ops-toolkit" = {
      description = "Larkfield Outfitters (fictional): warehouse operations scripts."
      fixture_dir = "ops-toolkit"
    }
  }

  create_group_access_token = var.create_group_access_token
  token_name                = "regulait-ai-discovery-read-only"
  token_expires_at          = var.token_expires_at
}
