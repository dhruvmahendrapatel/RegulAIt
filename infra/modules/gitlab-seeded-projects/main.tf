# gitlab-seeded-projects: private projects in an existing GitLab group, each
# seeded with the files of one local fixture directory, plus (optionally) a
# read-only group access token for a scanner.
#
# The group itself is not created here: on GitLab.com a top-level group is
# created in the UI by its owner, who also holds its subscription. Group access
# tokens on GitLab.com need the group on a Premium or Ultimate subscription (not
# a trial); with create_group_access_token = false no token is created and the
# caller supplies a read-only token another way.
#
# The token is read-only by construction: scopes read_api and read_repository,
# access level Reporter, and an expiry date. Its value exists only in the
# Terraform state and the sensitive output.

data "gitlab_group" "this" {
  full_path = var.group_full_path
}

locals {
  files = merge([
    for key, p in var.projects : {
      for f in fileset("${var.fixtures_root}/${p.fixture_dir}", "**") :
      "${key}/${f}" => {
        project = key
        path    = f
        source  = "${var.fixtures_root}/${p.fixture_dir}/${f}"
      }
    }
  ]...)
}

resource "gitlab_project" "this" {
  for_each = var.projects

  name                   = each.key
  path                   = each.key
  description            = each.value.description
  namespace_id           = data.gitlab_group.this.group_id
  visibility_level       = "private"
  initialize_with_readme = true
  default_branch         = "main"

  # Nothing in these demo projects should run or publish anything.
  builds_access_level             = "disabled"
  packages_enabled                = false
  container_registry_access_level = "disabled"
  pages_access_level              = "disabled"
  wiki_access_level               = "disabled"
  snippets_access_level           = "disabled"
  shared_runners_enabled          = false
  permanently_delete_on_destroy   = true
}

resource "gitlab_repository_file" "this" {
  for_each = local.files

  project             = gitlab_project.this[each.value.project].id
  branch              = "main"
  file_path           = each.value.path
  encoding            = "text"
  content             = file(each.value.source)
  commit_message      = "Seed ${each.value.path}"
  overwrite_on_create = true
}

resource "gitlab_group_access_token" "scanner" {
  count = var.create_group_access_token ? 1 : 0

  group        = data.gitlab_group.this.group_id
  name         = var.token_name
  description  = "Read-only scanner token (read_api, read_repository)."
  scopes       = ["read_api", "read_repository"]
  access_level = "reporter"
  expires_at   = var.token_expires_at
}
