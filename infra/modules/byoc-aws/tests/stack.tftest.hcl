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
    condition     = length(aws_networkfirewall_firewall.egress) == 1 && length(aws_nat_gateway.this) == 2 && length(aws_route.private_to_firewall) == 2 && length(aws_route.public_return_via_firewall) == 2
    error_message = "allow_list routes every zone's nodes through the firewall, both ways."
  }

  assert {
    condition     = aws_kms_key.data.enable_key_rotation
    error_message = "The stack key rotates."
  }

  assert {
    condition     = aws_ecr_repository.images["gateway"].image_tag_mutability == "IMMUTABLE"
    error_message = "Image tags are immutable."
  }

  assert {
    condition     = length(aws_iam_role_policy.gateway_bedrock) == 1
    error_message = "Listed models give the gateway a Bedrock grant."
  }
}

run "egress_none_has_no_internet_path" {
  command = plan

  variables {
    egress_mode = "none"
  }

  assert {
    condition     = length(aws_networkfirewall_firewall.egress) == 0 && length(aws_nat_gateway.this) == 0 && length(aws_eip.nat) == 0 && length(aws_route.private_to_firewall) == 0
    error_message = "egress_mode none creates no firewall, NAT or route out."
  }
}

run "no_bedrock_models_no_grant" {
  command = plan

  variables {
    bedrock_model_ids = []
  }

  assert {
    condition     = length(aws_iam_role_policy.gateway_bedrock) == 0
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
