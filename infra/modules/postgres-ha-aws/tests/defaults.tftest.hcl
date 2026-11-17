# Offline plan-only tests (mocked AWS provider). No AWS call is made.

mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1", name = "us-east-1" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111111111111" }
  }
}

variables {
  name                       = "app-pg"
  vpc_id                     = "vpc-0123456789abcdef0"
  subnet_ids                 = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  allowed_security_group_ids = ["sg-0cccccccccccccccc"]
  kms_key_arn                = "arn:aws:kms:us-east-1:111111111111:key/00000000-0000-0000-0000-000000000000"
}

run "secure_ha_defaults" {
  command = plan

  assert {
    condition     = module.db.db_instance_identifier != null && var.multi_az && var.deletion_protection && !var.skip_final_snapshot
    error_message = "Multi-AZ, deletion protection and a final snapshot are the defaults."
  }

  assert {
    condition     = var.backup_retention_days >= 7
    error_message = "Point-in-time recovery keeps at least a week by default."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.db) == 1 && aws_vpc_security_group_ingress_rule.db[0].from_port == 5432
    error_message = "The only ingress is 5432 from the named security groups."
  }
}

run "one_subnet_is_refused" {
  command = plan

  variables {
    subnet_ids = ["subnet-0aaaaaaaaaaaaaaaa"]
  }

  expect_failures = [var.subnet_ids]
}

run "no_backups_is_refused" {
  command = plan

  variables {
    backup_retention_days = 0
  }

  expect_failures = [var.backup_retention_days]
}

run "a_non_kms_key_is_refused" {
  command = plan

  variables {
    kms_key_arn = "alias/aws/rds"
  }

  expect_failures = [var.kms_key_arn]
}

run "nobody_may_connect_is_refused" {
  command = plan

  variables {
    allowed_security_group_ids = []
  }

  expect_failures = [var.allowed_security_group_ids]
}

run "an_existing_subnet_group_needs_no_subnets" {
  command = plan

  variables {
    subnet_ids           = []
    db_subnet_group_name = "existing-db-subnets"
  }

  assert {
    condition     = module.db.db_instance_identifier != null
    error_message = "A caller with its own subnet group (byoc-aws) passes the group, not subnets."
  }
}
