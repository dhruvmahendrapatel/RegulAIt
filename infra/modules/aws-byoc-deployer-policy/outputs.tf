output "boundary_policy_arn" {
  description = "Attach as the permissions boundary of the deployer role."
  value       = aws_iam_policy.boundary.arn
}

output "workload_boundary_policy_arn" {
  description = "Every role the deployer creates must carry this boundary (pass it to byoc-aws as iam_permissions_boundary_arn)."
  value       = aws_iam_policy.workload_boundary.arn
}

output "boundary_policy_name" {
  value = aws_iam_policy.boundary.name
}

output "deployer_policy_json" {
  description = "The deployer's own permission policy (inline). Effective permissions are this intersected with the boundary."
  value       = data.aws_iam_policy_document.deployer.json
}

output "stack_role_name_prefix" {
  description = "IAM roles the stack creates must be named with this prefix."
  value       = "${var.name_prefix}-"
}
