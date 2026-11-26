# Offline plan-only tests (mocked AWS provider): the stack's secure defaults
# and the shape of each egress mode. No AWS call is made.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111", arn = "arn:aws:iam::111111111111:role/installer" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1", name = "us-east-1" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_iam_session_context" {
    defaults = { issuer_arn = "arn:aws:iam::111111111111:role/installer" }
  }
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { entries = [{ cidr = "52.216.0.0/15", description = "" }] }
  }
}

variables {
  name_prefix       = "regulait-test"
  bedrock_model_ids = ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"]
}

run "secure_defaults" {
  command = plan

  assert {
    condition     = var.db_deletion_protection && !var.db_skip_final_snapshot && var.db_multi_az && var.db_backup_retention_days >= 7
    error_message = "The database must default to deletion protection, a final snapshot, Multi-AZ and a week or more of backups."
  }

  assert {
    condition     = var.audit_object_lock_mode == "COMPLIANCE" && length(var.cluster_endpoint_public_access_cidrs) == 0
    error_message = "Audit anchors default to COMPLIANCE and the Kubernetes API to private only."
  }

  assert {
    condition     = var.egress_mode == "allow_list" && join(",", var.egress_allowed_domains) == "login.microsoftonline.com"
    error_message = "Egress defaults to the allow-list with only Entra ID sign-in on it."
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 2 && length(aws_route.private_to_firewall) == 2 && length(aws_route.public_return_via_firewall) == 2
    error_message = "allow_list routes every zone's nodes through the firewall, both ways."
  }

  assert {
    condition     = var.firewall_delete_protection
    error_message = "The firewall defaults to delete protection."
  }

  assert {
    condition     = module.gateway_pod_identity.iam_policy_name == "regulait-test-gateway" && module.gateway_pod_identity.iam_role_name == "regulait-test-gateway"
    error_message = "Listed models give the gateway its own Bedrock policy, named inside the stack prefix."
  }

  assert {
    condition     = module.ebs_csi_pod_identity.iam_role_name == "regulait-test-ebs-csi" && module.ebs_csi_pod_identity.iam_policy_name == "regulait-test-ebs-csi"
    error_message = "The EBS CSI role and policy are named inside the stack prefix, so the installer boundary covers them."
  }

  assert {
    condition     = module.lb_controller_pod_identity.iam_role_name == "regulait-test-lb-controller" && module.lb_controller_pod_identity.iam_policy_name == "regulait-test-lb-controller"
    error_message = "The Load Balancer Controller role and its upstream-maintained policy are on by default and named inside the stack prefix."
  }

  assert {
    condition     = var.operator_backups && module.backup_pod_identity.iam_role_name == "regulait-test-operator-backup" && module.backup_target[0].bucket == "regulait-test-backups-111111111111"
    error_message = "Operator backups are on by default, with a write-only role and a bucket named inside the stack prefix."
  }

  assert {
    condition     = module.backup_target[0].prefix == "pg" && module.backup_target[0].alarm_name == null
    error_message = "Backups land under pg/, and no always-red heartbeat alarm is created for a Job that publishes none."
  }
}

run "egress_none_has_no_internet_path" {
  command = plan

  variables {
    egress_mode = "none"
  }

  assert {
    condition     = module.network_firewall.arn == null && module.egress_domains.arn == null && length(aws_nat_gateway.this) == 0 && length(aws_eip.nat) == 0 && length(aws_route.private_to_firewall) == 0
    error_message = "egress_mode none creates no firewall, NAT or route out."
  }
}

run "no_bedrock_models_no_grant" {
  command = plan

  variables {
    bedrock_model_ids = []
  }

  assert {
    condition     = module.gateway_pod_identity.iam_policy_name == null
    error_message = "No listed model, no Bedrock grant."
  }
}

run "public_api_to_everyone_is_refused" {
  command = plan

  variables {
    cluster_endpoint_public_access_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.cluster_endpoint_public_access_cidrs]
}

run "wildcard_egress_domain_is_refused" {
  command = plan

  variables {
    egress_allowed_domains = ["*.example.com"]
  }

  expect_failures = [var.egress_allowed_domains]
}

run "no_ingress_controller_no_role" {
  command = plan

  variables {
    ingress_controller = false
  }

  assert {
    condition     = module.lb_controller_pod_identity.iam_role_name == null
    error_message = "No Load Balancer Controller role when ingress_controller is off."
  }
}

run "backups_off_creates_no_bucket_or_role" {
  command = plan

  variables {
    operator_backups = false
  }

  assert {
    condition     = length(module.backup_target) == 0 && module.backup_pod_identity.iam_role_name == null && output.backup_spec == null
    error_message = "With operator_backups = false there is no backup bucket, role or spec."
  }
}
