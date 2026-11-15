#!/usr/bin/env bash
# Installs a pinned Terraform CLI after checking its SHA-256 against the value
# committed here (not against a checksum file fetched next to the binary).
# Usage: infra/scripts/install-terraform.sh [install-dir]   (default: $HOME/.local/bin)
set -euo pipefail

TF_VERSION="1.9.8"
TF_SHA256_LINUX_AMD64="186e0145f5e5f2eb97cbd785bc78f21bae4ef15119349f6ad4fa535b83b10df8"

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
