output "regulait_source_target" {
  description = "Target fields for the repo_gitlab discovery source."
  value = {
    namespace = var.gitlab_group_full_path
  }
}

output "regulait_source_scope_include" {
  description = "The repositories, if the source is scoped to named repos instead of the whole group."
  value       = module.demo_repos.project_paths
}

output "scanner_token" {
  description = "Read-only group access token. Read it only with `terraform output -raw scanner_token` piped to the clipboard; never print it to a log."
  value       = module.demo_repos.group_access_token
  sensitive   = true
}
