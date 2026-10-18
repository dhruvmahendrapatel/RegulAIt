output "group_id" {
  value = data.gitlab_group.this.group_id
}

output "project_paths" {
  description = "group/project paths, as a repo scanner names them."
  value       = [for p in gitlab_project.this : p.path_with_namespace]
}

output "group_access_token" {
  description = "The read-only scanner token. Sensitive: read it with `terraform output -raw`, never print it to a log."
  value       = var.create_group_access_token ? gitlab_group_access_token.scanner[0].token : null
  sensitive   = true
}
