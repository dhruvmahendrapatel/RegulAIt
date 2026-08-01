output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  value = aws_instance.app.public_ip
}

output "source_bucket" {
  value = aws_s3_bucket.source.bucket
}

output "security_group_id" {
  value = aws_security_group.app.id
}

# sslip.io resolves a-b-c-d.sslip.io -> a.b.c.d, so this is the hostname the
# on-box Caddy holds a Let's Encrypt certificate for (ADR-0029). Empty when the
# instance has no public IPv4.
output "sslip_hostname" {
  value = aws_instance.app.public_ip == "" ? "" : "${replace(aws_instance.app.public_ip, ".", "-")}.sslip.io"
}
