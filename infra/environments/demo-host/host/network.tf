# --- network (ADR-0228, security-team addendum) -----------------------------------
#
# A dedicated VPC instead of the default one:
#   - the instance sits in a PRIVATE subnet with no public IPv4 and no inbound
#     security-group rule; its egress is 443/tcp plus 7844/tcp+udp (cloudflared);
#   - one NAT gateway in a public subnet carries that egress (the on-host build
#     pulls packages and images; the tunnel dials Cloudflare);
#   - interface endpoints for ssm, ssmmessages, ec2messages, kms and logs, and an
#     S3 gateway endpoint, keep AWS control traffic on the AWS network;
#   - VPC Flow Logs (all traffic) to a KMS-encrypted CloudWatch log group.
# Open source first: terraform-aws-modules/vpc (Apache-2.0), pinned; infra/THIRD_PARTY.md.
# Single AZ: a demo host, not HA (Fargate/HA come after the demo).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  az = data.aws_availability_zones.available.names[0]
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name = local.name
  cidr = var.vpc_cidr

  azs             = [local.az]
  private_subnets = [cidrsubnet(var.vpc_cidr, 8, 1)]
  public_subnets  = [cidrsubnet(var.vpc_cidr, 8, 101)]

  enable_nat_gateway      = true
  single_nat_gateway      = true
  map_public_ip_on_launch = false
  enable_dns_hostnames    = true
  enable_dns_support      = true

  # The default security group, NACL and route table are taken over and left
  # with no rules, so nothing can be launched into an open default.
  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []

  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_traffic_type                           = "ALL"
  flow_log_max_aggregation_interval               = 60
  flow_log_cloudwatch_log_group_name_prefix       = "/regulait/demo-host/flow-logs/"
  flow_log_cloudwatch_log_group_retention_in_days = var.log_retention_days
  flow_log_cloudwatch_log_group_kms_key_id        = aws_kms_key.host.arn
}

resource "aws_security_group" "endpoints" {
  name        = "${local.name}-endpoints"
  description = "HTTPS from inside the VPC to the AWS interface endpoints"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description = "https-from-vpc"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}

module "endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "6.7.3"

  vpc_id = module.vpc.vpc_id

  endpoints = merge(
    {
      for svc in ["ssm", "ssmmessages", "ec2messages", "kms", "logs"] : svc => {
        service             = svc
        private_dns_enabled = true
        subnet_ids          = module.vpc.private_subnets
        security_group_ids  = [aws_security_group.endpoints.id]
        tags                = { Name = "${local.name}-${svc}" }
      }
    },
    {
      s3 = {
        service         = "s3"
        service_type    = "Gateway"
        route_table_ids = module.vpc.private_route_table_ids
        tags            = { Name = "${local.name}-s3" }
      }
    },
  )
}
