# A private ECR repository for the RegulAIt images you mirror from the signed
# release (gateway, operator): immutable tags, scan on push, the stack key.
# Optional pull-through cache for public.ecr.aws (smoke-test images), so nodes
# never need internet egress to pull.

resource "aws_ecr_repository" "images" {
  for_each             = toset(["gateway", "operator"])
  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  tags                 = var.tags

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}

resource "aws_ecr_pull_through_cache_rule" "ecr_public" {
  count                 = var.ecr_pull_through_ecr_public ? 1 : 0
  ecr_repository_prefix = "${var.name_prefix}-ecr-public"
  upstream_registry_url = "public.ecr.aws"
}
