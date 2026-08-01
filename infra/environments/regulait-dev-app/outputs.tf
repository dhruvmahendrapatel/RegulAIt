# ADR-0029: the app is served over HTTPS at the sslip.io name derived from the
# instance's public IP. Plain http://<ip>:3000 no longer answers from off-box.
output "app_url" {
  value = "https://${module.app.sslip_hostname}"
}

output "tls_hostname" {
  value = module.app.sslip_hostname
}

output "public_ip" {
  value = module.app.public_ip
}

output "instance_id" {
  value = module.app.instance_id
}

output "source_bucket" {
  value = module.app.source_bucket
}
