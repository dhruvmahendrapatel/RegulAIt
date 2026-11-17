# Cross-region copies of a database's automated backups (ADR-0343: region loss,
# RPO about 5 minutes). Call it with the DESTINATION region's provider:
#
#   module "pg_backups_dr" {
#     source    = "../postgres-ha-aws/modules/cross-region-backups"
#     providers = { aws = aws.dr }
#     source_db_instance_arn = module.pg.db_instance_arn
#     kms_key_arn            = aws_kms_key.dr.arn
#   }
#
# A restore in the destination region is a point-in-time restore from these
# backups, started by hand: promotion across regions is not automatic.

terraform {
  required_version = ">= 1.11.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.59"
    }
  }
}

variable "source_db_instance_arn" {
  description = "The ARN of the RDS instance whose backups are copied."
  type        = string
}

variable "kms_key_arn" {
  description = "A customer-managed KMS key in the destination region."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "retention_days" {
  type    = number
  default = 14

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 35
    error_message = "retention_days must be 1-35."
  }
}

resource "aws_db_instance_automated_backups_replication" "this" {
  source_db_instance_arn = var.source_db_instance_arn
  retention_period       = var.retention_days
  kms_key_id             = var.kms_key_arn
}

output "id" {
  value = aws_db_instance_automated_backups_replication.this.id
}
