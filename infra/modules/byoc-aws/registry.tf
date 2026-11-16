# A private ECR repository for each RegulAIt image you mirror from the signed
# release (gateway, operator): immutable tags, scan on push, the stack key,
# never force-deleted. Optional pull-through cache for public.ecr.aws
# (smoke-test images), so nodes never need internet egress to pull.
# Built with terraform-aws-modules/ecr (ADR-0176).

module "ecr" {
  source   = "terraform-aws-modules/ecr/aws"
  version  = "3.2.1"
  for_each = toset(["gateway", "operator"])

  repository_name                 = "${var.name_prefix}/${each.key}"
  repository_image_tag_mutability = "IMMUTABLE"
  repository_image_scan_on_push   = true
  repository_encryption_type      = "KMS"
  repository_kms_key              = module.kms.key_arn
  repository_force_delete         = false

  # Access is through IAM (the node role's ECR read policy); no repository
  # policy is needed. Release images are kept: no lifecycle expiry.
  create_repository_policy = false
  attach_repository_policy = false
  create_lifecycle_policy  = false

  tags = var.tags
}

module "ecr_pull_through" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "3.2.1"
  create  = var.ecr_pull_through_ecr_public

  create_repository = false
  registry_pull_through_cache_rules = {
    ecr_public = {
      ecr_repository_prefix = "${var.name_prefix}-ecr-public"
      upstream_registry_url = "public.ecr.aws"
    }
  }

  tags = var.tags
}
