# app-instance — a single EC2 box that boots, pulls a source tarball from S3,
# and runs it with `docker compose up -d --build`. Dev-grade by design: one
# instance, no ALB/ASG. Access for operators is SSM Session Manager only —
# no SSH keypair exists.
#
# TLS terminates INSIDE the box (ADR-0029): the compose stack runs a Caddy
# reverse proxy on 80/443 in front of the app, so this module opens the ports
# the caller asks for and stays agnostic about what listens on them. There is
# still no ALB and no ACM certificate — nothing here costs money.

data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id

  # The address callers should actually use. With an Elastic IP this is the EIP
  # (stable across stop/start); without one it is whatever EC2 handed out this
  # boot (ephemeral — see aws_eip.app below).
  effective_public_ip = var.assign_elastic_ip ? aws_eip.app[0].public_ip : aws_instance.app.public_ip

  # Backwards-compatible: callers that never set ingress_ports keep the old
  # single-port behaviour (open app_port). Callers that terminate TLS on-box
  # pass [80, 443] and app_port stops being an ingress port at all.
  ingress_ports = length(var.ingress_ports) > 0 ? var.ingress_ports : [var.app_port]

  # ADR-0228: with ingress_enabled = false the security group has NO ingress
  # rule at all (SSM and an outbound-only tunnel need none).
  effective_ingress_ports = var.ingress_enabled ? local.ingress_ports : []

  host_only = var.boot_mode == "host_only"

  # Nitro instances expose an EBS volume as NVMe with the volume id, minus its
  # dash, as the serial; user-data finds the data disk by it, never by name.
  data_volume_serial = var.data_volume_size_gb > 0 ? replace(aws_ebs_volume.data[0].id, "-", "") : ""
}

data "aws_subnets" "in_vpc" {
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

data "aws_region" "current" {}

# The subnet the instance lands in, read back so the data volume can be created
# in the same availability zone before the instance exists.
data "aws_subnet" "chosen" {
  id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.in_vpc.ids[0]
}

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

# --- source bundle bucket -----------------------------------------------------

resource "aws_s3_bucket" "source" {
  bucket        = var.source_bucket_name
  force_destroy = true
  tags          = var.tags
}

resource "aws_s3_bucket_server_side_encryption_configuration" "source" {
  count  = var.kms_key_arn == null ? 0 : 1
  bucket = aws_s3_bucket.source.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

# Versioned: an overwritten or deleted bundle stays recoverable, so the deployed
# commit can always be matched to the object it came from (ADR-0228).
resource "aws_s3_bucket_versioning" "source" {
  bucket = aws_s3_bucket.source.id
  versioning_configuration {
    status = "Enabled"
  }
}

# TLS only: every request over plain HTTP is refused (security checklist).
resource "aws_s3_bucket_policy" "source_tls_only" {
  bucket = aws_s3_bucket.source.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.source.arn, "${aws_s3_bucket.source.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.source]
}

resource "aws_s3_bucket_public_access_block" "source" {
  bucket                  = aws_s3_bucket.source.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- instance role: SSM + read-only on the bundle -----------------------------

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  # ADR-0228: a caller whose deployer may only create bounded roles passes the
  # boundary here; null (the default) keeps the original unbounded role.
  permissions_boundary = var.permissions_boundary
  tags                 = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "read_source" {
  name = "read-source-bundle"
  role = aws_iam_role.instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.source.arn}/*"
      }, {
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.source.arn
      }], var.kms_key_arn == null ? [] : [{
      # Read the KMS-encrypted bundle, and only through S3.
      Effect    = "Allow"
      Action    = ["kms:Decrypt"]
      Resource  = var.kms_key_arn
      Condition = { StringEquals = { "kms:ViaService" = "s3.${data.aws_region.current.region}.amazonaws.com" } }
    }])
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = var.tags
}

# --- network ------------------------------------------------------------------

resource "aws_security_group" "app" {
  name = "${var.name}-app"
  # NOTE: the wording is load-bearing. `description` is ForceNew on
  # aws_security_group, so editing this string replaces the SG for no
  # functional gain. Left at the original text deliberately.
  description = "App port in, everything out"
  vpc_id      = local.vpc_id
  tags        = var.tags

  dynamic "ingress" {
    for_each = toset(local.effective_ingress_ports)
    content {
      description = "app-${ingress.value}"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.ingress_cidrs
    }
  }

  # HTTP/3 (QUIC) on 443/udp, only when 443 is one of the TCP ingress ports.
  # Caddy advertises h3 via Alt-Svc; without this the browser silently falls
  # back to TCP, so it is an optimisation, not a requirement.
  dynamic "ingress" {
    for_each = contains(local.effective_ingress_ports, 443) ? [443] : []
    content {
      description = "http3-quic"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "udp"
      cidr_blocks = var.ingress_cidrs
    }
  }

  # ADR-0228: egress_rules narrows outbound traffic; the default keeps the
  # original allow-all for existing callers.
  dynamic "egress" {
    for_each = var.egress_rules
    content {
      description = egress.value.description
      from_port   = egress.value.from_port
      to_port     = egress.value.to_port
      protocol    = egress.value.protocol
      cidr_blocks = egress.value.cidr_blocks
    }
  }

  # With the on-box TLS front, the app port is loopback-only on the host and
  # must never be an ingress port: opening it would serve the app in cleartext
  # around the proxy (ADR-0029, ADR-0202 lane H). Refused at plan time.
  lifecycle {
    precondition {
      condition     = !var.enable_onbox_tls || !contains(local.ingress_ports, var.app_port)
      error_message = "enable_onbox_tls is true, so app_port (${var.app_port}) must not be in ingress_ports; open only 80 and 443."
    }
  }
}

# --- instance -----------------------------------------------------------------

resource "aws_instance" "app" {
  # pinned when var.ami_id is set; see variables.tf for why the SSM "latest"
  # lookup is a data-loss hazard on a stateful single-instance stack
  ami                    = coalesce(var.ami_id, nonsensitive(data.aws_ssm_parameter.al2023_ami.value))
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.chosen.id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  tags                   = merge(var.tags, { Name = var.name })

  # null keeps the subnet's own setting; false gives the instance no public IPv4.
  associate_public_ip_address = var.associate_public_ip_address
  disable_api_termination     = var.disable_api_termination

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = var.imds_hop_limit
  }

  # Encrypted always (ADR-0180, ADR-0228); with kms_key_arn null the account's
  # AWS-managed EBS key is used.
  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    kms_key_id            = var.kms_key_arn
    delete_on_termination = true
  }

  # Editing user-data must NOT destroy the box: on aws_instance a user_data
  # change forces replacement by default, and this instance holds the database.
  # Changes therefore apply on the next boot; a redeploy of the app itself goes
  # through SSM, not through recreating the machine.
  user_data_replace_on_change = false

  user_data = local.host_only ? templatefile("${path.module}/user-data-host-only.sh.tftpl", {
    swap_gb            = var.swap_gb
    data_volume_serial = local.data_volume_serial
    data_volume_mount  = var.data_volume_mount
    log_group_name     = var.log_group_name
    region             = data.aws_region.current.region
    compose_version    = var.compose_plugin_version
    compose_sha256     = var.compose_plugin_sha256
    }) : templatefile("${path.module}/user-data.sh.tftpl", {
    bucket           = aws_s3_bucket.source.bucket
    object_key       = var.source_object_key
    swap_gb          = var.swap_gb
    enable_onbox_tls = var.enable_onbox_tls
  })

  lifecycle {
    precondition {
      condition     = !local.host_only || !var.enable_onbox_tls
      error_message = "boot_mode host_only does not start the stack, so enable_onbox_tls must be false."
    }
    precondition {
      condition     = var.data_volume_size_gb == 0 || local.host_only
      error_message = "data_volume_size_gb is supported with boot_mode host_only only."
    }
  }

  # The bundle is uploaded out-of-band after apply; user-data waits for it.
  depends_on = [aws_iam_role_policy.read_source]
}

# --- stable public address (optional) -----------------------------------------
#
# WHY THIS EXISTS: an auto-assigned public IPv4 is released on every STOP and a
# different one is handed out on the next START. Any name, certificate, firewall
# rule or bookmark derived from that address silently breaks the moment the box
# is power-cycled — which is exactly what a stop/start cost schedule does on
# purpose, every single weekday. An Elastic IP survives stop/start, so the
# address (and anything derived from it) is stable across the whole cycle.
#
# COST: since 2024-02-01 AWS bills EVERY public IPv4 at ~$0.005/hr, in-use or
# idle. So while the instance RUNS an EIP costs exactly what the auto-assigned
# address already cost — the only new money is the idle hours while the box is
# stopped. See infra/modules/scheduled-power/README.md for the arithmetic.
#
# CAUTION: `terraform destroy` releases this address for good; a re-created EIP
# is a DIFFERENT address. Anything pinned to it (DNS, certs) has to be re-pointed.
resource "aws_eip" "app" {
  count = var.assign_elastic_ip ? 1 : 0

  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name}-eip" })
}

resource "aws_eip_association" "app" {
  count = var.assign_elastic_ip ? 1 : 0

  allocation_id = aws_eip.app[0].id
  instance_id   = aws_instance.app.id
}

# --- data volume (optional, ADR-0228) -----------------------------------------
#
# A separate encrypted EBS volume mounted at data_volume_mount (by default
# /var/lib/docker, so every container volume, Postgres included, lives on it).
# It is its own resource, so replacing the instance does NOT destroy it: a new
# instance re-attaches and mounts the same filesystem.
resource "aws_ebs_volume" "data" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  availability_zone = data.aws_subnet.chosen.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  kms_key_id        = var.kms_key_arn
  tags              = merge(var.tags, { Name = "${var.name}-data" })
}

resource "aws_volume_attachment" "data" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data[0].id
  instance_id = aws_instance.app.id
  # Stop the instance before detaching rather than force-detaching a mounted
  # filesystem under a running database.
  stop_instance_before_detaching = true
}
