variable "name" {
  description = "Name prefix for every resource this module creates."
  type        = string
}

variable "vpc_id" {
  description = "VPC to deploy into. Empty string means the account's default VPC."
  type        = string
  default     = ""
}

variable "instance_type" {
  description = "EC2 instance type. The docker-compose build happens on-instance, so anything below 2 GB RAM needs swap_gb > 0."
  type        = string
  default     = "t3.small"
}

variable "app_port" {
  description = "TCP port the app listens on. Used as the sole ingress port when ingress_ports is empty; otherwise informational (the app sits behind an on-box reverse proxy and is not reachable directly)."
  type        = number
}

variable "ingress_ports" {
  description = "TCP ports opened to ingress_cidrs. Empty (the default) means [app_port], preserving the pre-TLS behaviour. Set to [80, 443] when a reverse proxy on the instance terminates TLS — 443/udp is added automatically for HTTP/3 whenever 443 is present."
  type        = list(number)
  default     = []
}

variable "ingress_cidrs" {
  description = "CIDRs allowed to reach the ingress ports. Default is open — override for anything beyond throwaway dev stacks."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "source_bucket_name" {
  description = "Name of the S3 bucket this module creates for the source bundle."
  type        = string
}

variable "source_object_key" {
  description = "Object key of the source tarball the instance downloads on boot."
  type        = string
  default     = "source.tar.gz"
}

variable "enable_onbox_tls" {
  description = "When true, boot the compose stack with the `tls` profile and point its Caddy TLS terminator at an sslip.io hostname derived from this instance's public IPv4 (ADR-0029). Requires ingress_ports to include 80 and 443. Costs nothing — no ALB, no ACM."
  type        = bool
  default     = false
}

variable "assign_elastic_ip" {
  description = <<-EOT
    Allocate an Elastic IP and associate it with the instance, giving it a
    public IPv4 that SURVIVES a stop/start. Default false keeps the pre-existing
    behaviour (EC2's auto-assigned address, which changes on every power cycle).

    Turn this on for any stack that is scheduled off and on (see
    infra/modules/scheduled-power), or whose hostname/certificate is derived
    from its IP — with `enable_onbox_tls` both are true at once, because the
    sslip.io name literally encodes the address.

    Billing: AWS charges ~$0.005/hr for every public IPv4 whether idle or in
    use, so an EIP costs nothing extra while the instance runs; the only added
    charge is the hours it sits allocated to a STOPPED instance.

    One-time cutover cost: an instance that already has an auto-assigned address
    CANNOT keep it — AWS has no convert-to-EIP operation. Enabling this changes
    the public IP once, on the apply that adds it.
  EOT
  type        = bool
  default     = false
}

variable "swap_gb" {
  description = "Swapfile size in GB added before the build (0 disables)."
  type        = number
  default     = 4
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "ami_id" {
  description = <<-EOT
    PIN THE AMI. Leave null and the module resolves
    /aws/service/ami-amazon-linux-latest/... from SSM — which AWS re-points at
    every new Amazon Linux release, so `terraform plan` silently starts
    proposing "aws_instance.app must be replaced" with no change on our side.

    On this stack Postgres lives in a container volume ON the instance, so that
    replacement is TOTAL DATA LOSS. It is not a hypothetical: a plan on
    2026-08-01 proposed exactly that (ami-0b8dddb... -> ami-0006118...) purely
    because the upstream parameter had moved.

    So: pin it to the AMI the instance is actually running. Upgrading the image
    is then a DELIBERATE act — change this value only together with a data
    migration plan, never as a side effect of someone running plan.
  EOT
  type        = string
  default     = null
}

# --- ADR-0228 additions (all backwards-compatible except the two secure
# defaults called out below) ---------------------------------------------------

variable "ingress_enabled" {
  description = "Open ingress_ports (or app_port) to ingress_cidrs. Default false: the security group has no ingress rule at all, which is what SSM Session Manager and an outbound-only tunnel need (ADR-0180 secure by default, ADR-0228). A stack that serves traffic directly sets it to true."
  type        = bool
  default     = false
}

variable "boot_mode" {
  description = "\"bundle\" (the original behaviour: pull source.tar.gz, generate per-boot secrets, compose up) or \"host_only\" (prepare the host: Docker, the compose plugin, the encrypted data volume, container logs to CloudWatch; the operator deploys the stack through SSM)."
  type        = string
  default     = "bundle"
  validation {
    condition     = contains(["bundle", "host_only"], var.boot_mode)
    error_message = "boot_mode must be \"bundle\" or \"host_only\"."
  }
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the root volume, the data volume and the source bucket. Null uses the AWS-managed keys; the volumes are encrypted either way."
  type        = string
  default     = null
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size."
  type        = number
  default     = 20
}

variable "data_volume_size_gb" {
  description = "Size of a separate encrypted EBS data volume mounted at data_volume_mount. 0 (the default) creates none. host_only mode only."
  type        = number
  default     = 0
}

variable "data_volume_mount" {
  description = "Where the data volume is mounted. The default puts every Docker volume (Postgres included) on it."
  type        = string
  default     = "/var/lib/docker"
}

variable "log_group_name" {
  description = "CloudWatch log group the Docker daemon ships container logs to (awslogs driver), host_only mode. Empty keeps the default json-file driver. The caller grants the role write access."
  type        = string
  default     = ""
}

variable "imds_hop_limit" {
  description = "IMDSv2 PUT response hop limit. 1 (the default) means containers on a bridge network cannot reach the instance metadata service, so they cannot take the instance role's credentials."
  type        = number
  default     = 1
}

variable "compose_plugin_version" {
  description = "Docker Compose plugin release installed in host_only mode."
  type        = string
  default     = "v2.29.7"
}

variable "compose_plugin_sha256" {
  description = "SHA-256 of docker-compose-linux-x86_64 for compose_plugin_version, from the release's .sha256 file. host_only mode refuses to install a binary that does not match."
  type        = string
  default     = "383ce6698cd5d5bbf958d2c8489ed75094e34a77d340404d9f32c4ae9e12baf0"
}

variable "subnet_id" {
  description = "Subnet for the instance (and the data volume's AZ). Empty uses the first subnet of vpc_id. Set vpc_id too."
  type        = string
  default     = ""
}

variable "associate_public_ip_address" {
  description = "false gives the instance no public IPv4 (it then needs a NAT gateway for egress). null keeps the subnet's setting."
  type        = bool
  default     = null
}

variable "egress_rules" {
  description = "Security-group egress rules. The default is the original allow-all; ADR-0228's host passes 443/tcp and 7844/tcp+udp only."
  type = list(object({
    description = string
    from_port   = number
    to_port     = number
    protocol    = string
    cidr_blocks = list(string)
  }))
  default = [{ description = "all", from_port = 0, to_port = 0, protocol = "-1", cidr_blocks = ["0.0.0.0/0"] }]
}

variable "disable_api_termination" {
  description = "EC2 termination protection."
  type        = bool
  default     = false
}
