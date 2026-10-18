# The provider reads its token from the GITLAB_TOKEN environment variable: the
# applying person's own short-lived personal access token (scope `api`), set
# in their shell for the apply and never written to a file in this repository.
provider "gitlab" {
  base_url = var.gitlab_base_url
}
