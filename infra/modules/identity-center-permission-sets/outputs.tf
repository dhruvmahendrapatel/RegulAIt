output "deploy_builder_permission_set_arn" {
  value = aws_ssoadmin_permission_set.deploy_builder.arn
}

output "admin_break_glass_permission_set_arn" {
  value = aws_ssoadmin_permission_set.admin_break_glass.arn
}

output "readonly_audit_permission_set_arn" {
  value = aws_ssoadmin_permission_set.readonly_audit.arn
}
