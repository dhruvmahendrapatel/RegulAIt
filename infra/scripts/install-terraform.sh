#!/usr/bin/env bash
# Installs a pinned Terraform CLI after checking its SHA-256 against the value
# committed here (not against a checksum file fetched next to the binary).
# Usage: infra/scripts/install-terraform.sh [install-dir]   (default: $HOME/.local/bin)
set -euo pipefail

TF_VERSION="1.16.7"
TF_SHA256_LINUX_AMD64="5454efcf7fc87f0c2113111b9a5c7182f0ca1c6f0f23a1e110a50770a8fe473b"

dest="${1:-$HOME/.local/bin}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/tf.zip" \
  "https://releases.hashicorp.com/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip"
echo "${TF_SHA256_LINUX_AMD64}  $tmp/tf.zip" | sha256sum -c -
unzip -q "$tmp/tf.zip" -d "$tmp"
mkdir -p "$dest"
install -m 0755 "$tmp/terraform" "$dest/terraform"
"$dest/terraform" version
