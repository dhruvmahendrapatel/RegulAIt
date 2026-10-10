#!/usr/bin/env bash
# I0 survey re-check from primary sources (the upstream git repositories, read anonymously).
# For each project: the newest release tag (version sort, pre-releases excluded), that tag's
# commit date, and the licence file at that tag. Nothing is built or executed.
# Usage: survey-recheck.sh <scratch_dir>   (prints a Markdown table; scratch clones are deleted)
set -u
SCRATCH=$1
mkdir -p "$SCRATCH"
echo "| Project | Newest release tag | Tag commit date | Licence named in the licence file at that tag |"
echo "|---|---|---|---|"
while read -r repo pattern licfile; do
  url="https://github.com/$repo"
  tag=$(git ls-remote --tags --refs "$url" 2>/dev/null | awk '{print $2}' | sed 's|refs/tags/||' \
        | grep -E "$pattern" | sort -V | tail -1)
  if [ -z "$tag" ]; then echo "| $repo | (git refused or no tag) | | |"; continue; fi
  dir="$SCRATCH/$(echo "$repo" | tr / _)"
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" fetch -q --depth 1 --filter=blob:none "$url" "refs/tags/$tag" 2>/dev/null
  date=$(git -C "$dir" log -1 --format=%cI FETCH_HEAD 2>/dev/null)
  text=$(git -C "$dir" show "FETCH_HEAD:$licfile" 2>/dev/null)
  lic=$(grep -m1 -oE 'Apache License|MIT License|BSD [0-9]-Clause|GNU [A-Z ]*General Public License|Mozilla Public License' <<<"$text")
  [ "$lic" = "Apache License" ] && grep -q 'Version 2.0, January 2004' <<<"$text" && lic="Apache License 2.0"
  grep -q 'LLVM Exceptions' <<<"$text" && lic="$lic + LLVM Exceptions"
  [ -z "$text" ] && lic="(licence file not readable)"
  echo "| $repo | \`$tag\` | $date | $licfile: $lic |"
  rm -rf "$dir"
done <<'EOF'
google/gvisor ^release-[0-9]+\.[0-9]+$ LICENSE
kata-containers/kata-containers ^[0-9]+\.[0-9]+\.[0-9]+$ LICENSE
firecracker-microvm/firecracker ^v[0-9]+\.[0-9]+\.[0-9]+$ LICENSE
google/nsjail ^[0-9]+(\.[0-9]+)*$ LICENSE
bytecodealliance/wasmtime ^v[0-9]+\.[0-9]+\.[0-9]+$ LICENSE
NVIDIA/OpenShell ^v[0-9]+\.[0-9]+\.[0-9]+$ LICENSE
landlock-lsm/go-landlock ^v[0-9]+\.[0-9]+\.[0-9]+$ LICENSE
kata-containers/kata-containers ^3\.[0-9]+\.[0-9]+$ LICENSE
EOF
