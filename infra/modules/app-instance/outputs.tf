output "instance_id" {
  value = aws_instance.app.id
}

# The address to actually use: the Elastic IP when assign_elastic_ip is set
# (stable across stop/start), otherwise the ephemeral auto-assigned address.
output "public_ip" {
  value = local.effective_public_ip
}

output "elastic_ip" {
  description = "The Elastic IP, or null when assign_elastic_ip is false."
  value       = var.assign_elastic_ip ? aws_eip.app[0].public_ip : null
}

output "public_ip_is_stable" {
  description = "True when the public IPv4 survives a stop/start. False means any IP-derived hostname or certificate breaks on every power cycle."
  value       = var.assign_elastic_ip
}

output "source_bucket" {
  value = aws_s3_bucket.source.bucket
}

output "security_group_id" {
  value = aws_security_group.app.id
}

# sslip.io resolves a-b-c-d.sslip.io -> a.b.c.d, so this is the hostname the
# on-box Caddy holds a Let's Encrypt certificate for (ADR-0029). Empty when the
# instance has no public IPv4. Only durable across a stop/start when
# assign_elastic_ip is true — see public_ip_is_stable.
output "sslip_hostname" {
  value = local.effective_public_ip == "" ? "" : "${replace(local.effective_public_ip, ".", "-")}.sslip.io"
}
